import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { capture, run } from "../nix/exec.js";
import { SYSTEM_PROFILE, listGenerations } from "./generations.js";
import type { SwitchRecord } from "./switch.js";

/** Written by the user helper when the post-switch check fails. */
export const ROLLBACK_REQUEST = "/run/flake-agent/rollback-request.json";

export const lastSwitchPath = (switchStateDir: string) => join(switchStateDir, "last-switch.json");

export interface RollbackRequest {
  commit: string;
  reason: string;
}

export async function readLastSwitch(switchStateDir: string): Promise<SwitchRecord | undefined> {
  try {
    return JSON.parse(await readFile(lastSwitchPath(switchStateDir), "utf8")) as SwitchRecord;
  } catch {
    return undefined;
  }
}

/**
 * Why a rollback request must be refused, or null. The request comes from an
 * unprivileged user process, so it can only ever undo the agent's own last
 * live switch, while that switch is still the running generation.
 */
export function rollbackRefusal(req: RollbackRequest | undefined, rec: SwitchRecord | undefined, current: number | undefined): string | null {
  if (!req) return "no valid request";
  if (!rec || rec.result !== "switched" || rec.mode !== "switch") return "the last agent action was not a live switch";
  if (rec.rolledBack) return "already rolled back";
  if (rec.commit !== req.commit) return "request is for another commit";
  if (rec.from === undefined || rec.to === undefined) return "previous generation unknown";
  if (current !== rec.to) return `generation ${rec.to} is no longer current`;
  return null;
}

export interface RollbackDeps {
  current: () => Promise<number | undefined>;
  switchTo: (generation: number) => Promise<{ ok: boolean; error?: string }>;
  out: (text: string) => void;
}

export const realRollbackDeps = (out: (t: string) => void): RollbackDeps => ({
  current: async () => (await listGenerations(SYSTEM_PROFILE)).current,
  async switchTo(generation) {
    await run("nix-env", ["-p", SYSTEM_PROFILE, "--switch-generation", String(generation)]);
    const r = await capture(join(SYSTEM_PROFILE, "bin", "switch-to-configuration"), ["switch"], {
      env: process.env as Record<string, string>,
      timeoutMs: 3600_000,
    });
    return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr.trim().split("\n").slice(-5).join("\n") };
  },
  out,
});

/** The root rollback service: validate the user helper's request, then switch back. */
export async function rollbackService(switchStateDir: string, deps: RollbackDeps, requestFile = ROLLBACK_REQUEST): Promise<boolean> {
  let req: RollbackRequest | undefined;
  try {
    const raw = JSON.parse(await readFile(requestFile, "utf8")) as Partial<RollbackRequest>;
    if (typeof raw.commit === "string" && /^[0-9a-f]{40}$/.test(raw.commit)) {
      req = { commit: raw.commit, reason: String(raw.reason ?? "").slice(0, 500) };
    }
  } catch {
    // invalid request
  }
  await rm(requestFile, { force: true });

  const rec = await readLastSwitch(switchStateDir);
  const refusal = rollbackRefusal(req, rec, await deps.current());
  if (refusal) {
    deps.out(`Rollback refused: ${refusal}\n`);
    return false;
  }
  const result = await deps.switchTo(rec!.from!);
  if (!result.ok) {
    deps.out(`Rollback failed: ${result.error}\n`);
    return false;
  }
  const updated: SwitchRecord = { ...rec!, rolledBack: { at: new Date().toISOString(), reason: req!.reason } };
  await writeFile(lastSwitchPath(switchStateDir), JSON.stringify(updated, null, 2) + "\n");
  deps.out(`Rolled back: generation ${rec!.to} → ${rec!.from} (${req!.reason})\n`);
  return true;
}
