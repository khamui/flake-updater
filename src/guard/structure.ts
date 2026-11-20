import { bindingText, containsSeq, startsWith } from "./nixscan.js";

/** Per-host overrides of the write-scope denylist (globs, repo-relative). */
export interface WriteScope {
  allow: string[];
  deny: string[];
}

export const DEFAULT_DENY = ["**/hardware-configuration.nix", ".flake-agent/PREFERENCES.md"];
export const DEFAULT_DIFF_LIMIT = 60;
export const DEFAULT_SELF_INPUT = "flake-updater";

/** One file of the agent's diff; null = absent on that side. */
export interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
}

/** Minimal glob: `**` spans directories, `*` and `?` stay within one. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const matchesAny = (path: string, globs: string[]) => globs.some((g) => globToRegExp(g).test(path));

const SERVICE_BLOCK = containsSeq(["services", "flake-agent"]);

/**
 * Edits outside the agent's write scope. `hook` is the agent's PreToolUse
 * context, where flake.lock may not be edited at all (only `nix flake update`
 * writes it); the guard checks the lock's integrity separately instead.
 */
export function writeScopeViolations(
  changes: FileChange[],
  scope: Partial<WriteScope> = {},
  context: "guard" | "hook" = "guard",
): string[] {
  const deny = [...DEFAULT_DENY, ...(scope.deny ?? [])];
  const allow = scope.allow ?? [];
  const reasons: string[] = [];

  for (const { path, before, after } of changes) {
    if (matchesAny(path, deny) && !matchesAny(path, allow)) {
      reasons.push(`write-scope: ${path} may not be edited`);
      continue;
    }
    if (path === "flake.lock" && context === "hook") {
      reasons.push("write-scope: flake.lock is only written by `nix flake update`");
      continue;
    }
    if (!path.endsWith(".nix")) continue;
    if (path === "flake.nix" && bindingText(before ?? "", startsWith(["inputs"])) !== bindingText(after ?? "", startsWith(["inputs"]))) {
      reasons.push("write-scope: flake.nix inputs block changed");
    }
    if (bindingText(before ?? "", SERVICE_BLOCK) !== bindingText(after ?? "", SERVICE_BLOCK)) {
      reasons.push(`write-scope: services.flake-agent config changed in ${path}`);
    }
  }
  return reasons;
}

type LockNode = { inputs?: Record<string, string | string[]>; locked?: Record<string, unknown>; original?: Record<string, unknown> };
type Lock = { version: number; root: string; nodes: Record<string, LockNode> };

/** Keys of `original` that `locked` must keep: where the input comes from, not which revision. */
const SOURCE_KEYS = ["type", "owner", "repo", "url", "host", "dir", "path"];

const json = (v: unknown) => JSON.stringify(v ?? null);

/**
 * The lock may only change the way `nix flake update` changes it: same root
 * inputs, each with the same `original` (or `follows`), every node still
 * locked to the source its `original` names, and the self input untouched.
 */
export function lockViolations(beforeText: string, afterText: string, selfInput = DEFAULT_SELF_INPUT): string[] {
  const reasons: string[] = [];
  let before: Lock;
  let after: Lock;
  try {
    before = JSON.parse(beforeText) as Lock;
    after = JSON.parse(afterText) as Lock;
  } catch {
    return ["lock: flake.lock is not valid JSON"];
  }
  if (before.version !== after.version) reasons.push(`lock: version ${before.version} → ${after.version}`);

  const rootInputs = (lock: Lock) => lock.nodes[lock.root]?.inputs ?? {};
  const resolve = (lock: Lock, ref: string | string[]) => (typeof ref === "string" ? lock.nodes[ref] : undefined);
  const [oldRoot, newRoot] = [rootInputs(before), rootInputs(after)];

  for (const name of Object.keys(newRoot)) {
    if (!(name in oldRoot)) reasons.push(`lock: new top-level input ${name}`);
  }
  for (const [name, oldRef] of Object.entries(oldRoot)) {
    const newRef = newRoot[name];
    if (newRef === undefined) {
      reasons.push(`lock: top-level input ${name} removed`);
      continue;
    }
    if (Array.isArray(oldRef) || Array.isArray(newRef)) {
      if (json(oldRef) !== json(newRef)) reasons.push(`lock: ${name} follows ${json(oldRef)} → ${json(newRef)}`);
      continue;
    }
    const [oldNode, newNode] = [resolve(before, oldRef), resolve(after, newRef)];
    if (json(oldNode?.original) !== json(newNode?.original)) {
      reasons.push(`lock: original of ${name} changed: ${json(oldNode?.original)} → ${json(newNode?.original)}`);
    }
    if (name === selfInput && json(oldNode?.locked) !== json(newNode?.locked)) {
      reasons.push(`lock: self input ${name} changed (only updated by hand)`);
    }
  }

  for (const [id, node] of Object.entries(after.nodes)) {
    if (!node.original || !node.locked) continue;
    for (const key of SOURCE_KEYS) {
      const want = node.original[key];
      const got = node.locked[key];
      if (want !== undefined && String(want).toLowerCase() !== String(got).toLowerCase()) {
        reasons.push(`lock: node ${id} locked ${key}=${json(got)} but original says ${json(want)}`);
      }
    }
  }
  return reasons;
}

/** Paths that don't count towards the diff limit: the lock, and records nothing evaluates (snapshots, CHANGES.md, keep-old patches and notes). */
export function countsTowardsLimit(path: string): boolean {
  return path !== "flake.lock" && path !== ".flake-agent/CHANGES.md" && !path.startsWith(".flake-agent/snapshots/") && !/^\.flake-agent\/changes\/[^/]+\/(keep-old\.patch|notes\.md)$/.test(path);
}

/** From `git diff --numstat`: added + deleted lines, excluding the lock and snapshots. */
export function changedLines(numstat: string): number {
  let total = 0;
  for (const line of numstat.split("\n")) {
    const [added, deleted, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (!path || !countsTowardsLimit(path)) continue;
    // binary files show as "-"
    total += (Number(added) || 0) + (Number(deleted) || 0);
  }
  return total;
}

export function diffSizeViolations(numstat: string, limit = DEFAULT_DIFF_LIMIT): string[] {
  const lines = changedLines(numstat);
  return lines > limit ? [`diff-size: ${lines} changed lines > ${limit}`] : [];
}
