/**
 * A guard block is handled once its changes are on the user's main: they
 * reviewed and merged them, maybe rebased or cherry-picked, so matched by
 * Change-Id rather than commit. Until then the panel shows rvw.
 */
import { parseLog } from "../agent/trailers.js";
import { run } from "../nix/exec.js";
import type { RunRecord } from "../run/update.js";
import type { SwitchRecord } from "../switch/switch.js";

/** What the guard held back: the run's review changes, else (a block for size or scope) all of them. */
export function heldIds(r: RunRecord): string[] {
  const changes = (r.changes ?? []).filter((c) => c.id);
  const review = changes.filter((c) => c.class === "review");
  return [...new Set((review.length ? review : changes).map((c) => c.id!))];
}

/** The switch of run `r` needed review, and every held change is in `onMain`. */
export function reviewHandled(r: RunRecord | undefined, rec: SwitchRecord | undefined, onMain: Set<string>): boolean {
  if (!r || rec?.result !== "needs-review" || rec.commit !== r.commit) return false;
  const ids = heldIds(r);
  return ids.length > 0 && ids.every((id) => onMain.has(id));
}

/** Which of `ids` a commit on `ref` carries as its Change-Id trailer. */
export async function idsOn(repo: string, ref: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const grep = ids.map((id) => `--grep=Change-Id: ${id}`);
  const log = await run("git", ["-c", "safe.directory=*", "-C", repo, "log", "--format=%H%x00%B%x01", "-F", ...grep, ref]);
  const wanted = new Set(ids);
  return new Set(parseLog(log).map((c) => c.trailers["Change-Id"]).filter((id): id is string => !!id && wanted.has(id)));
}

/** For the CLI: is the last switch's review handled in the user's repo? Any failure (no repo, no git): no. */
export async function reviewHandledIn(repo: { repo: string; mainBranch: string } | undefined, r: RunRecord | undefined, rec: SwitchRecord | undefined): Promise<boolean> {
  if (!repo || !r || rec?.result !== "needs-review") return false;
  try {
    return reviewHandled(r, rec, await idsOn(repo.repo, repo.mainBranch, heldIds(r)));
  } catch {
    return false;
  }
}
