import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { discoverPrograms } from "../discovery/discover.js";
import { capture } from "../nix/exec.js";
import type { RunState } from "../preflight/state.js";
import { DEEP_PROBES } from "../probes/deep/index.js";
import type { Finding } from "../probes/t0.js";
import { diffT2, snapshotT2 } from "../probes/t2.js";
import { diffT3, selectDeepProbes, snapshotT3 } from "../probes/t3.js";
import { BUILTIN_VALIDATORS, selectValidators } from "../probes/validators.js";
import type { AgentConfig } from "../run/config.js";
import { ROLLBACK_REQUEST, readLastSwitch, type RollbackRequest } from "../switch/rollback.js";
import type { SwitchRecord } from "../switch/switch.js";
import { handoff, type HandoffResult } from "./handoff.js";
import { publishIdle, xprintidle, type IdleSource } from "./idle.js";

/** What the helper has already shown or done, so each event is handled once. */
export interface HelperState {
  /** `pending.since` of the preflight failure last notified / dismissed. */
  notifiedPending?: string;
  dismissedPending?: string;
  /** `at` of the last switch record handled. */
  handledSwitch?: string;
  /** Where the last switched commit went in the user's repo, for the report. */
  handoff?: { commit: string; note: string };
}

export interface HelperDeps {
  idle: IdleSource;
  publishIdle: (source: IdleSource) => Promise<unknown>;
  agentState: () => Promise<RunState>;
  lastSwitch: () => Promise<SwitchRecord | undefined>;
  load: () => Promise<HelperState>;
  save: (s: HelperState) => Promise<void>;
  /** Shows a notification; with actions, resolves to the chosen action key (or undefined). */
  notify: (summary: string, body: string, actions?: Record<string, string>) => Promise<string | undefined>;
  /** `systemctl start flake-agent.service` (allowed for this user by polkit). */
  triggerRun: () => Promise<void>;
  postSwitchCheck: (rec: SwitchRecord) => Promise<Finding[]>;
  requestRollback: (req: RollbackRequest) => Promise<void>;
  handoff: (rec: SwitchRecord) => Promise<HandoffResult>;
}

export const RETRY_ACTIONS = { retry: "Retry now", skip: "Next cycle" };

/** Act on a preflight notification's choice; dismissing is the default. */
export async function onPreflightChoice(action: string | undefined, since: string, deps: HelperDeps): Promise<void> {
  if (action === "retry") {
    await deps.triggerRun();
  } else {
    const s = await deps.load();
    await deps.save({ ...s, dismissedPending: since });
  }
}

/**
 * One helper iteration. Returns the notification promises it started (the
 * preflight one waits for the user's click), so callers can await them in tests.
 */
export async function tick(deps: HelperDeps): Promise<Promise<void>[]> {
  const background: Promise<void>[] = [];
  await deps.publishIdle(deps.idle).catch(() => undefined);
  let state = await deps.load();

  const pending = (await deps.agentState()).pending;
  if (pending && pending.since !== state.notifiedPending && pending.since !== state.dismissedPending) {
    state = { ...state, notifiedPending: pending.since };
    await deps.save(state);
    background.push(
      deps
        .notify("Update skipped", pending.failure.message, RETRY_ACTIONS)
        .then((action) => onPreflightChoice(action, pending.since, deps)),
    );
  }

  const rec = await deps.lastSwitch();
  if (rec && rec.at !== state.handledSwitch) {
    state = { ...(await deps.load()), handledSwitch: rec.at };
    await deps.save(state);
    background.push(handleSwitch(rec, deps));
  }
  return background;
}

