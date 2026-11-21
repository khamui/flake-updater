import { capture, run } from "../nix/exec.js";
import { DEEP_PROBES } from "../probes/deep/index.js";
import type { Finding } from "../probes/t0.js";
import { diffT3, type T3Snapshot } from "../probes/t3.js";
import { parseLog, type ChangeCommit } from "../agent/trailers.js";
import { upstreamNotesPath } from "./upstream.js";
import { buildSide, revertCommits, type BuildDeps } from "../revert/sides.js";

/** Deep-probe findings a user notices at the keyboard: keymaps, aliases, bindings, language servers. */
const INTERACTIVE = /keymap|alias|binding|prefix|lsp/;

export function affectedBehaviour(old: T3Snapshot, next: T3Snapshot): Finding[] {
  return diffT3(old, next, DEEP_PROBES).filter((f) => INTERACTIVE.test(f.kind));
}

/**
 * The body without its trailers: everything from the paragraph holding
 * Change-Id on (tools append their own after it), else trailing trailer-only paragraphs.
 */
export function withoutTrailers(body: string): string {
  const paragraphs = body.trim().split(/\n\s*\n/);
  const ours = paragraphs.findLastIndex((p) => /^Change-Id:/m.test(p));
  if (ours >= 0) return paragraphs.slice(0, ours).join("\n\n");
  while (paragraphs.length && paragraphs.at(-1)!.split("\n").every((l) => /^[A-Za-z-]+:\s*\S/.test(l.trim()))) paragraphs.pop();
  return paragraphs.join("\n\n");
}

const git = (repo: string, ...args: string[]) => run("git", ["-c", "safe.directory=*", "-C", repo, ...args]);

export async function fileAt(repo: string, rev: string, path: string): Promise<string | undefined> {
  const r = await capture("git", ["-c", "safe.directory=*", "-C", repo, "show", `${rev}:${path}`]);
  return r.code === 0 ? r.stdout : undefined;
}

/**
 * The T3 snapshots around a change: the one in the tree just before its first
 * commit, and the first one committed after its last commit (snapshots are
 * committed after each build + probe pass, so that is the earliest capture that
 * includes the change). `beforeAt`/`afterAt`: the commits that wrote them.
 */
export async function snapshotsAround(repo: string, first: string, last: string, tip: string, host: string) {
  const path = `.flake-agent/snapshots/${host}/t3.json`;
  const before = await fileAt(repo, `${first}^`, path);
  const beforeAt = (await git(repo, "log", "-1", "--format=%H", `${first}^`, "--", path)).trim();
  const after = (await git(repo, "log", "--reverse", "--format=%H", `${last}..${tip}`, "--", path)).split("\n").filter(Boolean)[0];
  return {
    before: before ? (JSON.parse(before) as T3Snapshot) : undefined,
    after: after ? (JSON.parse((await fileAt(repo, after, path))!) as T3Snapshot) : undefined,
    beforeAt,
    afterAt: after,
  };
}

/** The commits carrying Change-Id `id` on `tip`, oldest first. */
export async function changeCommits(repo: string, id: string, tip: string): Promise<ChangeCommit[]> {
  const onTip = new Set((await git(repo, "rev-list", tip)).split("\n"));
  return parseLog(await git(repo, "log", "--reverse", "--format=%H%x00%B%x01", "-F", `--grep=Change-Id: ${id}`, tip)).filter(
    (c) => onTip.has(c.sha) && c.trailers["Change-Id"] === id,
  );
}

/** An upstream-only finding: no commit carries its id, the run recorded it in notes. */
async function showUpstream(repo: string, id: string): Promise<string | undefined> {
  const path = upstreamNotesPath(id);
  const sha = (await git(repo, "log", "--all", "-1", "--format=%H", "--", path)).trim();
  const notes = sha ? await fileAt(repo, sha, path) : undefined;
  if (!notes) return undefined;
  return [
    `${id} (upstream-only)`,
    "",
    notes.trim(),
    "",
    "Alternative:",
    `  flake-agent revert ${id} asks the agent to write the old behaviour explicitly (a removed package: keep an input back)`,
  ].join("\n") + "\n";
}

