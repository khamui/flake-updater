import { CHOICE, changeLines, runUpstream } from "../report/report.js";
import type { SwitchRecord } from "../switch/switch.js";
import type { RunState, StateStore } from "./state.js";
import type { PreflightFailure } from "./subscription.js";

export interface CycleDeps {
  state: StateStore;
  preflight: () => Promise<PreflightFailure | null>;
  /** The update run itself; only reached after preflight passed. */
  update: () => Promise<number>;
  out: (text: string) => void;
  /** Days until the next scheduled cycle, counted from this one's start. */
  intervalDays?: number;
  now?: Date;
}

/** Exit code when preflight fails: nothing ran, the user chooses retry or skip. */
export const PREFLIGHT_FAILED = 3;

export { CHOICE };

const DAY_MS = 24 * 60 * 60_000;

/** When the next scheduled cycle is due: `intervalDays` after the last one, any way it was started. */
export function nextCycle(s: RunState, intervalDays: number): Date | undefined {
  return s.lastCycle ? new Date(Date.parse(s.lastCycle) + intervalDays * DAY_MS) : undefined;
}

/** "5 d 23 h 41 min": the time left until `to`, to the minute. */
export function timeLeft(to: Date, now: Date): string {
  const minutes = Math.floor((to.getTime() - now.getTime()) / 60_000);
  if (minutes < 1) return "under a minute";
  const parts = [
    [Math.floor(minutes / 1440), "d"],
    [Math.floor((minutes % 1440) / 60), "h"],
    [minutes % 60, "min"],
  ] as const;
  return parts
    .filter(([n]) => n > 0)
    .map(([n, unit]) => `${n} ${unit}`)
    .join(" ");
}

const when = (d: Date) => d.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** The status line for the schedule; the timer checks hourly and only on AC power. */
export function nextRunLine(s: RunState, now: Date): string {
  if (!s.nextCycle) return "Next run: at the next hourly check (none has run yet)";
  const next = new Date(s.nextCycle);
  if (next <= now) return `Next run: due since ${when(next)}; starts at the next hourly check on AC power`;
  return `Next run: in ${timeLeft(next, now)} (${when(next)})`;
}

/** One cycle (`run`, and `retry` after a failure): preflight, then the update. The schedule counts from here. */
export async function runCycle(deps: CycleDeps): Promise<number> {
  const start = deps.now ?? new Date();
  const cycle = {
    lastCycle: start.toISOString(),
    ...(deps.intervalDays ? { nextCycle: new Date(start.getTime() + deps.intervalDays * DAY_MS).toISOString() } : {}),
  };
  const failure = await deps.preflight();
  const at = new Date().toISOString();
  if (failure) {
    await deps.state.update((s) => ({
      ...s,
      ...cycle,
      preflight: { at, ok: false, failure },
      pending: { since: s.pending?.since ?? at, failure },
    }));
    deps.out(`Update skipped — ${failure.message}\n${CHOICE}\n`);
    return PREFLIGHT_FAILED;
  }
  await deps.state.update((s) => ({ ...s, ...cycle, preflight: { at, ok: true }, pending: undefined }));
  return deps.update();
}

/** `skip`: dismiss the pending choice and wait for the next cycle. */
export async function skip(state: StateStore, out: (text: string) => void): Promise<number> {
  const s = await state.load();
  if (!s.pending) {
    out("Nothing pending.\n");
    return 0;
  }
  await state.save({ ...s, pending: undefined });
  out("Skipped: the next scheduled cycle runs as usual.\n");
  return 0;
}

export interface StatusExtras {
  /** The running system generation. */
  generation?: number;
  lastSwitch?: SwitchRecord;
  now?: Date;
  /** A pending choice the user already dismissed (installed: the helper's state). */
  dismissedPending?: string;
}

export async function status(state: StateStore, out: (text: string) => void, extras: StatusExtras = {}): Promise<number> {
  const s = await state.load();
  const p = s.preflight;
  out(
    p
      ? `Preflight: ${p.ok ? "ok" : `failed — ${p.failure?.message}`} (${p.at})\n`
      : "Preflight: not run yet\n",
  );
  if (s.pending && s.pending.since !== extras.dismissedPending) out(`Pending since ${s.pending.since}: ${s.pending.failure.message}\n${CHOICE}\n`);
  if (extras.generation !== undefined) out(`Generation: ${extras.generation}\n`);
  out(`${nextRunLine(s, extras.now ?? new Date())}\n`);
  const r = s.lastRun;
  if (r) {
    out(`Last run: ${r.status} (${r.at})${r.branch ? ` ${r.branch}` : ""}${r.commit ? ` ${r.commit.slice(0, 12)}` : ""}${r.detail ? ` — ${r.detail}` : ""}\n`);
    for (const l of changeLines(r)) out(`  ${l.mark} ${l.id}  ${l.text}\n`);
    for (const f of runUpstream(r)) out(`  ⚠ upstream ${f.id}  ${f.finding}\n`);
  }
  const sw = extras.lastSwitch;
  if (sw) {
    const result = sw.rolledBack ? `rolled back — ${sw.rolledBack.reason}` : sw.result === "switched" ? `${sw.mode ?? "switch"}, generation ${sw.from} → ${sw.to}` : sw.result;
    out(`Last switch: ${result} (${sw.at}) ${sw.branch} ${sw.commit.slice(0, 12)}\n`);
    if (sw.result === "needs-review") for (const reason of sw.reasons ?? []) out(`  ⛔ guard: ${reason}\n`);
  }
  // a green run the switch service hasn't handled yet
  if (r?.status === "green" && r.commit && sw?.commit !== r.commit) out(`Waiting to switch: ${r.commit.slice(0, 12)} (idle or next boot)\n`);
  for (const b of s.superseded ?? []) out(`Superseded: ${b.branch} (${b.at})\n`);
  return 0;
}
