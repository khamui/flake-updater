import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { heldIds, idsOn, reviewHandled } from "../../src/report/review.js";
import type { RunRecord } from "../../src/run/update.js";
import type { SwitchRecord } from "../../src/switch/switch.js";

const SHA = "a".repeat(40);
const run = (changes: RunRecord["changes"]): RunRecord => ({ at: "2026-11-22T15:45:00.000Z", status: "green", branch: "agent/update-2026-11-22", commit: SHA, changes });
const blocked: SwitchRecord = { at: "2026-11-22T15:47:00.000Z", commit: SHA, branch: "agent/update-2026-11-22", result: "needs-review", reasons: ["hash change"] };
const changes: RunRecord["changes"] = [
  { sha: "1", subject: "nvf: rename", id: "nvf-rename-2026-11", class: "mechanical" },
  { sha: "2", subject: "drop hash override", id: "tsls-hash-2026-11", class: "review" },
];

describe("heldIds", () => {
  it("is the run's review changes", () => {
    expect(heldIds(run(changes))).toEqual(["tsls-hash-2026-11"]);
  });
  it("is every change when the guard blocked a run without review changes", () => {
    expect(heldIds(run([changes[0]!, { ...changes[0]!, sha: "3" }]))).toEqual(["nvf-rename-2026-11"]);
  });
});

describe("reviewHandled", () => {
  it("is true once every held change is on main", () => {
    expect(reviewHandled(run(changes), blocked, new Set(["tsls-hash-2026-11"]))).toBe(true);
  });
  it("is false while a held change is missing from main", () => {
    expect(reviewHandled(run(changes), blocked, new Set(["nvf-rename-2026-11"]))).toBe(false);
  });
  it("only applies to a needs-review switch of that run", () => {
    const ids = new Set(["tsls-hash-2026-11"]);
    expect(reviewHandled(run(changes), { ...blocked, result: "build-failed" }, ids)).toBe(false);
    expect(reviewHandled(run(changes), { ...blocked, commit: "b".repeat(40) }, ids)).toBe(false);
    expect(reviewHandled(undefined, blocked, ids)).toBe(false);
    expect(reviewHandled(run([]), blocked, ids)).toBe(false);
  });
});

describe("idsOn", () => {
  it("finds Change-Id trailers on the branch, whatever the commit hash", async () => {
    const repo = await mkdtemp(join(tmpdir(), "review-"));
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=a", "-c", "user.email=a@x", "-C", repo, ...args], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "base");
    // a rebased copy of the agent's commit, with a tool's trailer after it
    git("commit", "-q", "--allow-empty", "-m", "drop hash override\n\nChange-Id: tsls-hash-2026-11\nChange-Class: review\n\nCo-Authored-By: someone <x@y>");
    // only mentions the id in the body: not a trailer
    git("commit", "-q", "--allow-empty", "-m", "note\n\nsee Change-Id: nvf-rename-2026-11 later\n\nmore text");
    git("switch", "-q", "-c", "other");
    git("commit", "-q", "--allow-empty", "-m", "other\n\nChange-Id: elsewhere-2026-11");

    expect(await idsOn(repo, "main", ["tsls-hash-2026-11", "nvf-rename-2026-11", "elsewhere-2026-11"])).toEqual(new Set(["tsls-hash-2026-11"]));
    expect(await idsOn(repo, "main", [])).toEqual(new Set());
  });
});