/**
 * The change's affected behaviour: the branch's tip built now with and without
 * the change's commits (ADR 0002); the run's snapshots, labelled as history,
 * when that can't be built (or `deps` is absent).
 */
async function affected(repo: string, tip: string, commits: ChangeCommit[], host: string, deps?: BuildDeps): Promise<string[]> {
  const list = (findings: Finding[]) =>
    findings.length ? findings.map((f) => `  ${f.kind} ${f.subject}${f.detail ? `: ${f.detail}` : ""}`) : ["  none"];
  let why = "not built";
  if (deps) {
    const sha = (await git(repo, "rev-parse", tip)).trim();
    const withIt = await buildSide(repo, sha, deps);
    const without = withIt.ok ? await buildSide(repo, sha, deps, (d) => revertCommits(d, commits.map((c) => c.sha))) : withIt;
    if (withIt.ok && without.ok) return [`Affected keymaps, aliases and language servers (${sha.slice(0, 12)} built with and without it):`, ...list(affectedBehaviour(without.t3, withIt.t3))];
    why = (withIt.ok ? `without it: ${without.ok ? "" : without.error}` : withIt.error).split("\n")[0]!;
  }
  const { before, after } = await snapshotsAround(repo, commits[0]!.sha, commits.at(-1)!.sha, tip, host);
  const out = [`Affected keymaps, aliases and language servers (history: the run's snapshots, ${why}; they may miss later edits or include upstream changes):`];
  if (!before || !after) out.push(`  (no ${before ? "snapshot after" : "earlier snapshot before"} this change to compare)`);
  else out.push(...list(affectedBehaviour(before, after)));
  return out;
}

/** `flake-agent show <id>`: upstream reason, diff, affected behaviour, available alternative. */
export async function showChange(repo: string, id: string, host: string, deps?: BuildDeps): Promise<string | undefined> {
  // the newest branch carrying this id
  const shas = (await git(repo, "log", "--all", "--format=%H", "-F", `--grep=Change-Id: ${id}`)).split("\n").filter(Boolean);
  if (shas.length === 0) return showUpstream(repo, id);
  const tip = (await git(repo, "branch", "--all", "--format=%(refname)", "--sort=-committerdate", "--contains", shas[0]!)).split("\n")[0] || shas[0]!;
  const commits = await changeCommits(repo, id, tip);
  if (commits.length === 0) return undefined;
  const first = commits[0]!;
  const last = commits.at(-1)!;

  const out: string[] = [`${id} (${first.trailers["Change-Class"] ?? "unlabelled"}) on ${tip.replace(/^refs\/(heads|remotes)\//, "")}`, ""];
  out.push(first.subject, "", withoutTrailers(first.body));
  if (first.trailers.Upstream) out.push("", `Upstream: ${first.trailers.Upstream}`);

  out.push("", ...(await affected(repo, tip, commits, host, deps)));

  const notes = await fileAt(repo, last.sha, `.flake-agent/changes/${id}/notes.md`);
  const patch = await fileAt(repo, last.sha, `.flake-agent/changes/${id}/keep-old.patch`);
  if (notes) out.push("", notes.trim());
  out.push("", "Alternative:");
  out.push(
    patch
      ? `  flake-agent revert ${id} applies .flake-agent/changes/${id}/keep-old.patch (the closest old behaviour)`
      : first.trailers["Change-Class"] === "mechanical"
        ? "  none needed: no behaviour change"
        : `  flake-agent revert ${id} reverts the commit${commits.length > 1 ? "s" : ""}`,
  );

  for (const c of commits.filter((c) => !c.subject.startsWith("snapshots: "))) {
    out.push("", `--- ${c.sha.slice(0, 12)} ${c.subject}`);
    out.push((await git(repo, "show", "--format=", "--stat", "--patch", c.sha, "--", ".", ":(exclude).flake-agent/snapshots")).trimEnd());
  }
  return out.join("\n") + "\n";
}
