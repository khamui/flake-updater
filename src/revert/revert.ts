import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture, run } from "../nix/exec.js";
import { DEEP_PROBES } from "../probes/deep/index.js";
import type { Finding } from "../probes/t0.js";
import { diffT3, type T3Snapshot } from "../probes/t3.js";
import { PREFERENCES } from "../guard/structure.js";
import { changeCommits, fileAt } from "../report/show.js";
import { buildSide, revertCommits, type BuildDeps } from "./sides.js";

const ID = /^[a-z0-9][a-z0-9.-]*$/;

export interface RevertDeps extends BuildDeps {
  out: (text: string) => void;
}

export interface RevertOptions {
  /** The user's repo: the revert branches off its main. */
  repo: string;
  mainBranch: string;
  host: string;
  id: string;
  /** Asked once the change is found: the PREFERENCES.md note to append, if any. */
  note?: (subject: string) => Promise<string | undefined>;
}

export interface RevertResult {
  branch: string;
  commit: string;
  /** main when the revert branched: the handoff fast-forwards only from here. */
  base: string;
  method: "keep-old" | "revert";
  /** The change's behaviour differences (main without it vs main), undone by the revert or not. */
  restored: Finding[];
  notRestored: Finding[];
  /** What the revert changed, per the probes: main vs the revert. */
  effect: Finding[];
  /** Why the probe comparison is partial. */
  caveat?: string;
  noted: boolean;
}

const key = (f: Finding) => `${f.kind} ${f.subject}`;

/**
 * Which of a change's behaviour differences (`before`: main without it →
 * `after`: main) the revert undid: a difference still present against
 * `before` (same kind and subject) is not restored.
 */
export function confirmRevert(before: T3Snapshot, after: T3Snapshot, reverted: T3Snapshot): { restored: Finding[]; notRestored: Finding[] } {
  const change = diffT3(before, after, DEEP_PROBES);
  const still = new Set(diffT3(before, reverted, DEEP_PROBES).map(key));
  return { restored: change.filter((f) => !still.has(key(f))), notRestored: change.filter((f) => still.has(key(f))) };
}

const line = (f: Finding) => `${key(f)}${f.detail ? `: ${f.detail}` : ""}`;

export function revertMessage(id: string, subject: string, how: string, r: Pick<RevertResult, "restored" | "effect" | "caveat">): string {
  const lines = [`Revert ${id}: ${subject}`, "", how];
  if (r.restored.length) lines.push("", "Restored, per the probes:", ...r.restored.map((f) => `- ${line(f)}`));
  if (r.effect.length) lines.push("", "Changed by the revert, per the probes:", ...r.effect.map((f) => `- ${line(f)}`));
  if (r.caveat) lines.push("", r.caveat);
  lines.push("", `Reverts: ${id}`);
  return lines.join("\n");
}

/**
 * `flake-agent revert <id>`, run by the user: on a new branch
 * `agent/revert-<id>` off main (in a scratch worktree, so the user's checkout
 * is untouched) apply the change's keep-old.patch, or `git revert` its commits
 * when there is none; commit, and append the user's note to PREFERENCES.md.
 * Whether it restores is decided from builds made now, on main's lock (ADR
 * 0002): main, main without the change's commits, and the revert.
 * Throws, leaving no branch behind, if it doesn't apply, build or restore.
 */
