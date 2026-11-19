import { openSandbox } from "./sandbox.js";
import type { Finding } from "./t0.js";
import type { Validator, ValidatorResult } from "./validators.js";

export interface T2Snapshot {
  tier: "T2";
  /** validator name → its errors and warnings, normalised. */
  results: Record<string, ValidatorResult>;
}

/** Messages must compare equal across systems: no scratch HOME or store hashes in them. */
export function normalise(message: string, home: string): string {
  return message.split(home).join("~").replace(/\/nix\/store\/[0-9a-z]{32}-/g, "/nix/store/");
}

/** Run the validators against a system toplevel (live or built) in a scratch HOME. */
export async function snapshotT2(toplevel: string, user: string, validators: Validator[]): Promise<T2Snapshot> {
  const results: T2Snapshot["results"] = {};
  const sb = await openSandbox(toplevel, user);
  try {
    for (const v of validators) {
      const r = await v.run(sb);
      results[v.name] = {
        errors: r.errors.map((m) => normalise(m, sb.home)),
        warnings: r.warnings.map((m) => normalise(m, sb.home)),
      };
    }
  } finally {
    await sb.dispose();
  }
  return { tier: "T2", results };
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
  return findings;
}
