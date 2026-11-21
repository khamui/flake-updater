import { openSandbox, type Sandbox } from "./sandbox.js";
import type { Finding } from "./t0.js";
import { lines, type Validator, type ValidatorResult } from "./validators.js";

export interface T2Snapshot {
  tier: "T2";
  /** validator name → its errors and warnings, normalised. */
  results: Record<string, ValidatorResult>;
  /** program → how `<binary> --version` went (starts-cleanly check), or why it wasn't run. */
  starts?: Record<string, Start>;
}

/** An enabled program without a validator whose package names its binary (`meta.mainProgram`). */
export interface Starter {
  program: string;
  bin: string;
}

/** `missing`: the system doesn't have the binary (a program enabled since): no baseline, not unchecked. */
export type Start = { code: number; stderr: string[] } | { unchecked: string; missing?: true };

export const START_TIMEOUT_MS = 5_000;

/** GLib and friends prefix PIDs and timestamps (`(process:326133) … 15:16:17.645`): numbers don't count. */
export const stableLine = (line: string) => line.replace(/\d+/g, "N");

/**
 * Enabled programs no validator covers (built-in and custom ones take
 * precedence): a starts-cleanly check for those with an obvious binary, the
 * rest unchecked (SPEC: coverage follows the config).
 */
export function selectStarters(enabled: Map<string, string | null>, validators: Validator[]): { starters: Starter[]; unchecked: Record<string, string> } {
  const covered = new Set(validators.flatMap((v) => v.programs));
  const starters: Starter[] = [];
  const unchecked: Record<string, string> = {};
  for (const [program, bin] of [...enabled].sort(([a], [b]) => a.localeCompare(b))) {
    if (covered.has(program)) continue;
    if (bin && /^[\w.+-]+$/.test(bin)) starters.push({ program, bin });
    else unchecked[program] = "no obvious binary";
  }
  return { starters, unchecked };
}

/**
 * `<bin> --version` with the user's rendered config in the sandbox HOME. A
 * binary that hangs (or leaves something holding its output open) is given up
 * on after the timeout: unchecked, never failed.
 */
export async function runStarter(sb: Sandbox, s: Starter, timeoutMs = START_TIMEOUT_MS): Promise<Start> {
  const found = await sb.exec("sh", ["-c", 'command -v "$1"', "sh", s.bin]);
  if (found.code !== 0) return { unchecked: `${s.bin} not installed`, missing: true };
  const timedOut = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs + 2_000).unref());
  const r = await Promise.race([sb.exec(s.bin, ["--version"], { timeoutMs }), timedOut]);
  if (r === "timeout" || r.code === 124) return { unchecked: `${s.bin} --version timed out after ${timeoutMs / 1000} s` };
  return { code: r.code, stderr: lines(r.stderr).map((m) => stableLine(normalise(m, sb.home))) };
}

/** Messages must compare equal across systems: no scratch HOME or store hashes in them. */
export function normalise(message: string, home: string): string {
  return message.split(home).join("~").replace(/\/nix\/store\/[0-9a-z]{32}-/g, "/nix/store/");
}

/** Run the validators against a system toplevel (live or built) in a scratch HOME. */
export async function snapshotT2(
  toplevel: string,
  user: string,
  validators: Validator[],
  starters: Starter[] = [],
  unchecked: Record<string, string> = {},
): Promise<T2Snapshot> {
  const results: T2Snapshot["results"] = {};
  const starts: Record<string, Start> = Object.fromEntries(Object.entries(unchecked).map(([p, why]) => [p, { unchecked: why }]));
  const sb = await openSandbox(toplevel, user);
  try {
    for (const v of validators) {
      const r = await v.run(sb);
      results[v.name] = {
        errors: r.errors.map((m) => normalise(m, sb.home)),
        warnings: r.warnings.map((m) => normalise(m, sb.home)),
      };
    }
    for (const s of starters) starts[s.program] = await runStarter(sb, s);
  } finally {
    await sb.dispose();
  }
  return { tier: "T2", results, ...(Object.keys(starts).length ? { starts } : {}) };
}

/** Fails on any error, and on any warning the old system didn't have. */
export function diffT2(old: T2Snapshot, next: T2Snapshot): Finding[] {
  const findings: Finding[] = [];
  for (const [name, result] of Object.entries(next.results)) {
    const known = new Set(old.results[name]?.warnings ?? []);
    for (const error of result.errors) {
      findings.push({ severity: "fail", kind: "validator-error", subject: name, detail: error });
    }
    for (const warning of result.warnings) {
      if (!known.has(warning)) findings.push({ severity: "fail", kind: "validator-warning", subject: name, detail: warning });
    }
  }
  findings.push(...diffStarts(old.starts ?? {}, next.starts ?? {}));
  return findings;
}

/**
 * Starts-cleanly: fails when a program that started cleanly before (or is new)
 * now exits non-zero, and on stderr lines it didn't print before. Unchecked on
 * either side: nothing to compare.
 */
export function diffStarts(old: Record<string, Start>, next: Record<string, Start>): Finding[] {
  const findings: Finding[] = [];
  for (const [program, now] of Object.entries(next)) {
    if ("unchecked" in now) continue;
    const known = old[program];
    const before = known && "unchecked" in known ? undefined : known;
    if (known && "unchecked" in known && !known.missing) continue;
    if (now.code !== 0 && (!before || before.code === 0)) {
      findings.push({ severity: "fail", kind: "start-failed", subject: program, detail: `--version exited with ${now.code}${now.stderr[0] ? `: ${now.stderr[0]}` : ""}` });
    }
    if (!before) continue;
    const printed = new Set(before.stderr);
    for (const line of now.stderr) {
      if (!printed.has(line)) findings.push({ severity: "fail", kind: "start-stderr", subject: program, detail: line });
    }
  }
  return findings;
}
