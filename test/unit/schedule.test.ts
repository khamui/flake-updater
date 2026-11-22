import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nextCycle, nextRunLine, runCycle, status, timeLeft } from "../../src/preflight/cycle.js";
import { StateStore } from "../../src/preflight/state.js";

const now = new Date("2026-11-22T10:00:00Z");
const later = (ms: number) => new Date(now.getTime() + ms);
const MIN = 60_000;

describe("timeLeft", () => {
  it("shows days, hours and minutes, leaving out zeros", () => {
    expect(timeLeft(later(5 * 1440 * MIN + 23 * 60 * MIN + 41 * MIN), now)).toBe("5 d 23 h 41 min");
    expect(timeLeft(later(2 * 1440 * MIN + 5 * MIN), now)).toBe("2 d 5 min");
    expect(timeLeft(later(42 * MIN + 30_000), now)).toBe("42 min");
    expect(timeLeft(later(20_000), now)).toBe("under a minute");
  });
});

describe("schedule counts from the last cycle", () => {
  const setup = async () => new StateStore(await mkdtemp(join(tmpdir(), "state-")));

  it("a cycle records its start and the next one intervalDays later, preflight failed or not", async () => {
    const state = await setup();
    await runCycle({ state, preflight: async () => null, update: async () => 0, out: () => {}, intervalDays: 7, now });
    let s = await state.load();
    expect(s.lastCycle).toBe(now.toISOString());
    expect(s.nextCycle).toBe("2026-11-29T10:00:00.000Z");

    // a manual run three days later moves the next one
    const manual = later(3 * 1440 * MIN);
    await runCycle({ state, preflight: async () => ({ reason: "quota", message: "Quota exhausted" }), update: async () => 0, out: () => {}, intervalDays: 7, now: manual });
    s = await state.load();
    expect(s.nextCycle).toBe("2026-12-02T10:00:00.000Z");
    expect(nextCycle(s, 7)?.toISOString()).toBe("2026-12-02T10:00:00.000Z");
    // the interval changed in the config: the next cycle follows it
    expect(nextCycle(s, 14)?.toISOString()).toBe("2026-12-09T10:00:00.000Z");
  });

  it("never run: due at once", () => {
    expect(nextCycle({}, 7)).toBeUndefined();
    expect(nextRunLine({}, now)).toBe("Next run: at the next hourly check (none has run yet)");
  });

  it("status shows the time left, or that it is due", async () => {
    const state = await setup();
    await state.save({ nextCycle: later(5 * 1440 * MIN + 23 * 60 * MIN + 41 * MIN).toISOString() });
    const out: string[] = [];
    await status(state, (t) => out.push(t), { now });
    expect(out.join("")).toMatch(/Next run: in 5 d 23 h 41 min \(.+\)\n/);
    expect(nextRunLine({ nextCycle: later(-MIN).toISOString() }, now)).toMatch(/^Next run: due since .+; starts at the next hourly check on AC power$/);
  });
});
