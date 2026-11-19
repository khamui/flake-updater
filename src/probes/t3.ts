import { openSandbox, type Sandbox } from "./sandbox.js";
import type { Finding } from "./t0.js";

/** A built-in deep probe for one tool: captures its behaviour as JSON, diffs two captures. */
export interface DeepProbe<S = unknown> {
  name: string;
  /** `programs.<name>.enable` (NixOS or HM) that turns this probe on. */
  programs: string[];
  snapshot(sb: Sandbox): Promise<S>;
  diff(old: S, next: S): Finding[];
}

export interface T3Snapshot {
  tier: "T3";
  /** probe name → its capture. */
  probes: Record<string, unknown>;
}

export function selectDeepProbes(enabled: Set<string>, probes: DeepProbe<any>[]): DeepProbe<any>[] {
  return probes.filter((p) => p.programs.some((name) => enabled.has(name)));
}

/** Run the deep probes against a system toplevel (live or built) in a scratch HOME. */
export async function snapshotT3(toplevel: string, user: string, probes: DeepProbe<any>[]): Promise<T3Snapshot> {
  const captures: T3Snapshot["probes"] = {};
  const sb = await openSandbox(toplevel, user);
  try {
    for (const probe of probes) captures[probe.name] = await probe.snapshot(sb);
  } finally {
    await sb.dispose();
  }
  return { tier: "T3", probes: captures };
}

/** Diff probes present on both sides; a probe new on one side has nothing to compare against. */
export function diffT3(old: T3Snapshot, next: T3Snapshot, probes: DeepProbe<any>[]): Finding[] {
  return probes.flatMap((p) =>
    p.name in old.probes && p.name in next.probes ? p.diff(old.probes[p.name], next.probes[p.name]) : [],
  );
}

/** Shared diff for name → value maps: removed or changed entries fail, added ones are info. */
export function diffMap(
  old: Record<string, string>,
  next: Record<string, string>,
  what: string,
  subject: (key: string) => string = (k) => k,
): Finding[] {
  const findings: Finding[] = [];
  for (const [key, value] of Object.entries(old)) {
    const now = next[key];
    if (now === undefined) {
      findings.push({ severity: "fail", kind: `${what}-removed`, subject: subject(key), detail: value });
    } else if (now !== value) {
      findings.push({ severity: "fail", kind: `${what}-changed`, subject: subject(key), detail: `${value} → ${now}` });
    }
  }
  for (const [key, value] of Object.entries(next)) {
    if (!(key in old)) findings.push({ severity: "info", kind: `${what}-added`, subject: subject(key), detail: value });
  }
  return findings;
}

/** Shared diff for sets of names. */
export function diffSet(old: string[], next: string[], what: string, removed: "fail" | "info"): Finding[] {
  const before = new Set(old);
  const after = new Set(next);
  return [
    ...old.filter((n) => !after.has(n)).map((n): Finding => ({ severity: removed, kind: `${what}-missing`, subject: n, detail: "" })),
    ...next.filter((n) => !before.has(n)).map((n): Finding => ({ severity: "info", kind: `${what}-added`, subject: n, detail: "" })),
  ];
}
