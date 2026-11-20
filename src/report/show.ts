import { capture, run } from "../nix/exec.js";
import { DEEP_PROBES } from "../probes/deep/index.js";
import type { Finding } from "../probes/t0.js";
import { diffT3, type T3Snapshot } from "../probes/t3.js";
import { parseLog, type ChangeCommit } from "../agent/trailers.js";

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

/** `flake-agent show <id>`: upstream reason, diff, affected behaviour, available alternative. */
export async function showChange(repo: string, id: string, host: string): Promise<string | undefined> {
  // the newest branch carrying this id
  const shas = (await git(repo, "log", "--all", "--format=%H", "-F", `--grep=Change-Id: ${id}`)).split("\n").filter(Boolean);
  if (shas.length === 0) return undefined;
  const tip = (await git(repo, "branch", "--all", "--format=%(refname)", "--sort=-committerdate", "--contains", shas[0]!)).split("\n")[0] || shas[0]!;
  const commits = await changeCommits(repo, id, tip);
  if (commits.length === 0) return undefined;
  const first = commits[0]!;
  const last = commits.at(-1)!;

  const out: string[] = [`${id} (${first.trailers["Change-Class"] ?? "unlabelled"}) on ${tip.replace(/^refs\/(heads|remotes)\//, "")}`, ""];
  out.push(first.subject, "", withoutTrailers(first.body));
  if (first.trailers.Upstream) out.push("", `Upstream: ${first.trailers.Upstream}`);

  const { before, after } = await snapshotsAround(repo, first.sha, last.sha, tip, host);
  out.push("", "Affected keymaps, aliases and language servers:");
  if (!before || !after) {
    out.push(`  (no ${before ? "snapshot after" : "earlier snapshot before"} this change to compare)`);
  } else {
    const findings = affectedBehaviour(before, after);
    out.push(...(findings.length ? findings.map((f) => `  ${f.kind} ${f.subject}${f.detail ? `: ${f.detail}` : ""}`) : ["  none"]));
  }

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
