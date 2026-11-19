/**
 * Applied to `nixosConfigurations.<host>` with `user` substituted: the guarded
 * parts of the evaluated config as JSON-able data. A TS string so it ships
 * with the build (pure eval can't import a file from outside the flake).
 */
export const GUARD_NIX = `user: sys: let
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
in {
  "users.users" = builtins.mapAttrs (_: u: safe 5 (removeAttrs u ["packages"])) config.users.users;
  "users.groups" = safe 4 config.users.groups;
  "security" = safe 5 config.security;
  "services.openssh.enable" = config.services.openssh.enable;
  "networking.firewall" = safe 4 config.networking.firewall;
  "networking.nameservers" = config.networking.nameservers;
  "networking.wg-quick" = safe 5 config.networking.wg-quick;
  "systemd.services" = builtins.attrNames config.systemd.services;
  "systemd.timers" = builtins.attrNames config.systemd.timers;
  "systemd.user.services" = builtins.attrNames config.systemd.user.services;
  # Not all of boot.*: initrd systemd units hold derivations that can't be forced in isolation.
  "boot" = let b = config.boot; i = b.initrd; in {
    loader = safe 4 b.loader;
    kernelParams = b.kernelParams;
    kernelModules = b.kernelModules;
    blacklistedKernelModules = b.blacklistedKernelModules;
    extraModprobeConfig = b.extraModprobeConfig;
    extraModulePackages = safe 1 b.extraModulePackages;
    sysctl = safe 2 b.kernel.sysctl;
    postBootCommands = b.postBootCommands;
    binfmt = safe 3 (b.binfmt.registrations or {});
    initrd = {
      kernelModules = i.kernelModules;
      availableKernelModules = i.availableKernelModules;
      luks = safe 4 i.luks.devices;
      network = safe 4 i.network;
      secrets = safe 2 i.secrets;
      preLVMCommands = i.preLVMCommands;
      postDeviceCommands = i.postDeviceCommands;
      postMountCommands = i.postMountCommands;
      systemd = { enable = i.systemd.enable; services = builtins.attrNames i.systemd.services; };
    };
  };
  "boot.kernel" = safe 0 config.boot.kernelPackages.kernel;
  "environment.etc" = builtins.filter (n: etc.\${n}.enable or true) (builtins.attrNames etc);
  "system.activationScripts" = builtins.mapAttrs (_: s: if builtins.isString s then s else safe 2 (s.text or s)) config.system.activationScripts;
  "nixpkgs.overlays" = {
    count = builtins.length config.nixpkgs.overlays;
    files = map (d: d.file) options.nixpkgs.overlays.definitionsWithLocations;
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
