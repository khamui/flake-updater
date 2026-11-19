import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configAttr } from "../discovery/discover.js";
import { run } from "../nix/exec.js";
import { GUARD_NIX } from "./expr.js";
import { diffSizeViolations, lockViolations, writeScopeViolations, type FileChange, type WriteScope } from "./structure.js";

export type Guarded = Record<string, unknown>;

export interface GuardResult {
  verdict: "pass" | "block";
  reasons: string[];
  /** Baseline commit: where the agent branch left main. */
  base: string;
  rev: string;
}

export interface GuardOptions {
  repo: string;
  host: string;
  user: string;
  rev: string;
  /** Branch the agent branched from (default `main`). */
  mainRef?: string;
  writeScope?: Partial<WriteScope>;
  diffLimit?: number;
  /** Input name of flake-updater itself (default `flake-updater`). */
  selfInput?: string;
}

const MAX_REASONS = 50;
const MAX_VALUE = 200;

/**
 * The flake source's own store path differs between the two trees (their
 * content differs), so paths into it (e.g. overlay definition files) are
 * compared relative to it.
 */
const SOURCE_PATH = /\/nix\/store\/[0-9a-z]{32}-source\//g;

/**
 * Aggregates whose path changes whenever anything inside them does (e.g. the
 * etc tree after an HM-only edit, referenced by the `etc` activation script).
 * Their contents are guarded on their own (etc keys, rendered files, unit names).
 */
const AGGREGATE_PATH =
  /\/nix\/store\/[0-9a-z]{32}-(etc|system-units|user-units|system-path|home-manager-generation|home-manager-files|home-manager-path)(?=[/\s"']|$)/g;

function normalise(value: unknown): unknown {
  if (typeof value === "string") return value.replace(SOURCE_PATH, "<source>/").replace(AGGREGATE_PATH, "/nix/store/<$1>");
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalise(v)]));
  }
  return value;
}

