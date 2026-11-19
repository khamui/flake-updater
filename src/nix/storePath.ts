const STORE_NAME = /^\/nix\/store\/[0-9a-z]{32}-([^/]+)/;

/** The name part of a store path: `/nix/store/<hash>-foo-1.2/bin/x` → `foo-1.2`. */
export function storeName(path: string): string | undefined {
  return STORE_NAME.exec(path)?.[1];
}

/** The store path itself, without any sub-path. */
export function storeRoot(path: string): string | undefined {
  return STORE_NAME.exec(path)?.[0];
}

/**
 * Same rule as `builtins.parseDrvName`: the version starts after the first
 * dash that is followed by a non-letter.
 */
export function parseDrvName(name: string): { pname: string; version: string } {
  for (let i = 0; i < name.length - 1; i++) {
    if (name[i] === "-" && !/[a-zA-Z]/.test(name[i + 1]!)) {
      return { pname: name.slice(0, i), version: name.slice(i + 1) };
    }
  }
  return { pname: name, version: "" };
}
