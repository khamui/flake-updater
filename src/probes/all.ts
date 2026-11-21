import { discoverEnabled, type Target } from "../discovery/discover.js";
import { run } from "../nix/exec.js";
import { nixStore } from "../nix/store.js";
import { DEEP_PROBES } from "./deep/index.js";
import { writeSnapshot } from "./snapshots.js";
import { diffT0, snapshotT0, type Finding } from "./t0.js";
import { diffT1, snapshotT1, type T1Change, type T1Snapshot } from "./t1.js";
import { diffT2, selectStarters, snapshotT2, type T2Snapshot } from "./t2.js";
import { diffT3, selectDeepProbes, snapshotT3 } from "./t3.js";
import { BUILTIN_VALIDATORS, loadCustomValidators, selectValidators } from "./validators.js";

export interface ProbeRun {
  against: string;
  toplevel: string;
  /** Snapshot files written (new side). */
  files: string[];
  t0: Finding[];
  t1: T1Change[];
  /** The T1 snapshots `t1` compares: the run attributes their changes. */
  t1Snapshots: { old: T1Snapshot; new: T1Snapshot };
  t2: Finding[];
  t3: Finding[];
  validators: string[];
  /** Programs given the starts-cleanly check, and those left unchecked (with why). */
  starts: string[];
  unchecked: string[];
  deep: string[];
}

function startsOf(t2: T2Snapshot): { starts: string[]; unchecked: string[] } {
  const all = Object.entries(t2.starts ?? {});
  return {
    starts: all.filter(([, s]) => !("unchecked" in s)).map(([p]) => p),
    unchecked: all.flatMap(([p, s]) => ("unchecked" in s ? [`${p} (${s.unchecked})`] : [])),
  };
}

/**
 * All tiers, old (`against`) vs new (`toplevel`); the new snapshots are written
 * to `<repo>/.flake-agent/snapshots/<host>/`.
 */
export async function probeAll(repo: string, target: Target, against: string, toplevel: string): Promise<ProbeRun> {
  const [oldT0, newT0, oldT1, newT1] = await Promise.all([
    snapshotT0(nixStore, against, target.user),
    snapshotT0(nixStore, toplevel, target.user),
    snapshotT1(nixStore, against, target.user),
    snapshotT1(nixStore, toplevel, target.user),
  ]);

  const enabled = await discoverEnabled(target);
  const programs = new Set(enabled.keys());
  const validators = selectValidators(programs, [...BUILTIN_VALIDATORS, ...(await loadCustomValidators(repo))]);
  const { starters, unchecked } = selectStarters(enabled, validators);
  // sequential: validators start servers (Xvfb, tmux) and must not race
  const oldT2 = await snapshotT2(against, target.user, validators, starters, unchecked);
  const newT2 = await snapshotT2(toplevel, target.user, validators, starters, unchecked);
  const deep = selectDeepProbes(programs, DEEP_PROBES);
  const oldT3 = await snapshotT3(against, target.user, deep);
  const newT3 = await snapshotT3(toplevel, target.user, deep);

  const files = [
    await writeSnapshot(repo, target.host, "t0", newT0),
    await writeSnapshot(repo, target.host, "t1", newT1),
    await writeSnapshot(repo, target.host, "t2", newT2),
    await writeSnapshot(repo, target.host, "t3", newT3),
  ];
  return {
    against,
    toplevel,
    files,
    t0: diffT0(oldT0, newT0),
    // without agent commits there is nothing to attribute T1 changes to
    t1: await diffT1(oldT1, newT1),
    t1Snapshots: { old: oldT1, new: newT1 },
    t2: diffT2(oldT2, newT2),
    t3: diffT3(oldT3, newT3, deep),
    validators: validators.map((v) => v.name),
    ...startsOf(newT2),
    deep: deep.map((p) => p.name),
  };
}

/**
 * Snapshot one system (main's build, when main has no snapshots yet) into
 * `<repo>/.flake-agent/snapshots/<host>/`, so later snapshots have a baseline.
 */
export async function snapshotSystem(repo: string, target: Target, toplevel: string): Promise<string[]> {
  const enabled = await discoverEnabled(target);
  const programs = new Set(enabled.keys());
  const validators = selectValidators(programs, [...BUILTIN_VALIDATORS, ...(await loadCustomValidators(repo))]);
  const { starters, unchecked } = selectStarters(enabled, validators);
  const [t0, t1] = await Promise.all([snapshotT0(nixStore, toplevel, target.user), snapshotT1(nixStore, toplevel, target.user)]);
  const t2 = await snapshotT2(toplevel, target.user, validators, starters, unchecked);
  const t3 = await snapshotT3(toplevel, target.user, selectDeepProbes(programs, DEEP_PROBES));
  return [
    await writeSnapshot(repo, target.host, "t0", t0),
    await writeSnapshot(repo, target.host, "t1", t1),
    await writeSnapshot(repo, target.host, "t2", t2),
    await writeSnapshot(repo, target.host, "t3", t3),
  ];
}

export function probeFailures(r: ProbeRun): Finding[] {
  return [...r.t0, ...r.t2, ...r.t3].filter((f) => f.severity === "fail");
}

export function formatFindings(tier: string, findings: Finding[]): string {
  if (findings.length === 0) return `${tier}: no differences\n`;
  return findings
    .map((f) => {
      const detail = f.detail ? `  ${f.detail.replace(/\n/g, "\n    ")}` : "";
      return `${f.severity === "fail" ? "✗" : "·"} ${f.kind.padEnd(17)} ${f.subject}${detail}`;
    })
    .join("\n") + "\n";
}

/** Human-readable report of a probe run, T1 content diffs last. */
export function formatProbeRun(r: ProbeRun): string {
  let text = `old: ${r.against}\nnew: ${r.toplevel}\nsnapshots: ${r.files.join(", ")}\n\n`;
  text += formatFindings("T0", r.t0);
  text += "\n" + formatFindings("T1", r.t1.map((c) => ({ ...c, detail: "" })));
  for (const c of r.t1) if (c.detail) text += `\n--- ${c.subject}\n${c.detail}\n`;
  text += `\nT2 validators: ${r.validators.join(", ") || "none"}\n`;
  text += `T2 starts cleanly: ${r.starts.join(", ") || "none"}\n`;
  if (r.unchecked.length) text += `T2 unchecked: ${r.unchecked.join(", ")}\n`;
  text += formatFindings("T2", r.t2);
  text += `\nT3 probes: ${r.deep.join(", ") || "none"}\n` + formatFindings("T3", r.t3);
  return text;
}

/** `nvd diff`, or "" when nvd isn't on PATH (running from source). */
export async function nvdDiff(against: string, toplevel: string): Promise<string> {
  try {
    return await run("nvd", ["diff", against, toplevel]);
  } catch {
    return "";
  }
}
