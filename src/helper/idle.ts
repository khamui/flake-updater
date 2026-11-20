import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { capture } from "../nix/exec.js";

/** Where the user helper publishes the session's idle time for the root switch service. */
export const IDLE_FILE = "/run/flake-agent/idle.json";

/** Pluggable: X via xprintidle now; Wayland later. */
export interface IdleSource {
  name: string;
  /** Milliseconds since the last input, or undefined if unknown. */
  idleMs(): Promise<number | undefined>;
}

export const xprintidle: IdleSource = {
  name: "xprintidle",
  async idleMs() {
    const r = await capture("xprintidle", [], { env: process.env as Record<string, string>, timeoutMs: 10_000 });
    const ms = Number(r.stdout.trim());
    return r.code === 0 && Number.isFinite(ms) ? ms : undefined;
  },
};

export interface IdleReport {
  idleMs: number;
  /** When it was measured (epoch ms). */
  at: number;
  source: string;
}

export async function publishIdle(source: IdleSource, file = IDLE_FILE, now = Date.now()): Promise<IdleReport | undefined> {
  const idleMs = await source.idleMs();
  if (idleMs === undefined) return undefined;
  const report = { idleMs, at: now, source: source.name };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(report) + "\n");
  return report;
}

/** Reports older than this mean the helper isn't running: no session to disturb. */
export const STALE_MS = 5 * 60_000;

/**
 * Idle time as of `now`: the report's idle time plus its age. No report, or a
 * stale one, counts as idle — nobody is in a session to be disturbed.
 */
export async function readIdle(file = IDLE_FILE, now = Date.now()): Promise<number> {
  try {
    const r = JSON.parse(await readFile(file, "utf8")) as IdleReport;
    const age = now - r.at;
    if (!Number.isFinite(r.idleMs) || age > STALE_MS || age < 0) return Infinity;
    return r.idleMs + age;
  } catch {
    return Infinity;
  }
}

export interface WaitOptions {
  idleMinutes: number;
  fallbackHours: number;
  pollMs?: number;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Wait until the session has been idle long enough; give up after the fallback period. */
export async function waitForIdle(
  idle: () => Promise<number>,
  opts: WaitOptions,
  clock: Clock = realClock,
): Promise<"idle" | "timeout"> {
  const deadline = clock.now() + opts.fallbackHours * 3600_000;
  for (;;) {
    if ((await idle()) >= opts.idleMinutes * 60_000) return "idle";
    if (clock.now() >= deadline) return "timeout";
    await clock.sleep(Math.min(opts.pollMs ?? 60_000, Math.max(0, deadline - clock.now())));
  }
}
