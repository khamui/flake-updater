# VM test for activation and retention: `flake-agent activate` switches or sets
# the boot entry, and GC keeps the newest minGenerations system generations.
# Run: nix build .#tests.switch
{
  self,
  pkgs,
}:
pkgs.testers.runNixOSTest {
  name = "flake-agent-switch";

  nodes.machine = {pkgs, ...}: {
    imports = [self.nixosModules.default];
    virtualisation.memorySize = 2048;
    # activating the base system would install GRUB onto the virtual disk, which fails in the VM
    boot.loader.grub.enable = false;

    services.flake-agent = {
      enable = true;
      package = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      repo = "/home/alice/repo";
      user = "alice";
      tokenFile = "/etc/flake-agent-token";
    };
    users.users.alice.isNormalUser = true;

    nix.gc = {
      automatic = true;
      options = "--delete-older-than 7d";
    };

    # Candidate systems: one that only changes /etc, one with another kernel.
    specialisation.withEtc.configuration.environment.etc."flake-agent-test".text = "new";
    specialisation.newKernel.configuration.boot.kernelPackages = pkgs.linuxPackages_latest;
  };

  testScript = ''
    import json
    import shlex

    machine.wait_for_unit("multi-user.target")
    current = machine.succeed("readlink -f /run/current-system").strip()
    kernel = machine.succeed("readlink -f /run/current-system/kernel").strip()

    with subtest("a change without kernel/initrd/systemd changes is switched"):
        out = machine.succeed(f"flake-agent activate {current}/specialisation/withEtc")
        print(out)
        # test VMs boot without a system profile: the first activation creates generation 1
        assert "switch: generation none → 1" in out, out
        machine.succeed("grep -x new /etc/flake-agent-test")

    with subtest("a kernel change only sets the boot entry"):
        out = machine.succeed(f"flake-agent activate {current}/specialisation/newKernel")
        print(out)
        assert "boot: generation 1 → 2" in out, out
        assert machine.succeed("readlink -f /run/current-system/kernel").strip() == kernel
        assert machine.succeed("readlink -f /nix/var/nix/profiles/system/kernel").strip() != kernel

    with subtest("a failed post-switch check rolls back the agent's last live switch"):
        out = machine.succeed(f"flake-agent activate {current}")
        print(out)
        assert "switch: generation 2 → 3" in out, out
        machine.fail("test -e /etc/flake-agent-test")
        sha = "c" * 40
        record = {"at": "t", "commit": sha, "branch": "agent/x", "result": "switched", "mode": "switch", "from": 1, "to": 3}
        # as the switch service would have recorded it
        machine.succeed("mkdir -p /var/lib/flake-agent-switch")
        machine.succeed(f"echo {shlex.quote(json.dumps(record))} > /var/lib/flake-agent-switch/last-switch.json")

        def request_rollback(commit):
            req = shlex.quote(json.dumps({"commit": commit, "reason": "nvim-startup-error"}))
            machine.succeed(f"su alice -c {shlex.quote(f'echo {req} > /run/flake-agent/rollback-request.json')}")
            machine.wait_until_fails("test -e /run/flake-agent/rollback-request.json")

        # a request for another commit is refused
        request_rollback("d" * 40)
        machine.succeed("journalctl -u flake-agent-rollback | grep -F 'Rollback refused: request is for another commit'")
        assert machine.succeed("readlink /nix/var/nix/profiles/system").strip() == "system-3-link"

        # the helper's request for the switched commit rolls back
        request_rollback(sha)
        machine.wait_until_succeeds("journalctl -u flake-agent-rollback | grep -F 'Rolled back: generation 3 → 1'")
        assert machine.succeed("readlink /nix/var/nix/profiles/system").strip() == "system-1-link"
        machine.succeed("grep -x new /etc/flake-agent-test")
        machine.succeed("grep -F rolledBack /var/lib/flake-agent-switch/last-switch.json")

    with subtest("the user may start a run (Retry now), nothing else"):
        machine.succeed("su alice -c 'systemctl start --no-block flake-agent.service'")
        machine.fail("su alice -c 'systemctl start --no-block nix-gc.service'")
        machine.fail("su alice -c 'systemctl stop --no-block flake-agent.timer'")

    with subtest("GC with --delete-older-than 7d keeps 5 system generations"):
        machine.succeed("systemctl cat nix-gc.service | grep -o '/nix/store/[^ ]*-start' | head -1 | xargs cat | grep -F 'gc --delete-older-than 7d --keep-system 5'")
        for i in range(6):
            spec = 'withEtc' if i % 2 else 'newKernel'
            machine.succeed(f"nix-env -p /nix/var/nix/profiles/system --set $(readlink -f {current}/specialisation/{spec})")
        machine.succeed("touch -h -d '30 days ago' /nix/var/nix/profiles/system-*-link")
        before = machine.succeed("ls /nix/var/nix/profiles | grep '^system-.*-link$' | sort -V").split()
        machine.succeed("systemctl start nix-gc.service")
        after = machine.succeed("ls /nix/var/nix/profiles | grep '^system-.*-link$' | sort -V").split()
        print(before, after)
        assert len(before) > 5, before
        assert after == before[-5:], after
  '';
}
