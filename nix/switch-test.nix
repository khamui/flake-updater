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
