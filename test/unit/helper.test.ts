import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handoff } from "../../src/helper/handoff.js";
import { tick, type HelperDeps, type HelperState } from "../../src/helper/helper.js";
import { readIdle, waitForIdle, type Clock } from "../../src/helper/idle.js";
import type { RunState } from "../../src/preflight/state.js";
import { superseded } from "../../src/run/update.js";
import { rollbackRefusal } from "../../src/switch/rollback.js";
import { switchCommit, type SwitchDeps, type SwitchRecord } from "../../src/switch/switch.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const SHA = "c".repeat(40);

/** A clock where sleeping advances time, and the user is idle from `idleFrom` on. */
function fakeSession(idleFrom: number) {
  let t = 0;
  const clock: Clock = { now: () => t, sleep: async (ms) => void (t += ms) };
  const idle = async () => (t < idleFrom ? 0 : t - idleFrom);
  return { clock, idle, elapsed: () => t };
}

describe("idle", () => {
  it("switches only after 15 minutes idle", async () => {
    const s = fakeSession(3 * HOUR);
    expect(await waitForIdle(s.idle, { idleMinutes: 15, fallbackHours: 24 }, s.clock)).toBe("idle");
    expect(s.elapsed()).toBe(3 * HOUR + 15 * MIN);
  });

  it("gives up after 24 hours of activity", async () => {
    const s = fakeSession(Infinity);
    expect(await waitForIdle(s.idle, { idleMinutes: 15, fallbackHours: 24 }, s.clock)).toBe("timeout");
    expect(s.elapsed()).toBe(24 * HOUR);
  });

  it("reads the helper's report; missing or stale means nobody to disturb", async () => {
    const dir = await mkdtemp(join(tmpdir(), "idle-"));
    const file = join(dir, "idle.json");
    expect(await readIdle(file, 1_000_000)).toBe(Infinity);
    await writeFile(file, JSON.stringify({ idleMs: 2 * MIN, at: 1_000_000, source: "xprintidle" }));
    expect(await readIdle(file, 1_000_000 + MIN)).toBe(3 * MIN);
    expect(await readIdle(file, 1_000_000 + 10 * MIN)).toBe(Infinity);
  });

  it("sets the boot entry instead when the user is never idle, and says so", async () => {
    const out: string[] = [];
    const deps: SwitchDeps = {
      guard: async () => ({ verdict: "pass", reasons: [], base: "b", rev: SHA }),
      build: async () => ({ ok: true, toplevel: "/nix/store/new" }),
      apply: vi.fn(async () => ({ ok: true })),
      current: "/nix/store/new",
      out: (t) => out.push(t),
      waitForIdle: async () => "timeout",
    };
    const rec = await switchCommit("/repo", { commit: SHA, branch: "agent/update-x", at: "" }, deps);
    expect(deps.apply).toHaveBeenCalledWith("/nix/store/new", "boot");
    expect(rec).toMatchObject({ result: "switched", mode: "boot", idleFallback: true });
    expect(out.join("")).toContain("Not idle within the fallback period");
  });
});

describe("rollback requests", () => {
  const rec: SwitchRecord = { at: "t", commit: SHA, branch: "agent/x", result: "switched", mode: "switch", from: 91, to: 92 };
  const req = { commit: SHA, reason: "T3 nvim-startup-error" };

  it("undoes only the agent's last live switch while it is still current", () => {
    expect(rollbackRefusal(req, rec, 92)).toBeNull();
    expect(rollbackRefusal(req, rec, 93)).toBe("generation 92 is no longer current");
    expect(rollbackRefusal({ ...req, commit: "d".repeat(40) }, rec, 92)).toBe("request is for another commit");
    expect(rollbackRefusal(req, { ...rec, mode: "boot" }, 92)).toBe("the last agent action was not a live switch");
    expect(rollbackRefusal(req, { ...rec, rolledBack: { at: "t", reason: "x" } }, 92)).toBe("already rolled back");
    expect(rollbackRefusal(undefined, rec, 92)).toBe("no valid request");
  });
});