export async function prepareRevert(o: RevertOptions, deps: RevertDeps): Promise<RevertResult> {
  if (!ID.test(o.id)) throw new Error(`invalid change id: ${o.id}`);
  const git = (dir: string, ...args: string[]) => run("git", ["-c", "safe.directory=*", "-C", dir, ...args]).then((s) => s.trim());
  const base = await git(o.repo, "rev-parse", `refs/heads/${o.mainBranch}`);
  const commits = await changeCommits(o.repo, o.id, base);
  if (commits.length === 0) {
    if (o.id.startsWith("upstream-")) {
      throw new Error(`${o.id} is upstream-only: no commit of this config caused it, so there is nothing to revert yet (agent-prepared reverts: #37)`);
    }
    const elsewhere = await git(o.repo, "log", "--all", "-1", "--format=%H", "-F", `--grep=Change-Id: ${o.id}`);
    throw new Error(
      elsewhere
        ? `${o.id} is not on ${o.mainBranch}: merge agent/applied (or the run's branch) first`
        : `no change ${o.id} in ${o.repo}`,
    );
  }
  const first = commits[0]!;
  const patch = await fileAt(o.repo, base, `.flake-agent/changes/${o.id}/keep-old.patch`);
  const method = patch ? "keep-old" : "revert";
  const note = await o.note?.(first.subject);
  const shas = commits.map((c) => c.sha);

  let branch = `agent/revert-${o.id}`;
  for (let n = 2; (await capture("git", ["-C", o.repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0; n++) {
    branch = `agent/revert-${o.id}-${n}`;
  }
  const dir = await mkdtemp(join(tmpdir(), "flake-agent-revert-"));
  await rm(dir, { recursive: true });
  await git(o.repo, "worktree", "add", "-q", "-b", branch, dir, base);
  let done = false;
  try {
    let how: string;
    if (patch) {
      const file = join(dir, "..", `${branch.replace(/\//g, "-")}.patch`);
      await writeFile(file, patch);
      const applied = await capture("git", ["-C", dir, "apply", file]);
      await rm(file, { force: true });
      if (applied.code !== 0) throw new Error(`keep-old.patch no longer applies to ${o.mainBranch}: ${applied.stderr.trim()}`);
      how = `Applies .flake-agent/changes/${o.id}/keep-old.patch, the closest old behaviour.`;
    } else {
      const failed = await revertCommits(dir, shas);
      if (failed) throw new Error(failed);
      how = `Reverts ${[...shas].reverse().map((s) => s.slice(0, 12)).join(", ")}.`;
    }
    // flakes only see tracked files
    await git(dir, "add", "-A");

    deps.out(`Building ${branch}\n`);
    const built = await deps.build(dir);
    if (!built.ok || !built.toplevel) throw new Error(`the revert does not build:\n${built.error ?? ""}`);
    const reverted = await deps.snapshot(dir, built.toplevel);

    deps.out(`Building ${o.mainBranch}${patch ? ` and ${o.mainBranch} without ${o.id}` : ""}\n`);
    const main = await buildSide(o.repo, base, deps);
    if (!main.ok) throw new Error(`${o.mainBranch} ${main.error}`);
    // the change's differences: main without its commits vs main; the revert itself when it is exactly that
    const without = patch ? await buildSide(o.repo, base, deps, (d) => revertCommits(d, shas)) : ({ ok: true, toplevel: built.toplevel, t3: reverted } as const);
    let restored: Finding[] = [];
    let notRestored: Finding[] = [];
    let caveat: string | undefined;
    if (!without.ok) {
      caveat = `${o.mainBranch} without the change's commits: ${without.error.split("\n")[0]}; only the revert's own build was checked.`;
    } else {
      if (without.toplevel === main.toplevel) {
        throw new Error(`${o.mainBranch} builds the same system without ${o.id}: there is nothing to revert`);
      }
      ({ restored, notRestored } = confirmRevert(without.t3, main.t3, reverted));
      if (notRestored.length) {
        throw new Error(`the revert does not restore the old behaviour:\n${notRestored.map((f) => `  ${line(f)}`).join("\n")}`);
      }
    }
    const effect = diffT3(main.t3, reverted, DEEP_PROBES);

    await commitMessage(dir, revertMessage(o.id, first.subject, how, { restored, effect, caveat }));
    await git(dir, "add", ".flake-agent/snapshots");
    if ((await git(dir, "status", "--porcelain", ".flake-agent/snapshots")) !== "") {
      await commitMessage(dir, `snapshots: probes on the revert of ${o.id}`);
    }
    if (note) {
      const file = join(dir, PREFERENCES);
      const existing = await readFile(file, "utf8").catch(() => undefined);
      await appendFile(file, `${existing === undefined ? "# Preferences\n\n" : existing.endsWith("\n") ? "" : "\n"}${note.trim()}\n`);
      await git(dir, "add", PREFERENCES);
      await commitMessage(dir, `PREFERENCES.md: keep ${o.id} reverted`);
    }
    const commit = await git(dir, "rev-parse", "HEAD");
    done = true;
    return { branch, commit, base, method, restored, notRestored, effect, ...(caveat ? { caveat } : {}), noted: Boolean(note) };
  } finally {
    await git(o.repo, "worktree", "remove", "--force", dir).catch(() => undefined);
    if (!done) await git(o.repo, "branch", "-D", branch).catch(() => undefined);
  }
}

async function commitMessage(dir: string, message: string): Promise<void> {
  const r = await capture("git", ["-C", dir, "commit", "-q", "-F", "-"], { input: message });
  if (r.code !== 0) throw new Error(`git commit failed: ${r.stderr.trim()}`);
}
