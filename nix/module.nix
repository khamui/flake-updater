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
    inherit (cfg) repo host user mainBranch model escalationModel maxFixIterations diffLimit minFreeGB selfInput writeScope intervalDays idleMinutes idleFallbackHours extraSources;
  });

  # The update run, sandboxed (SPEC §7): started by hand, or by the timer with --if-due.
  agentService = {
    description,
    args,
  }: {
    inherit description;
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
      ExecStart = "${lib.getExe cfg.package} run --config ${agentConfig}${args}";
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

  reportHook = ''
    if [ "$USER" = ${lib.escapeShellArg cfg.user} ]; then
      __flake_agent_seen="''${XDG_STATE_HOME:-$HOME/.local/state}/flake-agent/report-seen"
      if [ ! -e "$__flake_agent_seen" ] || [ ${stateDir}/state.json -nt "$__flake_agent_seen" ] \
        || [ /var/lib/flake-agent-switch/last-switch.json -nt "$__flake_agent_seen" ]; then
        ${lib.getExe cfg.package} report --once 2>/dev/null
      fi
      unset __flake_agent_seen
    fi
  '';
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

    intervalDays = mkOption {
      type = types.ints.positive;
      default = 7;
      description = ''
        Days between runs, counted from the last one: a manual run
        (`flake-agent run`, retry) moves the next scheduled one. The timer
        checks hourly; `flake-agent status` shows the time left.
      '';
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
    # the user's own commands (revert) read the same config
    environment.etc."flake-agent/config.json".source = agentConfig;

    users.users.flake-agent = {
      isSystemUser = true;
      group = "flake-agent";
      home = stateDir;
      description = "flake-agent update runs";
    };
    users.groups.flake-agent = {};

    systemd.services.flake-agent = agentService {
      description = "flake-agent update run";
      args = "";
    };
    # the timer's unit: the same run, only when intervalDays have passed since the last cycle
    systemd.services.flake-agent-due = agentService {
      description = "flake-agent scheduled check";
      args = " --if-due";
    };

    # Root, no AI: re-runs the guard on the exact commit the agent asked for,
    # builds it and switches (or sets the boot entry). Idle gating comes with #12.
    systemd.services.flake-agent-switch = {
      description = "flake-agent switch (guard, build, activate)";
      path = [config.nix.package];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${lib.getExe cfg.package} switch --config ${agentConfig} --state-dir ${stateDir} --switch-state-dir /var/lib/flake-agent-switch --user-request-dir /run/flake-agent";
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
      # the agent's request, or the user's revert (`flake-agent revert`)
      pathConfig.PathExists = ["${stateDir}/switch-request.json" "/run/flake-agent/switch-request.json"];
    };

    # The latest report, once, in the first interactive shell after it (no dotfile edits).
    # Plain `test -nt` first: node only starts when a state file changed since the last look.
    programs.zsh.interactiveShellInit = reportHook;
    programs.bash.interactiveShellInit = reportHook;

    # The user reads agent and switch state (status, notifications, handoff).
    users.users.${cfg.user}.extraGroups = ["flake-agent"];

    # The helper publishes idle time and rollback requests here; revert its switch requests.
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

    # hourly: the run itself decides whether intervalDays have passed (a manual run moves the schedule)
    systemd.timers.flake-agent = {
      description = "flake-agent update schedule";
      wantedBy = ["timers.target"];
      timerConfig = {
        OnCalendar = "hourly";
        Persistent = true;
        RandomizedDelaySec = "5min";
        Unit = "flake-agent-due.service";
      };
    };
  };
}