describe("helper", () => {
  function helper(agent: RunState, last?: SwitchRecord, opts: { action?: string; failures?: number } = {}) {
    let state: HelperState = {};
    const notes: string[] = [];
    const deps: HelperDeps = {
      idle: { name: "fake", idleMs: async () => 0 },
      publishIdle: vi.fn(async () => undefined),
      agentState: async () => agent,
      lastSwitch: async () => last,
      load: async () => state,
      save: async (s) => void (state = s),
      notify: vi.fn(async (summary: string, body: string, actions?: Record<string, string>) => {
        notes.push(`${summary}: ${body}`);
        return actions ? opts.action : undefined;
      }),
      triggerRun: vi.fn(async () => {}),
      postSwitchCheck: vi.fn(async () =>
        Array.from({ length: opts.failures ?? 0 }, () => ({ severity: "fail" as const, kind: "nvim-startup-error", subject: "neovim", detail: "E5113" })),
      ),
      requestRollback: vi.fn(async () => {}),
      handoff: vi.fn(async () => ({ applied: true, fastForwarded: true, note: "main fast-forwarded" })),
    };
    const run = async () => Promise.all(await tick(deps));
    return { deps, notes, run, state: () => state };
  }
  const pending: RunState = { pending: { since: "2026-11-25T03:00:00Z", failure: { reason: "quota", message: "Quota exhausted" } } };

  it("Retry now on the preflight notification starts a run; it is shown once", async () => {
    const h = helper(pending, undefined, { action: "retry" });
    await h.run();
    expect(h.notes).toEqual(["Update skipped: Quota exhausted"]);
    expect(h.deps.triggerRun).toHaveBeenCalledOnce();
    await h.run();
    expect(h.notes).toHaveLength(1);
  });

  it("Next cycle (or closing it) dismisses the prompt", async () => {
    const h = helper(pending, undefined, { action: undefined });
    await h.run();
    expect(h.deps.triggerRun).not.toHaveBeenCalled();
    expect(h.state().dismissedPending).toBe("2026-11-25T03:00:00Z");
  });

  const switched: SwitchRecord = { at: "s1", commit: SHA, branch: "agent/x", result: "switched", mode: "switch", from: 91, to: 92 };

  it("a failing post-switch check requests a rollback and notifies", async () => {
    const h = helper({}, switched, { failures: 2 });
    await h.run();
    expect(h.deps.requestRollback).toHaveBeenCalledWith({ commit: SHA, reason: "nvim-startup-error neovim: E5113" });
    expect(h.deps.handoff).not.toHaveBeenCalled();
    expect(h.notes).toEqual(["Update rolled back: Post-switch check failed (2): nvim-startup-error neovim: E5113"]);
  });

  it("a green switch is handed off and reported once", async () => {
    const h = helper({}, switched);
    await h.run();
    await h.run();
    expect(h.deps.handoff).toHaveBeenCalledOnce();
    expect(h.notes).toEqual(["System updated: Generation 91 → 92\nmain fast-forwarded"]);
  });

  it("an idle fallback is reported as a boot entry, without a live check", async () => {
    const h = helper({}, { ...switched, mode: "boot", idleFallback: true });
    await h.run();
    expect(h.deps.postSwitchCheck).not.toHaveBeenCalled();
    expect(h.notes[0]).toBe("Update ready: Applies on next reboot (generation 91 → 92): not idle within 24 h\nmain fast-forwarded");
  });
});

describe("handoff", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=u", "-c", "user.email=u@x", "-C", cwd, ...args], { encoding: "utf8" }).trim();

  /** User repo on main, and a "switch repo" holding an agent commit on top of it. */
  async function setup() {
    const root = await mkdtemp(join(tmpdir(), "handoff-"));
    const user = join(root, "user");
    const source = join(root, "switch.git");
    execFileSync("git", ["init", "-q", "-b", "main", user]);
    await writeFile(join(user, "a.nix"), "{ }\n");
    git(user, "add", ".");
    git(user, "commit", "-qm", "base");
    const base = git(user, "rev-parse", "HEAD");
    execFileSync("git", ["clone", "-q", "--bare", user, source]);
    const work = join(root, "agent");
    execFileSync("git", ["clone", "-q", source, work]);
    await writeFile(join(work, "flake.lock"), "{}\n");
    git(work, "add", ".");
    git(work, "commit", "-qm", "flake.lock: update");
    const commit = git(work, "rev-parse", "HEAD");
    git(work, "push", "-q", "origin", `HEAD:refs/candidates/agent/update-x`);
    const opts = { repo: user, source, commit, branch: "agent/update-x", runBase: base, mainBranch: "main" };
    return { user, base, commit, opts };
  }

  it("fast-forwards a clean main that hasn't moved", async () => {
    const s = await setup();
    expect(await handoff(s.opts)).toEqual({ applied: true, fastForwarded: true, note: `main fast-forwarded to ${s.commit.slice(0, 12)}` });
    expect(git(s.user, "rev-parse", "main")).toBe(s.commit);
    expect(git(s.user, "rev-parse", "agent/applied")).toBe(s.commit);
  });

  it("does not fast-forward a dirty tree, and says so", async () => {
    const s = await setup();
    await writeFile(join(s.user, "a.nix"), "{ x = 1; }\n");
    expect(await handoff(s.opts)).toMatchObject({ applied: true, fastForwarded: false, note: "uncommitted changes in your repo — merge agent/applied by hand" });
    expect(git(s.user, "rev-parse", "main")).toBe(s.base);
  });

  it("does not fast-forward when main moved, and says so", async () => {
    const s = await setup();
    await writeFile(join(s.user, "b.nix"), "{ }\n");
    git(s.user, "add", ".");
    git(s.user, "commit", "-qm", "my edit");
    const moved = git(s.user, "rev-parse", "main");
    expect(await handoff(s.opts)).toMatchObject({ fastForwarded: false, note: "main diverged — merge agent/applied by hand" });
    expect(git(s.user, "rev-parse", "main")).toBe(moved);
    expect(git(s.user, "rev-parse", "agent/applied")).toBe(s.commit);
  });

  it("fast-forwards main without touching the work tree when another branch is checked out", async () => {
    const s = await setup();
    git(s.user, "checkout", "-qb", "feature");
    expect((await handoff(s.opts)).fastForwarded).toBe(true);
    expect(git(s.user, "rev-parse", "main")).toBe(s.commit);
    expect(git(s.user, "symbolic-ref", "--short", "HEAD")).toBe("feature");
  });
});

describe("diverged main", () => {
  it("marks the previous run's branch superseded when main moved", () => {
    const prev = { at: "1", status: "probes-red" as const, branch: "agent/update-2026-11-18", base: "a" };
    expect(superseded(prev, { at: "2", status: "green", base: "b" })).toBe("agent/update-2026-11-18");
    expect(superseded(prev, { at: "2", status: "green", base: "a" })).toBeUndefined();
  });
});
