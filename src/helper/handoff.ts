import { capture, run } from "../nix/exec.js";

export interface HandoffResult {
  /** `agent/applied` now points at the switched commit. */
  applied: boolean;
  fastForwarded: boolean;
  /** One line for the report. */
  note: string;
}

const APPLIED = "agent/applied";

const git = (repo: string, ...args: string[]) => run("git", ["-c", "safe.directory=*", "-C", repo, ...args]).then((s) => s.trim());

/**
 * Hand the switched commit to the user's repo: always as `agent/applied`;
 * `main` is fast-forwarded only if the working tree is clean and main hasn't
 * moved since the run branched (`runBase`).
 */
export async function handoff(opts: {
  repo: string;
  /** The switch service's repo, which holds the commit. */
  source: string;
  commit: string;
  /** The agent branch, as stored in the switch repo under refs/candidates/. */
  branch: string;
  runBase?: string;
  mainBranch: string;
}): Promise<HandoffResult> {
  await git(opts.repo, "fetch", "-q", opts.source, `refs/candidates/${opts.branch}`);
  await git(opts.repo, "cat-file", "-e", `${opts.commit}^{commit}`);
  const current = await git(opts.repo, "symbolic-ref", "--quiet", "--short", "HEAD").catch(() => "");
  if (current === APPLIED) {
    return { applied: false, fastForwarded: false, note: `${APPLIED} is checked out — not updated; fetch ${opts.commit.slice(0, 12)} by hand` };
  }
  await git(opts.repo, "branch", "-f", APPLIED, opts.commit);

  const main = await git(opts.repo, "rev-parse", `refs/heads/${opts.mainBranch}`);
  if (main === opts.commit) return { applied: true, fastForwarded: false, note: `${opts.mainBranch} already at ${opts.commit.slice(0, 12)}` };
  if (!opts.runBase || main !== opts.runBase) {
    return { applied: true, fastForwarded: false, note: `${opts.mainBranch} diverged — merge ${APPLIED} by hand` };
  }
  const dirty = (await git(opts.repo, "status", "--porcelain", "--untracked-files=no")) !== "";
  if (dirty) {
    return { applied: true, fastForwarded: false, note: `uncommitted changes in your repo — merge ${APPLIED} by hand` };
  }

  if (current === opts.mainBranch) {
    const r = await capture("git", ["-c", "safe.directory=*", "-C", opts.repo, "merge", "--ff-only", "-q", opts.commit]);
    if (r.code !== 0) return { applied: true, fastForwarded: false, note: `fast-forward failed — merge ${APPLIED} by hand` };
  } else {
    // not checked out: move the ref, but only if it is still where we saw it
    await git(opts.repo, "update-ref", `refs/heads/${opts.mainBranch}`, opts.commit, main);
  }
  return { applied: true, fastForwarded: true, note: `${opts.mainBranch} fast-forwarded to ${opts.commit.slice(0, 12)}` };
}
