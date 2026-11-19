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

export const CHOICE = "Retry now: `flake-agent retry`   Next cycle (default): `flake-agent skip`";

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

export async function status(state: StateStore, out: (text: string) => void): Promise<number> {
  const s = await state.load();
  const p = s.preflight;
  out(
    p
      ? `Preflight: ${p.ok ? "ok" : `failed — ${p.failure?.message}`} (${p.at})\n`
      : "Preflight: not run yet\n",
  );
  if (s.pending) out(`Pending since ${s.pending.since}: ${s.pending.failure.message}\n${CHOICE}\n`);
  const r = s.lastRun;
  if (r) out(`Last run: ${r.status} (${r.at})${r.branch ? ` ${r.branch}` : ""}${r.commit ? ` ${r.commit.slice(0, 12)}` : ""}${r.detail ? ` — ${r.detail}` : ""}\n`);
  return 0;
}
