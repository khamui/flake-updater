# services.flake-agent: the unprivileged, sandboxed update run (agent side).
# The root switch service and the user helper are separate units (#11, #12).
self: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.services.flake-agent;
  inherit (lib) mkEnableOption mkIf mkOption types;

  stateDir = "/var/lib/flake-agent";

  agentConfig = pkgs.writeText "flake-agent.json" (builtins.toJSON {
    inherit (cfg) repo host user mainBranch model escalationModel maxFixIterations diffLimit minFreeGB selfInput writeScope idleMinutes idleFallbackHours;
  });
in {
  options.services.flake-agent = {
    enable = mkEnableOption "the unattended flake update agent";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "flake-updater.packages.\${system}.default";
      description = "The flake-agent package.";
    };

    repo = mkOption {
      type = types.str;
      example = "/home/khamui/Repos/nixos-config";
      description = "The config repo. Only its `.git` is visible to the agent, read-only.";
    };

    host = mkOption {
      type = types.str;
      default = config.networking.hostName;
      defaultText = lib.literalExpression "config.networking.hostName";
      description = "`nixosConfigurations.<host>` to build.";
    };

    user = mkOption {
      type = types.str;
      description = "User whose home-manager config is probed and who gets notified.";
    };

    mainBranch = mkOption {
      type = types.str;
      default = "main";
      description = "Branch the agent branches from.";
    };

    schedule = mkOption {
      type = types.str;
      default = "weekly";
      description = "systemd OnCalendar expression for the run.";
    };

    model = mkOption {
      type = types.str;
      default = "claude-sonnet-5-5";
      description = "Model for preflight and the fix loop.";
    };

    escalationModel = mkOption {
      type = types.str;
      default = "claude-opus-5-5";
      description = "Model for the last fix iteration.";
    };

    maxFixIterations = mkOption {
      type = types.ints.positive;
      default = 3;
    };

    diffLimit = mkOption {
      type = types.ints.positive;
      default = 60;
      description = "Max changed lines of the agent's diff (excluding flake.lock and snapshots).";
    };

    idleMinutes = mkOption {
      type = types.ints.positive;
      default = 15;
    };

    idleFallbackHours = mkOption {
      type = types.ints.positive;
      default = 24;
    };

    minGenerations = mkOption {
      type = types.ints.positive;
      default = 5;
    };

    minFreeGB = mkOption {
      type = types.ints.positive;
      default = 10;
      description = "Free space needed on /nix before a run starts.";
    };

    selfInput = mkOption {
      type = types.str;
      default = "flake-updater";
      description = "Name of this tool's own flake input; never updated by the agent.";
    };

    writeScope = {
      allow = mkOption {
        type = types.listOf types.str;
        default = [];
        description = "Globs exempt from the default write-scope denylist.";
      };
      deny = mkOption {
        type = types.listOf types.str;
        default = [];
        description = "Additional globs the agent may not edit.";
      };
    };

    extraSources = mkOption {
      type = types.listOf types.str;
      default = [];
      description = "Additional domains the agent may fetch from.";
    };

    tokenFile = mkOption {
      type = types.str;
      example = "/etc/flake-agent/claude-token";
      description = ''
        File holding the subscription token from `claude setup-token`; root-owned,
        outside the Nix store and the repo. Passed via `LoadCredential=`.
      '';
    };

    timeout = mkOption {
      type = types.str;
      default = "60min";
      description = "A run is cancelled after this long.";
    };
  };

  config = mkIf cfg.enable {
    # the CLI: status, retry, skip, probe, …
    environment.systemPackages = [cfg.package];

    users.users.flake-agent = {
      isSystemUser = true;
      group = "flake-agent";
      home = stateDir;
      description = "flake-agent update runs";
    };
    users.groups.flake-agent = {};

    systemd.services.flake-agent = {
      description = "flake-agent update run";
      after = ["network-online.target"];
      wants = ["network-online.target"];
      unitConfig.ConditionACPower = true;
      path = [config.nix.package];
      environment = {
        HOME = stateDir;
        # nix builds through the daemon; the agent user has no store of its own
        NIX_REMOTE = "daemon";
      };
      serviceConfig = {
        Type = "oneshot";
        User = "flake-agent";
        Group = "flake-agent";
        ExecStart = "${lib.getExe cfg.package} run --config ${agentConfig}";
        TimeoutStartSec = cfg.timeout;
        StateDirectory = "flake-agent";
        # readable by the flake-agent group (the user): state, report, clone
        StateDirectoryMode = "0750";
        WorkingDirectory = stateDir;
        LoadCredential = "claude-token:${cfg.tokenFile}";

        # sandbox (SPEC §7); ProtectHome=tmpfs is ProtectHome=true that still allows the .git bind
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = "tmpfs";
        BindReadOnlyPaths = ["${cfg.repo}/.git"];
        ReadWritePaths = [stateDir];
        PrivateTmp = true;
        PrivateDevices = true;
        CapabilityBoundingSet = "";
        RestrictSUIDSGID = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        LockPersonality = true;
      };
    };

    # Root, no AI: re-runs the guard on the exact commit the agent asked for,
    # builds it and switches (or sets the boot entry). Idle gating comes with #12.
    systemd.services.flake-agent-switch = {
      description = "flake-agent switch (guard, build, activate)";
      path = [config.nix.package];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${lib.getExe cfg.package} switch --config ${agentConfig} --state-dir ${stateDir} --switch-state-dir /var/lib/flake-agent-switch";
        Group = "flake-agent";
        StateDirectory = "flake-agent-switch";
        StateDirectoryMode = "0750";
        # waits up to idleFallbackHours for the user to be idle, then builds and switches
        TimeoutStartSec = "${toString (cfg.idleFallbackHours + 2)}h";
      };
    };

    systemd.paths.flake-agent-switch = {
      description = "flake-agent switch request";
      wantedBy = ["paths.target"];
      pathConfig.PathExists = "${stateDir}/switch-request.json";
    };

    # The user reads agent and switch state (status, notifications, handoff).
    users.users.${cfg.user}.extraGroups = ["flake-agent"];

    # The helper publishes idle time and rollback requests here.
    systemd.tmpfiles.rules = ["d /run/flake-agent 0755 ${cfg.user} flake-agent -"];

    # Root: undoes the agent's last live switch when the helper's post-switch check fails.
    systemd.services.flake-agent-rollback = {
      description = "flake-agent rollback after a failed post-switch check";
      path = [config.nix.package];
      serviceConfig = {
        Type = "oneshot";
        Group = "flake-agent";
        ExecStart = "${lib.getExe cfg.package} rollback";
      };
    };
    systemd.paths.flake-agent-rollback = {
      wantedBy = ["paths.target"];
      pathConfig.PathExists = "/run/flake-agent/rollback-request.json";
    };

    # In the user's session: idle time, notifications, post-switch check, handoff.
    systemd.user.services.flake-agent-helper = {
      description = "flake-agent user helper";
      wantedBy = ["graphical-session.target"];
      partOf = ["graphical-session.target"];
      unitConfig.ConditionUser = cfg.user;
      path = [pkgs.xprintidle pkgs.libnotify pkgs.git config.nix.package];
      serviceConfig = {
        ExecStart = "${lib.getExe cfg.package} helper --config ${agentConfig}";
        Restart = "always";
        RestartSec = 30;
      };
    };

    # "Retry now": the user may start a run, nothing else.
    security.polkit.enable = lib.mkDefault true;
    security.polkit.extraConfig = ''
      polkit.addRule(function (action, subject) {
        if (action.id == "org.freedesktop.systemd1.manage-units" &&
            action.lookup("unit") == "flake-agent.service" &&
            action.lookup("verb") == "start" &&
            subject.user == "${cfg.user}") {
          return polkit.Result.YES;
        }
      });
    '';

    # Retention: GC never deletes the newest minGenerations system generations.
    systemd.services.nix-gc = mkIf config.nix.gc.automatic {
      path = [config.nix.package];
      script = lib.mkForce "exec ${lib.getExe cfg.package} gc ${config.nix.gc.options} --keep-system ${toString cfg.minGenerations}";
    };
    boot.loader.systemd-boot.configurationLimit = lib.mkDefault 10;

    systemd.timers.flake-agent = {
      description = "flake-agent update schedule";
      wantedBy = ["timers.target"];
      timerConfig = {
        OnCalendar = cfg.schedule;
        Persistent = true;
        RandomizedDelaySec = "15min";
      };
    };
  };
}
