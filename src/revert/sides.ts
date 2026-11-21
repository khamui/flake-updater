import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture, run } from "../nix/exec.js";
import type { T3Snapshot } from "../probes/t3.js";

/** Building and probing a tree: the CLI's nix build and snapshot pass, faked in tests. */
export interface BuildDeps {
  /** Build the tree's system. */
  build: (dir: string) => Promise<{ ok: boolean; toplevel?: string; error?: string }>;
  /** Snapshot the built system into the tree's snapshot dir; its T3 part. */
  snapshot: (dir: string, toplevel: string) => Promise<T3Snapshot>;
}

export type Side = { ok: true; toplevel: string; t3: T3Snapshot } | { ok: false; error: string };

/** `git revert --no-commit` of `shas` (oldest first) in `dir`; the first line of git's error if it doesn't apply. */
export async function revertCommits(dir: string, shas: string[]): Promise<string | undefined> {
  const r = await capture("git", ["-c", "safe.directory=*", "-C", dir, "revert", "--no-commit", ...[...shas].reverse()]);
  return r.code === 0 ? undefined : `git revert failed: ${r.stderr.trim().split("\n")[0]}`;
}

/**
 * One side of a comparison (ADR 0002): `rev` of `repo`, with `edit` applied,
 * built and probed now in a scratch clone (the repo may be the agent's: only read).
 */
export async function buildSide(repo: string, rev: string, deps: BuildDeps, edit?: (dir: string) => Promise<string | undefined>): Promise<Side> {
  const dir = join(await mkdtemp(join(tmpdir(), "flake-agent-side-")), "repo");
  const git = (...args: string[]) => run("git", ["-c", "safe.directory=*", "-C", dir, ...args]);
  try {
    await run("git", ["-c", "safe.directory=*", "clone", "-q", "--shared", "--no-checkout", repo, dir]);
    await git("checkout", "-q", "--detach", rev);
    const failed = await edit?.(dir);
    if (failed) return { ok: false, error: failed };
    // flakes only see tracked files
    await git("add", "-A");
    const built = await deps.build(dir);
    if (!built.ok || !built.toplevel) return { ok: false, error: `does not build: ${(built.error ?? "").trim().split("\n").at(-1)}\n${built.error ?? ""}` };
    return { ok: true, toplevel: built.toplevel, t3: await deps.snapshot(dir, built.toplevel) };
  } finally {
    await rm(join(dir, ".."), { recursive: true, force: true });
  }
}
