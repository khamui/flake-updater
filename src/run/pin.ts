/** A flake reference to exactly what a lock node had locked, for `nix flake lock --override-input`. */
export function lockedRef(locked: Record<string, unknown> | undefined): string | undefined {
  if (!locked) return undefined;
  const s = (k: string) => (typeof locked[k] === "string" ? (locked[k] as string) : undefined);
  switch (s("type")) {
    case "github":
    case "gitlab":
    case "sourcehut":
      return s("owner") && s("repo") && s("rev") ? `${s("type")}:${s("owner")}/${s("repo")}/${s("rev")}` : undefined;
    case "git":
      return s("url") && s("rev") ? `git+${s("url")}?rev=${s("rev")}${s("ref") ? `&ref=${s("ref")}` : ""}` : undefined;
    case "tarball":
    case "file":
      return s("url");
    default:
      return undefined;
  }
}

type Lock = { root: string; nodes: Record<string, { inputs?: Record<string, unknown>; locked?: Record<string, unknown> }> };

/** What a root input was locked to in an older lock. */
export function previousRef(lockText: string, input: string): string | undefined {
  const lock = JSON.parse(lockText) as Lock;
  const node = lock.nodes[lock.root]?.inputs?.[input];
  return typeof node === "string" ? lockedRef(lock.nodes[node]?.locked) : undefined;
}
