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

export function configAttr(target: Target, attr: string): string {
  if (!HOST_NAME.test(target.host)) throw new Error(`invalid host name: ${target.host}`);
  return `${target.flake}#nixosConfigurations.${target.host}.${attr}`;
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
