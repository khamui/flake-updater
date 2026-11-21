import { CHOICE, changeLines, runUpstream } from "../report/report.js";
import type { SwitchRecord } from "../switch/switch.js";
import type { StateStore } from "./state.js";
import type { PreflightFailure } from "./subscription.js";

export interface CycleDeps {
  state: StateStore;
  preflight: () => Promise<PreflightFailure | null>;
  /** The update run itself; only reached after preflight passed. */
  update: () => Promise<number>;
  out: (text: string) => void;
}

/** Exit code when preflight fails: nothing ran, the user chooses retry or skip. */
export const PREFLIGHT_FAILED = 3;

export { CHOICE };

/** One cycle (`run`, and `retry` after a failure): preflight, then the update. */
export async function runCycle(deps: CycleDeps): Promise<number> {
  const failure = await deps.preflight();
  const at = new Date().toISOString();
  if (failure) {
    await deps.state.update((s) => ({
      ...s,
      preflight: { at, ok: false, failure },
      pending: { since: s.pending?.since ?? at, failure },
    }));
    deps.out(`Update skipped — ${failure.message}\n${CHOICE}\n`);
    return PREFLIGHT_FAILED;
  }
  await deps.state.update((s) => ({ ...s, preflight: { at, ok: true }, pending: undefined }));
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
