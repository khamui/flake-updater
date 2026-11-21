import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunRecord } from "../run/update.js";
import type { RevertRunRecord } from "../revert/upstream.js";
import type { PreflightFailure } from "./subscription.js";

export interface PreflightRecord {
  at: string;
  ok: boolean;
  failure?: PreflightFailure;
}

export interface RunState {
  preflight?: PreflightRecord;
  /** A failed run waiting for the user's choice: retry now or wait for the next cycle. */
  pending?: { since: string; failure: PreflightFailure };
  lastRun?: RunRecord;
  /** Branches main moved past; kept, never resumed. */
  superseded?: { branch: string; at: string }[];
  /** The last run for a user's revert request (`flake-agent revert <upstream-id>`). */
  lastRevert?: RevertRunRecord;
  /** Revert requests already handled, by their `at`: the request file stays (the agent can't delete it). */
  handledReverts?: string[];
}

export class StateStore {
  constructor(readonly dir: string) {}

  get file(): string {
    return join(this.dir, "state.json");
  }

  async load(): Promise<RunState> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as RunState;
    } catch {
      return {};
    }
  }

  async save(state: RunState): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2) + "\n");
    await rename(tmp, this.file);
  }

  async update(fn: (s: RunState) => RunState): Promise<RunState> {
    const next = fn(await this.load());
    await this.save(next);
    return next;
  }
}

/** `STATE_DIRECTORY` (systemd StateDirectory=), else the XDG state dir for manual runs. */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.STATE_DIRECTORY) return env.STATE_DIRECTORY.split(":")[0]!;
  const base = env.XDG_STATE_HOME || join(env.HOME ?? "/tmp", ".local", "state");
  return join(base, "flake-agent");
}
