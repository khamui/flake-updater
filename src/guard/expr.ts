/**
 * Applied to `nixosConfigurations.<host>` with `user` substituted: the guarded
 * parts of the evaluated config as JSON-able data. A TS string so it ships
 * with the build (pure eval can't import a file from outside the flake).
 */
export const GUARD_NIX = `user: sys0: let
  # The baseline is main + the new lock, which is broken exactly when the agent
  # had something to fix (e.g. an option upstream removed). Without the check,
  # definitions of options that no longer exist are ignored instead of making
  # every value fail; everything else still evaluates and is compared.
  sys = sys0.extendModules {modules = [{_module.check = false;}];};
  inherit (sys) config options;

  # Option trees can hold functions, derivations and throwing defaults.
  safe = depth: v: let
    r = builtins.tryEval v;
    x = r.value;
    t = builtins.typeOf x;
  in
    if !r.success then "<error>"
    else if t == "lambda" then "<function>"
    else if t == "path" then toString x
    else if t == "set" then
      (if x ? outPath then (let p = builtins.tryEval (builtins.unsafeDiscardStringContext (toString x)); in if p.success then p.value else "<drv>")
       else if depth <= 0 then "<...>"
       else builtins.mapAttrs (_: safe (depth - 1)) (removeAttrs x ["_module"]))
    else if t == "list" then (if depth <= 0 then "<...>" else map (safe (depth - 1)) x)
    else if t == "string" then builtins.unsafeDiscardStringContext x
    else x;

  # The file an option renders, read back (builds small text derivations).
  rendered = file: let
    r = builtins.tryEval (
      if file == null then null
      else if (file.text or null) != null then file.text
      else builtins.readFile file.source
    );
  in if r.success then (if r.value == null then null else builtins.unsafeDiscardStringContext r.value) else "<unreadable>";

  etc = config.environment.etc;
  etcFile = name: if etc ? \${name} && (etc.\${name}.enable or true) then etc.\${name} else null;

  hm = (config.home-manager.users or {}).\${user} or null;
  homeFile = name: if hm != null && hm.home.file ? \${name} && (hm.home.file.\${name}.enable or true) then hm.home.file.\${name} else null;

  # Shell, editor and tool init files, as rendered. Scanned for code-execution
  # and fetch flags, not compared whole: what the source text hides (string
  # concatenation, a file the text scan skips) shows here.
  initFile = n: builtins.match "(.*/)?[.]?(zshrc|zshenv|zprofile|zlogin|zinputrc|bashrc|bash_profile|profile|inputrc|tmux[.]conf|gitconfig)|(.*/)?(git/config|fish/config[.]fish|nvim/init[.](lua|vim))" n != null;
  scanFiles = prefix: show: files: get:
    builtins.listToAttrs (map (n: { name = "\${prefix}\${show n}"; value = rendered (get n); }) (builtins.filter (n: initFile (show n)) (builtins.attrNames files)));
  dropPrefix = p: s: let l = builtins.stringLength p; in if builtins.substring 0 l s == p then builtins.substring l (-1) s else s;
  # home.file names may be \`./.zshrc\` or absolute; show them as their path below ~.
  homeName = n: let
    t = builtins.tryEval (hm.home.file.\${n}.target or n);
    home = builtins.tryEval "\${hm.home.homeDirectory}/";
    p = if t.success then t.value else n;
  in dropPrefix "./" (if home.success then dropPrefix home.value p else p);
  readAny = v: let r = builtins.tryEval (if builtins.isString v then v else builtins.readFile v); in
    if r.success then builtins.unsafeDiscardStringContext r.value else "<unreadable>";
  nvfLua = cfg: let on = builtins.tryEval (cfg.programs.nvf.enable or false); in
    if on.success && on.value then readAny cfg.programs.nvf.finalPackage.passthru.initLua else null;
in {
  scan =
    scanFiles "/etc/" (n: n) etc etcFile
    // (if hm == null then {} else scanFiles "~/" homeName hm.home.file homeFile)
    // { "nvf:init.lua" = nvfLua config; "~/nvf:init.lua" = if hm == null then null else nvfLua hm; };

  "users.users" = builtins.mapAttrs (_: u: safe 5 (removeAttrs u ["packages"])) config.users.users;
  "users.groups" = safe 4 config.users.groups;
  "security" = safe 5 config.security;
  "services.openssh.enable" = safe 0 config.services.openssh.enable;
  "networking.firewall" = safe 4 config.networking.firewall;
  "networking.nameservers" = safe 1 config.networking.nameservers;
  "networking.wg-quick" = safe 5 config.networking.wg-quick;
  "systemd.services" = safe 1 (builtins.attrNames config.systemd.services);
  "systemd.timers" = safe 1 (builtins.attrNames config.systemd.timers);
  "systemd.user.services" = safe 1 (builtins.attrNames config.systemd.user.services);
  # Not all of boot.*: initrd systemd units hold derivations that can't be forced in isolation.
  # Every value goes through \`safe\`: options removed upstream throw when read.
  "boot" = let b = config.boot; i = b.initrd; in {
    loader = safe 4 b.loader;
    kernelParams = safe 2 b.kernelParams;
    kernelModules = safe 2 b.kernelModules;
    blacklistedKernelModules = safe 2 b.blacklistedKernelModules;
    extraModprobeConfig = safe 2 b.extraModprobeConfig;
    extraModulePackages = safe 1 b.extraModulePackages;
    sysctl = safe 2 b.kernel.sysctl;
    postBootCommands = safe 2 b.postBootCommands;
    binfmt = safe 3 (b.binfmt.registrations or {});
    initrd = {
      kernelModules = safe 2 i.kernelModules;
      availableKernelModules = safe 2 i.availableKernelModules;
      luks = safe 4 i.luks.devices;
      network = safe 4 i.network;
      secrets = safe 2 i.secrets;
      preLVMCommands = safe 2 i.preLVMCommands;
      postDeviceCommands = safe 2 i.postDeviceCommands;
      postMountCommands = safe 2 i.postMountCommands;
      systemd = { enable = safe 0 i.systemd.enable; services = safe 1 (builtins.attrNames i.systemd.services); };
    };
  };
  "boot.kernel" = safe 0 config.boot.kernelPackages.kernel;
  "environment.etc" = safe 1 (builtins.filter (n: etc.\${n}.enable or true) (builtins.attrNames etc));
  # Each snippet on its own. Not the aggregates: \`script\` concatenates all snippets
  # and \`etc\` installs the /etc tree (guarded by its keys and rendered files) —
  # both fail to evaluate on a broken baseline even when no snippet changed.
  "system.activationScripts" = safe 3 (builtins.mapAttrs (_: s: if builtins.isString s then s else safe 2 (s.text or s))
    (removeAttrs config.system.activationScripts ["script" "etc"]));
  "nixpkgs.overlays" = {
    count = safe 0 (builtins.length config.nixpkgs.overlays);
    files = safe 1 (map (d: d.file) options.nixpkgs.overlays.definitionsWithLocations);
  };

  # Rendered instead of the option tree, so pure renames pass.
  "rendered:/etc/nix/nix.conf" = rendered (etcFile "nix/nix.conf");
  "rendered:/etc/hosts" = rendered (etcFile "hosts");
  "rendered:/etc/ssh/sshd_config" = rendered (etcFile "ssh/sshd_config");
  "rendered:/etc/ssh/ssh_config" = rendered (etcFile "ssh/ssh_config");
  "rendered:/etc/ssh/ssh_known_hosts" = rendered (etcFile "ssh/ssh_known_hosts");
  "rendered:/etc/resolv.conf" = rendered (etcFile "resolv.conf");
  "rendered:/etc/sudoers" = rendered (etcFile "sudoers");
  "rendered:/etc/doas.conf" = rendered (etcFile "doas.conf");
  "rendered:~/.ssh/config" = rendered (homeFile ".ssh/config");

  "home.activation" = if hm == null then null else builtins.mapAttrs (_: e: safe 2 (e.data or e)) hm.home.activation;
  "home.systemd.user" = if hm == null then null else safe 6 hm.systemd.user;
}
`;
