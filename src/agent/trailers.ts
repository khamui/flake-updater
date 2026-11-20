/** Trailers every change commit carries (SPEC → Change handling). */
export const REQUIRED_TRAILERS = ["Change-Id", "Change-Class", "Upstream"];
export const CHANGE_CLASSES = ["mechanical", "behaviour", "review", "blocked"];

export interface ChangeCommit {
  sha: string;
  subject: string;
  /** The message after the subject line, trailers included. */
  body: string;
  trailers: Record<string, string>;
}

/** `git log --format=%H%x00%B%x01` → commits with their trailers. */
export function parseLog(log: string): ChangeCommit[] {
  return log
    .split("\x01")
    .map((entry) => entry.replace(/^\n+/, ""))
    .filter((entry) => entry.includes("\x00"))
    .map((entry) => {
      const [sha, body = ""] = entry.split("\x00");
      const trailers: Record<string, string> = {};
      // trailer paragraphs at the end; tools may append their own (Co-Authored-By) after a blank line
      for (const line of body.trim().split("\n").reverse()) {
        if (!line.trim()) continue;
        const m = /^([A-Za-z-]+):\s*(.+)$/.exec(line.trim());
        if (!m) break;
        trailers[m[1]!] ??= m[2]!.trim();
      }
      const [subject = "", ...rest] = body.trim().split("\n");
      return { sha: sha!.trim(), subject: subject.trim(), body: rest.join("\n").trim(), trailers };
    });
}

/** Snapshot commits are the run's own; every other commit is a change and needs its trailers. */
export function trailerProblems(commits: ChangeCommit[]): string[] {
  const problems: string[] = [];
  for (const c of commits) {
    if (c.subject.startsWith("snapshots: ")) continue;
    const missing = REQUIRED_TRAILERS.filter((t) => !c.trailers[t]);
    if (missing.length) problems.push(`${c.sha.slice(0, 12)} "${c.subject}": missing ${missing.join(", ")}`);
    else if (!CHANGE_CLASSES.includes(c.trailers["Change-Class"]!)) problems.push(`${c.sha.slice(0, 12)}: unknown Change-Class ${c.trailers["Change-Class"]}`);
  }
  return problems;
}