function show(value: unknown): string {
  const text = value === undefined ? "(absent)" : JSON.stringify(value);
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}…` : text;
}

function isPrimitive(v: unknown): boolean {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function diffValue(path: string, a: unknown, b: unknown, out: string[]): void {
  if (JSON.stringify(a) === JSON.stringify(b)) return;

  // rendered files and scripts: report the lines that differ
  if (typeof a === "string" && typeof b === "string" && (a.includes("\n") || b.includes("\n"))) {
    const before = new Set(a.split("\n"));
    const after = new Set(b.split("\n"));
    const removed = [...before].filter((l) => !after.has(l) && l.trim());
    const added = [...after].filter((l) => !before.has(l) && l.trim());
    for (const l of removed) out.push(`${path}: - ${l.trim()}`);
    for (const l of added) out.push(`${path}: + ${l.trim()}`);
    if (!removed.length && !added.length) out.push(`${path}: lines reordered`);
    return;
  }

  // lists of names, keys, …: report membership changes
  if (Array.isArray(a) && Array.isArray(b) && [...a, ...b].every(isPrimitive)) {
    const before = new Set(a.map((x) => JSON.stringify(x)));
    const after = new Set(b.map((x) => JSON.stringify(x)));
    const removed = [...before].filter((x) => !after.has(x));
    const added = [...after].filter((x) => !before.has(x));
    for (const x of removed) out.push(`${path}: removed ${x}`);
    for (const x of added) out.push(`${path}: added ${x}`);
    if (!removed.length && !added.length) out.push(`${path}: order changed`);
    return;
  }

  if (isObject(a) && isObject(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      diffValue(`${path}.${key}`, a[key], b[key], out);
    }
    return;
  }

  out.push(`${path}: ${show(a)} → ${show(b)}`);
}

/** Reasons to block: every difference in a guarded value between baseline and agent side. */
export function compareGuarded(baseline: Guarded, agent: Guarded): string[] {
  const a = normalise(baseline) as Guarded;
  const b = normalise(agent) as Guarded;
  const reasons: string[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    diffValue(key, a[key], b[key], reasons);
  }
  if (reasons.length <= MAX_REASONS) return reasons;
  return [...reasons.slice(0, MAX_REASONS), `… ${reasons.length - MAX_REASONS} more`];
}

export function guardApply(user: string): string {
  if (!/^[a-z_][a-z0-9_-]*$/.test(user)) throw new Error(`invalid user name: ${user}`);
  return `(${GUARD_NIX}) "${user}"`;
}

/** Evaluate the guarded values of `host` in a flake checked out at `dir`. */
export async function evalGuarded(dir: string, host: string, user: string): Promise<Guarded> {
  const json = await run("nix", [
    "eval",
    "--json",
    configAttr({ flake: `path:${dir}`, host, user }),
    "--apply",
    guardApply(user),
  ]);
  return JSON.parse(json) as Guarded;
}

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await run("git", ["-C", repo, ...args])).trim();
}

/** Extract `rev`'s tree into `dir` (no .git: evaluated as a `path:` flake). */
async function checkout(repo: string, rev: string, dir: string): Promise<void> {
  const tar = join(dir, "..", `${rev}.tar`);
  await git(repo, "archive", "--format=tar", "-o", tar, rev);
  await run("tar", ["-xf", tar, "-C", dir]);
  await rm(tar);
}

/** Content of `path` at `rev`, or null if it doesn't exist there. */
async function fileAt(repo: string, rev: string, path: string): Promise<string | null> {
  try {
    return await run("git", ["-C", repo, "show", `${rev}:${path}`]);
  } catch {
    return null;
  }
}

/** Write scope, inputs block, lock integrity and diff size of base..rev. */
export async function structuralReasons(opts: GuardOptions, base: string, rev: string): Promise<string[]> {
  const names = (await run("git", ["-C", opts.repo, "diff", "--no-renames", "--name-only", "-z", base, rev])).split("\0").filter(Boolean);
  const changes: FileChange[] = await Promise.all(
    names.map(async (path) => ({ path, before: await fileAt(opts.repo, base, path), after: await fileAt(opts.repo, rev, path) })),
  );
  const reasons = writeScopeViolations(changes, opts.writeScope);

  const lock = changes.find((c) => c.path === "flake.lock");
  if (lock) reasons.push(...lockViolations(lock.before ?? "{}", lock.after ?? "{}", opts.selfInput));

  const numstat = await run("git", ["-C", opts.repo, "diff", "--no-renames", "--numstat", base, rev]);
  reasons.push(...diffSizeViolations(numstat, opts.diffLimit));
  return reasons;
}

/**
 * Compare (baseline + new lock) with (agent rev): structure of the diff, then
 * the guarded options. The baseline is where the agent branch left main, so
 * edits of mine — before the branch point on both sides, after it on neither —
 * never trigger; and both sides share the rev's lock, so upstream changes don't either.
 */
export async function runGuard(opts: GuardOptions): Promise<GuardResult> {
  const rev = await git(opts.repo, "rev-parse", "--verify", `${opts.rev}^{commit}`);
  const base = await git(opts.repo, "merge-base", opts.mainRef ?? "main", rev);
  const reasons = await structuralReasons(opts, base, rev);

  const work = await mkdtemp(join(tmpdir(), "flake-agent-guard-"));
  try {
    const [baseDir, revDir] = [join(work, "base"), join(work, "rev")];
    await Promise.all([mkdir(baseDir), mkdir(revDir)]);
    await checkout(opts.repo, base, baseDir);
    await checkout(opts.repo, rev, revDir);
    await writeFile(join(baseDir, "flake.lock"), await run("git", ["-C", opts.repo, "show", `${rev}:flake.lock`]));

    try {
      const [baseline, agent] = await Promise.all([
        evalGuarded(baseDir, opts.host, opts.user),
        evalGuarded(revDir, opts.host, opts.user),
      ]);
      reasons.push(...compareGuarded(baseline, agent));
    } catch (err) {
      // what can't be evaluated can't be checked
      reasons.push(`eval: ${(err as Error).message.split("\n").slice(-3).join(" ").slice(0, 300)}`);
    }
    return { verdict: reasons.length ? "block" : "pass", reasons, base, rev };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
