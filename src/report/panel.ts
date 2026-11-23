import { nextRunLine } from "../preflight/schedule.js";
import type { RunState } from "../preflight/state.js";
import type { SwitchRecord } from "../switch/switch.js";

/** What the XFCE Generic Monitor plugin shows (`status --panel`). */
export interface PanelState {
  state: RunState;
  lastSwitch?: SwitchRecord;
  /** A run holds the run lock. */
  running: boolean;
  onAC: boolean;
  now: Date;
  /** The last switch's guard block is handled: its changes are on main. */
  reviewHandled?: boolean;
}

const NEEDS_YOU = ["blocked", "build-failed", "probes-red"];

/** "<4d", "<5h", "<20m": the time left, rounded up to the unit. */
export function countdown(to: Date, now: Date): string {
  const ms = to.getTime() - now.getTime();
  const up = (unit: number) => Math.max(1, Math.ceil(ms / unit));
  if (ms >= 86_400_000) return `<${up(86_400_000)}d`;
  if (ms >= 3_600_000) return `<${up(3_600_000)}h`;
  return `<${up(60_000)}m`;
}

/**
 * rnng: a run is going. rlbk / rvw: the last run's switch was rolled back, or
 * the run or the guard left it for you (until the next run, or a guard block's
 * changes are on main). bty: due, but on
 * battery. Otherwise the time left; a due run starts within the hour.
 */
export function panelText(p: PanelState): string {
  if (p.running) return "rnng";
  const run = p.state.lastRun;
  // the switch belongs to the last run when it came after it
  const sw = run && p.lastSwitch && p.lastSwitch.at >= run.at ? p.lastSwitch : undefined;
  const next = p.state.nextCycle ? new Date(p.state.nextCycle) : undefined;
  const due = !next || next <= p.now;
  const left = due ? "<1h" : countdown(next, p.now);
  if (sw && (sw.rolledBack || sw.result === "activation-failed")) return `rlbk ${left}`;
  const swNeedsYou = sw && (sw.result === "needs-review" ? !p.reviewHandled : ["build-failed", "error"].includes(sw.result));
  if ((run && NEEDS_YOU.includes(run.status)) || swNeedsYou) return `rvw ${left}`;
  if (due && !p.onAC) return "bty";
  return left;
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Generic Monitor markup: panel text, tooltip, and a click that opens the report. */
export function panelMarkup(p: PanelState, click: string): string {
  const run = p.state.lastRun;
  const tool = [
    "flake-agent",
    nextRunLine(p.state, p.now),
    run ? `Last run: ${run.status} (${run.at.slice(0, 16).replace("T", " ")})` : "Last run: none yet",
    ...(p.lastSwitch ? [`Last switch: ${p.lastSwitch.rolledBack ? "rolled back" : p.lastSwitch.result}${p.lastSwitch.result === "needs-review" && p.reviewHandled ? ", handled" : ""} (${p.lastSwitch.at.slice(0, 16).replace("T", " ")})`] : []),
    ...(p.state.pending ? [`Pending: ${p.state.pending.failure.message}`] : []),
  ];
  return `<txt>${escape(panelText(p))}</txt><tool>${escape(tool.join("\n"))}</tool><txtclick>${escape(click)}</txtclick>\n`;
}
