# VM test for the module: user, units, timer, and the agent unit's sandbox.
# Run: nix build .#tests.module
{
  self,
  pkgs,
}:
pkgs.testers.runNixOSTest {
  name = "flake-agent-module";

  nodes.machine = {config, ...}: {
    imports = [self.nixosModules.default];
    virtualisation.memorySize = 2048;

    users.users.alice.isNormalUser = true;
    environment.systemPackages = [pkgs.git];

    services.flake-agent = {
      enable = true;
      package = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      repo = "/home/alice/repo";
      user = "alice";
      tokenFile = "/etc/flake-agent-token";
    };
    environment.etc."flake-agent-token".text = "sk-ant-oat01-not-a-real-token";

    # Same sandbox as the agent unit, running checks instead of the agent.
    systemd.services.sandbox-check = {
      path = [pkgs.git pkgs.coreutils];
      environment = {inherit (config.systemd.services.flake-agent.environment) HOME NIX_REMOTE;};
      serviceConfig =
        config.systemd.services.flake-agent.serviceConfig
        // {
          ExecStart = pkgs.writeShellScript "sandbox-check" ''
            exec > /var/lib/flake-agent/sandbox.log 2>&1
            echo "home: $(find /home -mindepth 1 | sort | tr '\n' ' ')"
            cat /home/alice/secret && echo "secret: readable" || echo "secret: hidden"
            git -c safe.directory='*' -C /home/alice/repo/.git log --format=%s -1 && echo "git: readable"
            touch /home/alice/repo/.git/agent-was-here && echo "git: writable" || echo "git: read-only"
            touch /var/lib/flake-agent/ok && echo "state: writable"
            touch /etc/x 2>/dev/null && echo "etc: writable" || echo "etc: read-only"
            /run/wrappers/bin/sudo -n true 2>/dev/null && echo "sudo: yes" || echo "sudo: no"
            echo "caps: $(grep CapBnd /proc/self/status)"
          '';
        };
    };
  };

  testScript = ''
    machine.wait_for_unit("multi-user.target")

    with subtest("user, units, timer"):
        machine.succeed("id flake-agent")
        machine.fail("id -nG flake-agent | grep -w wheel")
        machine.succeed("systemctl cat flake-agent.service | grep -F 'ProtectHome=tmpfs'")
        machine.succeed("systemctl cat flake-agent.timer | grep -F 'OnCalendar=weekly'")
        machine.succeed("systemctl cat flake-agent.timer | grep -F 'Persistent=true'")
        machine.succeed("systemctl list-timers --all | grep flake-agent.timer")

    machine.succeed(
        "su alice -c 'git init -q -b main ~/repo && git -C ~/repo -c user.name=a -c user.email=a@x commit -q --allow-empty -m init && echo s3cret > ~/secret'"
    )

    with subtest("sandbox"):
        machine.succeed("systemctl start sandbox-check")
        out = machine.succeed("cat /var/lib/flake-agent/sandbox.log")
        print(out)
        assert "home: /home/alice /home/alice/repo /home/alice/repo/.git" in out, out
        assert "secret: hidden" in out, out
        assert "init" in out and "git: readable" in out, out
        assert "git: read-only" in out, out
        assert "state: writable" in out, out
        assert "etc: read-only" in out, out
        assert "sudo: no" in out, out
        assert "CapBnd:\t0000000000000000" in out, out

    with subtest("a run stops at preflight"):
        machine.fail("systemctl start flake-agent.service")
        state = machine.succeed("cat /var/lib/flake-agent/state.json")
        print(state)
        assert '"pending"' in state, state
        machine.fail("test -e /var/lib/flake-agent/repo")
  '';
}
