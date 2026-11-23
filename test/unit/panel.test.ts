import { describe, expect, it } from "vitest";
import type { RunRecord } from "../../src/run/update.js";
import { countdown, panelMarkup, panelText, type PanelState } from "../../src/report/panel.js";
import type { SwitchRecord } from "../../src/switch/switch.js";

const now = new Date("2026-11-22T10:00:00Z");
const H = 3_600_000;
const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
const run = (status: RunRecord["status"]): RunRecord => ({ at: at(-2 * H), status, commit: "c0ffee" });
const sw = (over: Partial<SwitchRecord>): SwitchRecord => ({ at: at(-H), commit: "c0ffee", branch: "agent/update-2026-11-22", result: "switched", ...over });
const p = (over: Partial<PanelState>): PanelState => ({ state: { nextCycle: at(3.5 * 24 * H) }, running: false, onAC: true, now, ...over });

describe("countdown", () => {
  it("rounds up to the largest unit", () => {
    expect(countdown(new Date(at(3.5 * 24 * H)), now)).toBe("<4d");
    expect(countdown(new Date(at(24 * H)), now)).toBe("<1d");
    expect(countdown(new Date(at(4.2 * H)), now)).toBe("<5h");
    expect(countdown(new Date(at(19.5 * 60_000)), now)).toBe("<20m");
    expect(countdown(new Date(at(5_000)), now)).toBe("<1m");
  });
});

describe("panelText", () => {
  it("shows the time left", () => {
    expect(panelText(p({}))).toBe("<4d");
  });

  it("rnng while a run holds the lock", () => {
    expect(panelText(p({ running: true, state: { lastRun: run("blocked") } }))).toBe("rnng");
  });

  it("rvw when the run or the guard left the update for you, until the next run", () => {
    expect(panelText(p({ state: { nextCycle: at(3.5 * 24 * H), lastRun: run("blocked") } }))).toBe("rvw <4d");
    expect(panelText(p({ state: { nextCycle: at(3.5 * 24 * H), lastRun: run("green") }, lastSwitch: sw({ result: "needs-review" }) }))).toBe("rvw <4d");
    // a switch from before the last run is old news
    expect(panelText(p({ state: { nextCycle: at(3.5 * 24 * H), lastRun: run("up-to-date") }, lastSwitch: sw({ at: at(-3 * H), result: "needs-review" }) }))).toBe("<4d");
  });

  it("rlbk after a rollback or a failed activation", () => {
    expect(panelText(p({ state: { nextCycle: at(3.5 * 24 * H), lastRun: run("green") }, lastSwitch: sw({ rolledBack: { at: at(0), reason: "T2 zsh" } }) }))).toBe("rlbk <4d");
    expect(panelText(p({ state: { nextCycle: at(3.5 * 24 * H), lastRun: run("green") }, lastSwitch: sw({ result: "activation-failed" }) }))).toBe("rlbk <4d");
  });

  it("bty when due on battery; due on AC starts within the hour", () => {
    expect(panelText(p({ state: { nextCycle: at(-H) }, onAC: false }))).toBe("bty");
    expect(panelText(p({ state: { nextCycle: at(-H) } }))).toBe("<1h");
    expect(panelText(p({ state: {}, onAC: false }))).toBe("bty");
  });
});

describe("panelMarkup", () => {
  it("escapes the text for the plugin's markup and adds tooltip and click", () => {
    const m = panelMarkup(p({ state: { nextCycle: at(3.5 * 24 * H), lastRun: run("green") } }), "alacritty --hold -e flake-agent report");
    expect(m).toMatch(/^<txt>&lt;4d<\/txt><tool>flake-agent\nNext run: in 3 d 12 h \(.+\)\nLast run: green \(2026-11-22 08:00\)<\/tool><txtclick>alacritty --hold -e flake-agent report<\/txtclick>\n$/);
  });
});
