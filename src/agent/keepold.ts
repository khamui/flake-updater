import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture, run } from "../nix/exec.js";

const ID = /^[a-z0-9][a-z0-9.-]*$/;

export const changeDir = (repo: string, id: string) => join(repo, ".flake-agent", "changes", id);

const git = (repo: string, ...args: string[]) => run("git", ["-c", "safe.directory=*", "-C", repo, ...args]).then((s) => s.trim());

/**
 * `flake-agent keep-old <id>`: the agent has edited the tree to the closest
 * old-behaviour version on top of its behaviour-change commit; save that diff
 * as `.flake-agent/changes/<id>/keep-old.patch` and restore the tree.
 */
export async function captureKeepOld(repo: string, id: string): Promise<string> {
  if (!ID.test(id)) throw new Error(`invalid change id: ${id}`);
  const patch = await run("git", ["-c", "safe.directory=*", "-C", repo, "diff", "HEAD", "--", ".", ":(exclude).flake-agent"]);
  if (!patch.trim()) throw new Error("no changes to the working tree: edit it to the old behaviour first");
  const files = (await git(repo, "diff", "--name-only", "HEAD", "--", ".", ":(exclude).flake-agent")).split("\n").filter(Boolean);
  const dir = changeDir(repo, id);
  await mkdir(dir, { recursive: true });
  const file = join(dir, "keep-old.patch");
  await writeFile(file, patch);
  await git(repo, "checkout", "HEAD", "--", ...files);
  return file;
}

/** Apply a keep-old patch to `commit` in a scratch worktree; the caller builds/probes it. */
export async function withPatched<T>(repo: string, commit: string, patch: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "flake-agent-keep-old-"));
  await rm(dir, { recursive: true });
  await git(repo, "worktree", "add", "--detach", "-q", dir, commit);
  try {
    const applied = await capture("git", ["-c", "safe.directory=*", "-C", dir, "apply", patch]);
    if (applied.code !== 0) throw new Error(`patch does not apply: ${applied.stderr.trim()}`);
    // flakes only see tracked files
    await git(dir, "add", "-A");
    return await fn(dir);
  } finally {
    await git(repo, "worktree", "remove", "--force", dir).catch(() => undefined);
  }
}
