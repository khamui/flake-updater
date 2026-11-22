import type { RunState } from "./state.js";

export const DAY_MS = 24 * 60 * 60_000;

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

