import { createHash } from "node:crypto";
import { run } from "../nix/exec.js";
import type { Store } from "../nix/store.js";
import { homeGeneration } from "../nix/system.js";
import type { Finding } from "./t0.js";

/** Per-user profiles under /etc are package environments; T0 covers them. */
const SKIP_ETC = new Set(["profiles"]);

export interface GeneratedFile {
  /** Content hash; for a linked directory, a hash over its whole tree. */
  hash: string;
  /** Resolved store path, used to produce content diffs. */
  path: string;
}

export interface T1Snapshot {
  tier: "T1";
  /** `etc/<target>` or `home:<user>/<target>` → file. */
  files: Record<string, GeneratedFile>;
}

export interface T1Change extends Finding {
  severity: "info";
  kind: "file-added" | "file-removed" | "file-changed";
  /** Unified diff for changed files, empty otherwise. */
  detail: string;
}

/** Produces a content diff of two store paths (files or directories). */
export type Differ = (oldPath: string, newPath: string) => Promise<string>;

const MAX_DIFF_LINES = 200;

/** `diff -ru`, capped: a linked package directory (e.g. terminfo) can differ in thousands of files. */
export const unifiedDiff: Differ = async (oldPath, newPath) => {
  // 1 = differences, 2 = trouble (e.g. dangling links inside a tree); keep what diff printed
  const lines = (await run("diff", ["-ru", oldPath, newPath], [1, 2])).split("\n");
  if (lines.length <= MAX_DIFF_LINES) return lines.join("\n");
  return [...lines.slice(0, MAX_DIFF_LINES), `… ${lines.length - MAX_DIFF_LINES} more lines`].join("\n");
};

/** One step of an update run: the lock commit (no `changeId`) or an agent commit. */
export interface T1Step {
  changeId?: string;
  snapshot: T1Snapshot;
}

export type Attribution = { source: "agent"; changeIds: string[] } | { source: "upstream" };

export interface AttributedChange extends T1Change {
  attribution: Attribution;
}

/** Snapshot every generated config file of a system toplevel (live or built). */
export async function snapshotT1(store: Store, toplevel: string, user: string): Promise<T1Snapshot> {
  const files: T1Snapshot["files"] = {};

  const etc = await store.resolve(`${toplevel}/etc`);
  await walkGenerated(store, etc, "etc", files, SKIP_ETC);

  const gen = await homeGeneration(store, toplevel, user);
  if (gen) await walkGenerated(store, await store.resolve(`${gen}/home-files`), `home:${user}`, files);

  return { tier: "T1", files: sortKeys(files) };
}

/**
 * Generated trees (the etc derivation, HM home-files) are real directories with
 * a symlink or copied file at each target; every such leaf is one entry.
 */
async function walkGenerated(
  store: Store,
  dir: string,
  prefix: string,
  into: T1Snapshot["files"],
  skip: Set<string> = new Set(),
): Promise<void> {
  for (const name of (await store.list(dir)).sort()) {
    if (skip.has(name)) continue;
    const path = `${dir}/${name}`;
    const key = `${prefix}/${name}`;
    if ((await store.kind(path)) === "dir") {
      await walkGenerated(store, path, key, into);
    } else {
      const target = await store.resolve(path);
      into[key] = { hash: await contentHash(store, target), path: target };
    }
  }
}

async function contentHash(store: Store, path: string, depth = 0): Promise<string> {
  const kind = await store.kind(path);
  if (kind === "file") return sha256(withoutStoreHashes(await store.read(path)));
  if (kind === "missing" || depth > 32) return sha256(`dangling:${path}`);

  // directory (symlinks inside it are followed): hash the sorted listing
  const lines: string[] = [];
  for (const name of (await store.list(path)).sort()) {
    lines.push(`${name}\0${await contentHash(store, await store.resolve(`${path}/${name}`), depth + 1)}`);
  }
  return sha256(lines.join("\n"));
}

/** Old vs new generated files. T1 never fails: every change is informational. */
export async function diffT1(old: T1Snapshot, next: T1Snapshot, differ: Differ = unifiedDiff): Promise<T1Change[]> {
  const changes: T1Change[] = [];
  for (const [key, file] of Object.entries(old.files)) {
    const now = next.files[key];
    if (!now) {
      changes.push({ severity: "info", kind: "file-removed", subject: key, detail: "" });
    } else if (now.hash !== file.hash) {
      changes.push({ severity: "info", kind: "file-changed", subject: key, detail: await differ(file.path, now.path) });
    }
  }
  for (const key of Object.keys(next.files)) {
    if (!old.files[key]) changes.push({ severity: "info", kind: "file-added", subject: key, detail: "" });
  }
  return changes;
}

/**
 * Attribute each change between `old` and the last step to the agent commits
 * whose step touched that file; changes only the lock step made are upstream-only.
 */
export async function attributeT1(
  old: T1Snapshot,
  steps: T1Step[],
  differ: Differ = unifiedDiff,
): Promise<AttributedChange[]> {
  const last = steps.at(-1);
  if (!last) return [];

  const touchedBy = new Map<string, string[]>();
  let prev = old;
  for (const step of steps) {
    if (step.changeId) {
      for (const key of changedKeys(prev, step.snapshot)) {
        touchedBy.set(key, [...(touchedBy.get(key) ?? []), step.changeId]);
      }
    }
    prev = step.snapshot;
  }

  return (await diffT1(old, last.snapshot, differ)).map((change) => {
    const changeIds = touchedBy.get(change.subject);
    return {
      ...change,
      attribution: changeIds ? { source: "agent", changeIds } : { source: "upstream" },
    };
  });
}

function changedKeys(a: T1Snapshot, b: T1Snapshot): string[] {
  const keys = new Set([...Object.keys(a.files), ...Object.keys(b.files)]);
  return [...keys].filter((k) => a.files[k]?.hash !== b.files[k]?.hash);
}

const STORE_HASH = /\/nix\/store\/[0-9a-z]{32}-/g;

/**
 * References to rebuilt store paths (e.g. the HM generation in its activation
 * unit) change on every dependency bump; T0 covers packages, so T1 compares
 * content with `/nix/store/<hash>-name` reduced to `/nix/store/name`.
 */
function withoutStoreHashes(data: Buffer): string {
  return data.toString("latin1").replace(STORE_HASH, "/nix/store/");
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}
