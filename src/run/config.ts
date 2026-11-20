import { readFile } from "node:fs/promises";
import { DEFAULT_SELF_INPUT, type WriteScope } from "../guard/structure.js";
import { DEFAULT_ESCALATION_MODEL, DEFAULT_MODEL } from "../preflight/subscription.js";

/** What the NixOS module writes to the agent's config file; every field has a CLI default. */
export interface AgentConfig {
  /** The user's config repo; the agent fetches from `<repo>/.git` (bind-mounted read-only). */
  repo: string;
  host: string;
  user: string;
  mainBranch: string;
  model: string;
  escalationModel: string;
  maxFixIterations: number;
  diffLimit: number;
  minFreeGB: number;
  selfInput: string;
  writeScope: WriteScope;
  /** Live system the probes compare against. */
  against: string;
  /** A live switch waits for this much user idle time... */
  idleMinutes: number;
  /** ...for at most this long, then only the boot entry is set. */
  idleFallbackHours: number;
}

export const DEFAULTS: Omit<AgentConfig, "repo" | "host" | "user"> = {
  mainBranch: "main",
  model: DEFAULT_MODEL,
  escalationModel: DEFAULT_ESCALATION_MODEL,
  maxFixIterations: 3,
  diffLimit: 60,
  minFreeGB: 10,
  selfInput: DEFAULT_SELF_INPUT,
  writeScope: { allow: [], deny: [] },
  against: "/run/current-system",
  idleMinutes: 15,
  idleFallbackHours: 24,
};

export async function loadConfig(path: string | undefined, overrides: Partial<AgentConfig>): Promise<AgentConfig> {
  const file = path ? (JSON.parse(await readFile(path, "utf8")) as Partial<AgentConfig>) : {};
  const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
  const cfg = { ...DEFAULTS, ...file, ...defined } as AgentConfig;
  for (const key of ["repo", "host", "user"] as const) {
    if (!cfg[key]) throw new Error(`config: ${key} is required`);
  }
  return cfg;
}