async function handleSwitch(rec: SwitchRecord, deps: HelperDeps): Promise<void> {
  const short = rec.commit.slice(0, 12);
  switch (rec.result) {
    case "needs-review":
      await deps.notify("Update needs you", `${short}: ${rec.reasons?.[0] ?? "guard blocked the change"}`);
      return;
    case "build-failed":
    case "activation-failed":
    case "error":
      await deps.notify("Update failed", `${short}: ${rec.result}${rec.detail ? ` — ${rec.detail.split("\n")[0]}` : ""}`);
      return;
    case "switched":
      break;
    default:
      return;
  }

  if (rec.mode === "switch" && !rec.rolledBack) {
    const failures = await deps.postSwitchCheck(rec);
    if (failures.length) {
      const reason = `${failures[0]!.kind} ${failures[0]!.subject}: ${failures[0]!.detail}`.slice(0, 300);
      await deps.requestRollback({ commit: rec.commit, reason });
      await deps.notify("Update rolled back", `Post-switch check failed (${failures.length}): ${reason}`);
      return;
    }
  }
  const h = await deps.handoff(rec).catch((err: Error): HandoffResult => ({ applied: false, fastForwarded: false, note: `handoff failed: ${err.message}` }));
  await deps.save({ ...(await deps.load()), handoff: { commit: rec.commit, note: h.note } });
  const what =
    rec.mode === "boot"
      ? `Applies on next reboot (generation ${rec.from} → ${rec.to})${rec.idleFallback ? ": not idle within 24 h" : ""}`
      : `Generation ${rec.from} → ${rec.to}`;
  await deps.notify(rec.mode === "boot" ? "Update ready" : "System updated", `${what}\n${h.note}`);
}

/** Post-switch check: the user-level probes (T2, T3), previous generation vs the live system. */
export async function postSwitchProbes(cfg: AgentConfig, switchRepo: string, rec: SwitchRecord): Promise<Finding[]> {
  const old = `/nix/var/nix/profiles/system-${rec.from}-link`;
  const programs = await discoverPrograms({ flake: `git+file://${switchRepo}?rev=${rec.commit}`, host: cfg.host, user: cfg.user });
  const validators = selectValidators(programs, BUILTIN_VALIDATORS);
  const deep = selectDeepProbes(programs, DEEP_PROBES);
  const live = "/run/current-system";
  const t2 = diffT2(await snapshotT2(old, cfg.user, validators), await snapshotT2(live, cfg.user, validators));
  const t3 = diffT3(await snapshotT3(old, cfg.user, deep), await snapshotT3(live, cfg.user, deep), deep);
  return [...t2, ...t3].filter((f) => f.severity === "fail");
}

/** notify-send; with actions it waits for the click and returns the action key. */
export function notifySend(summary: string, body: string, actions?: Record<string, string>): Promise<string | undefined> {
  const args = ["--app-name=flake-agent", ...Object.entries(actions ?? {}).map(([k, v]) => `--action=${k}=${v}`)];
  if (actions) args.push("--wait");
  return new Promise((resolve) => {
    const child = spawn("notify-send", [...args, summary, body], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => resolve(undefined));
    child.on("close", () => resolve(out.trim() || undefined));
  });
}

export function realHelperDeps(cfg: AgentConfig, paths: { agentState: string; switchState: string; helperState: string }): HelperDeps {
  const switchRepo = join(paths.switchState, "repo.git");
  return {
    idle: xprintidle,
    publishIdle: (source) => publishIdle(source),
    agentState: async () => JSON.parse(await readFile(join(paths.agentState, "state.json"), "utf8").catch(() => "{}")) as RunState,
    lastSwitch: () => readLastSwitch(paths.switchState),
    load: async () => JSON.parse(await readFile(paths.helperState, "utf8").catch(() => "{}")) as HelperState,
    async save(s) {
      await mkdir(dirname(paths.helperState), { recursive: true });
      await writeFile(paths.helperState, JSON.stringify(s, null, 2) + "\n");
    },
    notify: notifySend,
    async triggerRun() {
      await capture("systemctl", ["start", "--no-block", "flake-agent.service"], { env: process.env as Record<string, string> });
    },
    postSwitchCheck: (rec) => postSwitchProbes(cfg, switchRepo, rec),
    async requestRollback(req) {
      await mkdir(dirname(ROLLBACK_REQUEST), { recursive: true });
      await writeFile(ROLLBACK_REQUEST, JSON.stringify(req) + "\n");
    },
    handoff: (rec) =>
      handoff({ repo: cfg.repo, source: switchRepo, commit: rec.commit, branch: rec.branch, runBase: rec.runBase, mainBranch: cfg.mainBranch }),
  };
}
