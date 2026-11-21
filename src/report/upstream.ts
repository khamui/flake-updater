/** An upstream-only finding with its Change-Id (SPEC: upstream-only changes). */
export interface UpstreamFinding {
  id: string;
  /** The probe finding, `<kind> <subject>[: <detail>]`. */
  finding: string;
}

const MAX_SLUG = 60;

function slug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, MAX_SLUG).replace(/-+$/, "");
}

/**
 * Ids for a run's upstream-only findings: kind and subject (not the detail,
 * which holds versions) plus the run's month. Derived, not stored: the same
 * findings of the same run always get the same ids. Findings sharing kind and
 * subject (several stderr lines of one program) are numbered in order.
 */
export function upstreamFindings(lines: string[], at: string): UpstreamFinding[] {
  const month = at.slice(0, 7);
  const seen = new Map<string, number>();
  return lines.filter(Boolean).map((line) => {
    const finding = line.replace(/^- /, "");
    // `- <kind> <subject>: <detail>`; subjects may hold spaces or a colon without one (`home:kha/…`)
    const base = `upstream-${slug(finding.split(": ")[0]!)}-${month}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { id: n === 1 ? base : `${base}-${n}`, finding };
  });
}

/** Where a run records an upstream-only finding, for `show` (not scanned or counted by the guard). */
export const upstreamNotesPath = (id: string) => `.flake-agent/changes/${id}/notes.md`;

export function upstreamNotes(f: UpstreamFinding, run: { at: string; branch?: string; updatedInputs?: string[] }): string {
  return [
    `# ${f.id}`,
    "",
    "Upstream-only: the new lock alone changed this; the config and the agent's edits don't explain it.",
    "",
    `Finding: ${f.finding}`,
    `Run: ${run.branch ?? "run"} (${run.at.slice(0, 10)}), inputs: ${(run.updatedInputs ?? []).join(", ") || "none"}`,
    "",
  ].join("\n");
}
