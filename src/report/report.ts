import type { RunState } from "../preflight/state.js";
import type { RunRecord } from "../run/update.js";
import type { SwitchRecord } from "../switch/switch.js";

/** The retry/skip choice after a failed preflight or an interrupted run. */
export const CHOICE = "Retry now: `flake-agent retry`   Next cycle (default): `flake-agent skip`";

/** The user's view of one run's change commits: one line per Change-Id. */
export interface ChangeLine {
  mark: "⚠" | "✓" | "⛔" | "⏸";
  id: string;
  text: string;
}

const MARKS: Record<string, ChangeLine["mark"]> = { behaviour: "⚠", mechanical: "✓", review: "⛔", blocked: "⏸" };

/** First commit per Change-Id (a behaviour change's keep-old commit shares its id). */
export function changeLines(run: RunRecord): ChangeLine[] {
  const seen = new Set<string>();
  const lines: ChangeLine[] = [];
  for (const c of run.changes ?? []) {
    if (!c.id || seen.has(c.id)) continue;
    seen.add(c.id);
    const mark = MARKS[c.class ?? ""] ?? "⛔";
    lines.push({ mark, id: c.id, text: mark === "⛔" ? `needs review: ${c.subject}` : c.subject });
  }
  return lines;
}

/** Upstream-only findings, capped: they are often a long list of removed binaries. */
function upstreamLines(run: RunRecord, max = 5): string[] {
  const all = (run.behaviourChanges ?? []).map((l) => l.replace(/^- /, ""));
  if (all.length === 0) return [];
  const shown = all.slice(0, max).map((l) => `  ⚠ upstream: ${l}`);
  if (all.length > max) shown.push(`  … ${all.length - max} more upstream changes: flake-agent status`);
  return shown;
}

function body(run: RunRecord): string[] {
  const lines = changeLines(run);
  const width = Math.max(0, ...lines.map((l) => l.id.length));
  const out = lines.map((l) => `  ${l.mark} ${l.id.padEnd(width)}  ${l.text}`);
  out.push(...upstreamLines(run));
  const behaviour = lines.find((l) => l.mark === "⚠");
  if (behaviour) {
    out.push("", `  Details:  flake-agent show ${behaviour.id}`, `  Undo:     flake-agent revert ${behaviour.id}`);
  }
  return out;
}

const day = (iso: string) => iso.slice(0, 10);

function summaryLine(run: RunRecord): string {
  const configChanges = changeLines(run).filter((l) => l.mark !== "⏸").length;
  const parts = [`inputs: ${(run.updatedInputs ?? []).join(", ") || "none"}`, `${configChanges} config change${configChanges === 1 ? "" : "s"}`];
  if (run.pinned?.length) parts.push(`kept back: ${run.pinned.join(", ")}`);
  return parts.join(", ");
}

/** The report for a switch the switch service recorded for this run. */
function switchReport(run: RunRecord | undefined, rec: SwitchRecord, handoffNote?: string): string {
  const head = (() => {
    const when = day(rec.at);
    if (rec.rolledBack) return `Update rolled back (${when}): ${rec.rolledBack.reason}\nGeneration ${rec.to} → ${rec.from}`;
    switch (rec.result) {
      case "switched":
        return rec.mode === "boot"
          ? `Update ready (${when}): applies on next reboot, generation ${rec.from} → ${rec.to}${rec.idleFallback ? " (not idle within 24 h)" : ""}`
          : `System updated (${when}), generation ${rec.from} → ${rec.to}`;
      case "needs-review":
        return `Update needs review (${when}): the guard blocked ${rec.commit.slice(0, 12)}\n${(rec.reasons ?? []).map((r) => `  guard: ${r}`).join("\n")}`;
      default:
        return `Update failed (${when}): ${rec.result}${rec.detail ? ` — ${rec.detail.split("\n")[0]}` : ""}`;
    }
  })();
  const lines = [head];
  if (run) lines.push(summaryLine(run), "", ...body(run));
  if (rec.source === "user") lines.push(`  ↩ reverted ${rec.branch.replace(/^agent\/revert-/, "")} (flake-agent revert)`);
  if (rec.result === "needs-review" || rec.rolledBack) lines.push("", `  Branch:   ${rec.branch}`);
  if (handoffNote && rec.result === "switched" && !rec.rolledBack) lines.push("", `  Repo:     ${handoffNote}`);
  return lines.join("\n") + "\n";
}

/** A run that ended without asking for a switch. */
function runReport(run: RunRecord): string {
  const what = run.status === "probes-red" || run.status === "build-failed" ? `${run.status}` : "blocked";
  const lines = [`Update ${what} (${day(run.at)}): nothing was switched`, summaryLine(run)];
  if (run.detail) lines.push(`  ${run.detail.split("\n")[0]}`);
  lines.push("", ...body(run));
  if (run.branch) lines.push("", `  Branch:   ${run.branch}`);
  return lines.join("\n") + "\n";
}

export interface ReportEvent {
  /** Identifies the event: the report is shown once per key. */
  key: string;
  text: string;
}

/**
 * The latest event worth a report: a run waiting for the user's choice, a run
 * that ended without a switch, or what the switch service did with the run.
 * A green run whose switch hasn't happened yet has nothing to report.
 */
export function latestEvent(state: RunState, rec: SwitchRecord | undefined, handoffNote?: string): ReportEvent | undefined {
  const events: (ReportEvent & { at: string })[] = [];
  if (state.pending) {
    events.push({
      at: state.pending.since,
      key: `pending:${state.pending.since}`,
      text: `Update skipped — ${state.pending.failure.message}\n${CHOICE}\n`,
    });
  }
  const run = state.lastRun;
  if (run && ["blocked", "build-failed", "probes-red"].includes(run.status)) {
    events.push({ at: run.at, key: `run:${run.at}`, text: runReport(run) });
  }
  if (rec && rec.result !== "dry-run") {
    const forRun = run?.commit === rec.commit ? run : undefined;
    const at = rec.rolledBack?.at ?? rec.at;
    events.push({ at, key: `switch:${rec.at}${rec.rolledBack ? `:rollback:${rec.rolledBack.at}` : ""}`, text: switchReport(forRun, rec, handoffNote) });
  }
  return events.sort((a, b) => a.at.localeCompare(b.at)).at(-1);
}

/** One CHANGES.md entry for a run, Markdown. */
export function changesEntry(run: RunRecord): string {
  const lines = [`## ${day(run.at)} — ${run.branch ?? "run"} (${run.status})`, "", summaryLine(run) + "."];
  const items = [
    ...changeLines(run).map((l) => `- ${l.mark} \`${l.id}\` ${l.text}`),
    ...(run.behaviourChanges ?? []).map((l) => `- ⚠ upstream: ${l.replace(/^- /, "")}`),
  ];
  if (items.length) lines.push("", ...items);
  if (run.detail) lines.push("", `> ${run.detail.split("\n")[0]!.trim()}`);
  return lines.join("\n") + "\n";
}

const HEADER = "# Changes\n\nWritten by flake-agent, newest first.\n";

/** CHANGES.md with `entry` on top, below the header. */
export function prependEntry(existing: string | undefined, entry: string): string {
  const rest = (existing ?? "").startsWith(HEADER) ? existing!.slice(HEADER.length).replace(/^\n+/, "") : (existing ?? "");
  return `${HEADER}\n${entry}${rest ? `\n${rest}` : ""}`;
}
