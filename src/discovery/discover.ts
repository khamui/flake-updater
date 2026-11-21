import { run } from "../nix/exec.js";
import { parseDrvName } from "../nix/storePath.js";

export type PackageSource = "system" | "user" | "home";

export interface DeclaredPackage {
  source: PackageSource;
  name: string;
  pname: string;
  version: string;
  outPath: string;
}

export interface Target {
  /** Flake reference of the config repo, e.g. a path. */
  flake: string;
  /** `nixosConfigurations.<host>` attribute name. */
  host: string;
  /** User whose `users.users` and home-manager packages are included. */
  user: string;
}

const USER_NAME = /^[a-z_][a-z0-9_-]*$/;
const HOST_NAME = /^[A-Za-z0-9_-]+$/;

/** Nix function applied to the host's `config`; lists declared packages per source. */
export function discoveryExpr(user: string): string {
  if (!USER_NAME.test(user)) throw new Error(`invalid user name: ${user}`);
  return `config: let
    info = source: p: {
      inherit source;
      name = p.name or "";
      # not outPath: an attrset with that key serialises to a plain string
      path = builtins.unsafeDiscardStringContext (toString p);
    };
    hm = config.home-manager.users or {};
  in (map (info "system") config.environment.systemPackages)
    ++ (map (info "user") (config.users.users."${user}".packages or []))
    ++ (if hm ? "${user}" then map (info "home") hm."${user}".home.packages else [])`;
}

/** Flake ref of the host configuration, or of `attr` inside it. */
export function configAttr(target: Target, attr = ""): string {
  if (!HOST_NAME.test(target.host)) throw new Error(`invalid host name: ${target.host}`);
  return `${target.flake}#nixosConfigurations.${target.host}${attr ? `.${attr}` : ""}`;
}

export function parseDiscovery(json: string): DeclaredPackage[] {
  const raw = JSON.parse(json) as { source: PackageSource; name: string; path: string }[];
  return raw.map(({ source, name, path }) => ({ source, name, ...parseDrvName(name), outPath: path }));
}

/** Packages the host config declares, read from the evaluated config. */
export async function discoverPackages(target: Target): Promise<DeclaredPackage[]> {
  const json = await run("nix", [
    "eval",
    "--json",
    configAttr(target, "config"),
    "--apply",
    discoveryExpr(target.user),
  ]);
  return parseDiscovery(json);
}

/**
 * Nix function applied to the host's `config`: enabled `programs.*` in NixOS
 * and HM, each with its package's `meta.mainProgram` (null without one).
 */
export function programsExpr(user: string): string {
  if (!USER_NAME.test(user)) throw new Error(`invalid user name: ${user}`);
  return `config: let
    enabled = set: builtins.listToAttrs (builtins.concatMap (n: let
      cfg = set.\${n} or {};
      main = builtins.tryEval (let p = cfg.package or null; in
        if builtins.isAttrs p && p ? meta && p.meta ? mainProgram && builtins.isString p.meta.mainProgram then p.meta.mainProgram else null);
    in if (builtins.tryEval (cfg.enable or false)).value == true then [{ name = n; value = if main.success then main.value else null; }] else [])
      (builtins.attrNames set));
    hm = config.home-manager.users or {};
  in {
    nixos = enabled config.programs;
    home = if hm ? "${user}" then enabled hm."${user}".programs else {};
  }`;
}

/** Programs enabled in the host config (NixOS or home-manager) → their obvious binary, if any. */
export async function discoverEnabled(target: Target): Promise<Map<string, string | null>> {
  const json = await run("nix", ["eval", "--json", configAttr(target, "config"), "--apply", programsExpr(target.user)]);
  const { nixos, home } = JSON.parse(json) as { nixos: Record<string, string | null>; home: Record<string, string | null> };
  const out = new Map<string, string | null>(Object.entries(nixos));
  for (const [name, main] of Object.entries(home)) out.set(name, main ?? out.get(name) ?? null);
  return out;
}

/** Programs enabled in the host config (NixOS or home-manager). */
export async function discoverPrograms(target: Target): Promise<Set<string>> {
  return new Set((await discoverEnabled(target)).keys());
}
