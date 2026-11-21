import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configAttr } from "../discovery/discover.js";
import { capture, run } from "../nix/exec.js";
import { acquireLock } from "../preflight/environment.js";
import { probeAll, probeFailures, snapshotSystem, type ProbeRun } from "../probes/all.js";
import { upstreamT1, type T1Snapshot } from "../probes/t1.js";
import { changesEntry, prependEntry, runUpstream } from "../report/report.js";
import { upstreamNotes, upstreamNotesPath } from "../report/upstream.js";
import type { AgentConfig } from "./config.js";
import type { FixOutcome, Verification } from "../agent/loop.js";
import { parseLog, trailerProblems, type ChangeCommit } from "../agent/trailers.js";
import { changeDir, withPatched } from "../agent/keepold.js";
import { previousRef } from "./pin.js";
import type { Target } from "../discovery/discover.js";

export type RunStatus = "up-to-date" | "build-failed" | "probes-red" | "green" | "locked" | "blocked" | "interrupted";

export interface RunRecord {
  at: string;
  status: RunStatus;
  branch?: string;
  commit?: string;
  toplevel?: string;
  updatedInputs?: string[];
  failures?: number;
  detail?: string;
  lockCommit?: string;
  /** Upstream-only findings left as they are (not failures), for the report. */
  behaviourChanges?: string[];
  /** Generated files only the new lock changed (T1, upstream-only), `- <kind> <file>`. */
  upstreamFiles?: string[];
  /** Inputs kept at their previous revision because they are broken upstream. */
  pinned?: string[];
  /** Each behaviour change's way back, built and probed on the final commit. */
  keepOld?: KeepOldResult[];
  changes?: { sha: string; subject: string; id?: string; class?: string }[];
  /** main when the run branched. */
  base?: string;
}

/**
 * An earlier run's branch that main has moved past: it is kept for inspection but
 * never resumed or switched (the new run starts over from the new main).
 */
export function superseded(previous: RunRecord | undefined, next: RunRecord): string | undefined {
  if (!previous?.branch || !previous.base || !next.base) return undefined;
  return previous.base !== next.base ? previous.branch : undefined;
}

/** Written by the agent after a green run; the switch service re-checks everything in it. */
export interface SwitchRequest {
  commit: string;
  branch: string;
  at: string;
  /** main when the run branched. */
  base?: string;
}

export const requestPath = (stateDir: string) => join(stateDir, "switch-request.json");

/** The agent's own clone, inside its state dir. */
export const cloneDir = (stateDir: string) => join(stateDir, "repo");

/** Root inputs of a flake.lock, except the tool itself: it is only ever updated by hand. */
export function inputsToUpdate(lockText: string, selfInput: string): string[] {
  const lock = JSON.parse(lockText) as { root: string; nodes: Record<string, { inputs?: Record<string, unknown> }> };
  return Object.keys(lock.nodes[lock.root]?.inputs ?? {})
    .filter((name) => name !== selfInput)
    .sort();
}

export function branchName(date: Date): string {
  const d = date.toISOString().slice(0, 10);
  return `agent/update-${d}`;
}

export class Git {
  constructor(
    readonly dir: string,
    readonly identity: { name: string; email: string },
  ) {}

  /** The upstream .git belongs to the user, not the agent: trust it explicitly. */
  run(...args: string[]): Promise<string> {
    return run("git", [
      "-c", "safe.directory=*",
      "-c", `user.name=${this.identity.name}`,
      "-c", `user.email=${this.identity.email}`,
      "-C", this.dir,
      ...args,
    ]).then((s) => s.trim());
  }

  async exists(ref: string): Promise<boolean> {
    return (await capture("git", ["-c", "safe.directory=*", "-C", this.dir, "rev-parse", "--verify", "--quiet", ref])).code === 0;
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** Clone or fetch the user's repo, then branch `name` (default `agent/update-<date>`; suffixed if taken) off main. */
export async function prepareBranch(cfg: AgentConfig, stateDir: string, now: Date, name = branchName(now)): Promise<{ git: Git; branch: string; base: string }> {
  const dir = cloneDir(stateDir);
  const git = new Git(dir, { name: "flake-agent", email: `flake-agent@${cfg.host}` });
  const upstream = join(cfg.repo, ".git");
  if (!(await exists(join(dir, ".git")))) {
    await run("git", ["-c", "safe.directory=*", "clone", "--no-checkout", upstream, dir]);
  }
  await git.run("fetch", "--prune", upstream, `+refs/heads/${cfg.mainBranch}:refs/remotes/upstream/${cfg.mainBranch}`);
  const base = await git.run("rev-parse", `refs/remotes/upstream/${cfg.mainBranch}`);

  let branch = name;
  for (let n = 2; await git.exists(`refs/heads/${branch}`); n++) branch = `${name}-${n}`;
  await git.run("checkout", "--force", "-B", branch, base);
  // commits the agent makes itself carry the same identity
  await git.run("config", "user.name", git.identity.name);
  await git.run("config", "user.email", git.identity.email);
  await git.run("clean", "-fdx");
  return { git, branch, base };
}

export interface UpdateDeps {
  out: (text: string) => void;
  now?: Date;
  /** The AI fix loop; absent = AI-free run (build and probe only). */
  fix?: (verification: Verification, ctx: { repo: string; verify: () => Promise<Verification>; head: () => Promise<string> }) => Promise<FixOutcome>;
}

function summary(r: ProbeRun): string {
  const count = (tier: string, f: { severity: string }[]) =>
    `${tier}: ${f.filter((x) => x.severity === "fail").length} failing, ${f.length} total`;
  return [count("T0", r.t0), `T1: ${r.t1.length} changed files`, count("T2", r.t2), count("T3", r.t3)].join("\n");
}

function problems(r: ProbeRun): string {
  return probeFailures(r)
    .map((f) => `- ${f.kind} ${f.subject}${f.detail ? `: ${f.detail.split("\n")[0]}` : ""}`)
    .join("\n");
}

const tail = (text: string, n: number) => text.trim().split("\n").slice(-n).join("\n");

/** `against: "base"`: the system built from main before the update. */
async function baseline(cfg: AgentConfig, git: Git, base: string): Promise<string> {
  if (cfg.against !== "base") return cfg.against;
  const built = await capture(
    "nix",
    ["build", "--no-link", "--print-out-paths", `git+file://${git.dir}?rev=${base}#nixosConfigurations.${cfg.host}.config.system.build.toplevel`],
    { env: process.env as Record<string, string>, timeoutMs: 50 * 60_000 },
  );
  if (built.code !== 0) throw new Error(`main itself does not build:\n${tail(built.stderr, 10)}`);
  return built.stdout.trim().split("\n").at(-1)!;
}

/**
 * One update run: lock update (self input excluded) committed first, build and
 * all probes, then — with an agent — the fix loop, one commit per change.
 * Green → a switch request for the switch service.
 */
export async function updateRun(cfg: AgentConfig, stateDir: string, deps: UpdateDeps): Promise<RunRecord> {
  const now = deps.now ?? new Date();
  const at = now.toISOString();
  const release = await acquireLock(stateDir);
  if (!release) {
    deps.out("Another run holds the lock; not starting.\n");
    return { at, status: "locked", detail: "another run holds the lock" };
  }
  try {
    const { git, branch, base } = await prepareBranch(cfg, stateDir, now);
    const dir = git.dir;
    const against = await baseline(cfg, git, base);
    const inputs = inputsToUpdate(await readFile(join(dir, "flake.lock"), "utf8"), cfg.selfInput);
    deps.out(`Updating ${inputs.join(", ")} on ${branch}\n`);
    await run("nix", ["flake", "update", "--flake", dir, ...inputs]);

    if ((await git.run("status", "--porcelain", "flake.lock")) === "") {
      await git.run("checkout", "--detach");
      await git.run("branch", "-D", branch);
      deps.out("Already up to date.\n");
      return { at, status: "up-to-date", updatedInputs: [], base };
    }
    await git.run("add", "flake.lock");
    await git.run("commit", "-m", `flake.lock: update ${inputs.join(", ")}`);
    const lockCommit = await git.run("rev-parse", "HEAD");

    const target = { flake: dir, host: cfg.host, user: cfg.user };
    if (!(await git.run("ls-tree", "--name-only", base, `.flake-agent/snapshots/${cfg.host}/t3.json`))) {
      // first run: `show <id>` diffs each change against the snapshots before it
      await snapshotSystem(dir, target, against);
      await git.run("add", ".flake-agent/snapshots");
      await git.run("commit", "-q", "-m", `snapshots: baseline from ${base.slice(0, 12)}`);
    }
    let toplevel: string | undefined;
    let failing = 0;
    /** The latest probes, and T1 of the latest build with no agent commit on the lock. */
    let probed: ProbeRun | undefined;
    let lockT1: T1Snapshot | undefined;
    /** Build HEAD (uncommitted edits discarded), probe, commit the snapshots. */
    const verify = async (): Promise<Verification> => {
      await git.run("reset", "-q", "--hard", "HEAD");
      await git.run("clean", "-fdq");
      const built = await capture("nix", ["build", "--no-link", "--print-out-paths", configAttr(target, "config.system.build.toplevel")], {
        env: process.env as Record<string, string>,
        timeoutMs: 50 * 60_000,
      });
      if (built.code !== 0) {
        toplevel = undefined;
        probed = undefined;
        return { status: "build-failed", problems: `nix build failed:\n${tail(built.stderr, 25)}` };
      }
      toplevel = built.stdout.trim().split("\n").at(-1)!;
      const probes = await probeAll(dir, target, against, toplevel);
      failing = probeFailures(probes).length;
      probed = probes;
      const since = (await git.run("log", "--format=%s", `${lockCommit}..HEAD`)).split("\n").filter(Boolean);
      if (since.every((s) => s.startsWith("snapshots: ") || s.startsWith("flake.lock: "))) lockT1 = probes.t1Snapshots.new;
      await git.run("add", ".flake-agent/snapshots");
      if ((await git.run("status", "--porcelain", ".flake-agent/snapshots")) !== "") {
        await git.run("commit", "-q", "-m", `snapshots: probes on ${(await git.run("rev-parse", "--short", "HEAD"))}\n\n${summary(probes)}`);
      }
      return failing ? { status: "probes-red", problems: problems(probes) } : { status: "green", problems: "" };
    };

    let v = await verify();
    deps.out(`${branch}: ${v.status}\n`);
    let status: RunStatus = v.status;
    let detail: string | undefined;
    let behaviourChanges: string[] | undefined;
    let pinned: string[] | undefined;
    const ctx = { repo: dir, verify: async () => (v = await verify()), head: () => git.run("rev-parse", "HEAD") };
    /** Map a fix-loop outcome onto the run's status. */
    const settle = (outcome: FixOutcome): void => {
      if (outcome.status === "green") {
        status = "green";
        detail = undefined;
      } else if (outcome.status === "upstream-only") {
        // not a failure (SPEC: upstream-only changes): switchable, reported as behaviour changes
        status = "green";
        detail = undefined;
        behaviourChanges = outcome.problems.split("\n").filter(Boolean);
      } else if (outcome.status === "interrupted") {
        status = "interrupted";
        detail = outcome.failure.message;
      } else {
        status = "blocked";
        detail = tail(outcome.problems, 3);
      }
    };

    if (v.status !== "green" && deps.fix) {
      const outcome = await deps.fix(v, ctx);
      settle(outcome);
      if (outcome.status === "blocked") {
        // partial update: keep one input at its previous revision, update the rest
        const baseLock = await git.run("show", `${base}:flake.lock`);
        // the inputs the agent named as broken upstream first: each try is a full build
        const named = outcome.blockedInputs.filter((i) => inputs.includes(i));
        for (const input of [...named, ...inputs.filter((i) => !named.includes(i))]) {
          const prev = previousRef(baseLock, input);
          if (!prev) continue;
          // an agent commit's flake.nix may not even lock (an input that can't be fetched): that try failed
          const locked = await capture("nix", ["flake", "lock", dir, "--override-input", input, prev], { env: process.env as Record<string, string> });
          if (locked.code !== 0) {
            await git.run("checkout", "--", "flake.lock");
            continue;
          }
          if ((await git.run("status", "--porcelain", "flake.lock")) === "") continue;
          await git.run("add", "flake.lock");
          await git.run("commit", "-q", "-m", pinMessage(input, prev, outcome.problems, now));
          const pin = await git.run("rev-parse", "HEAD");
          deps.out(`Trying ${input} at its previous revision\n`);
          const after = await ctx.verify();
          if (after.status === "build-failed") {
            await git.run("reset", "-q", "--hard", `${pin}^`);
            continue;
          }
          pinned = [input];
          if (after.status === "green") settle({ status: "green", iterations: 0 });
          // builds now: what the probes report is new to the agent, so it gets another pass
          else settle(await deps.fix(after, ctx));
          break;
        }
      }
    } else if (v.status === "build-failed") {
      detail = tail(v.problems, 1);
    }

    let changes: ChangeCommit[] = [];
    const keepOld: KeepOldResult[] = [];
    if (deps.fix) {
      changes = parseLog(await git.run("log", "--reverse", "--format=%H%x00%B%x01", `${lockCommit}..HEAD`)).filter((c) => !c.subject.startsWith("snapshots: "));
      const issues = trailerProblems(changes);
      for (const change of changes.filter((c) => c.trailers["Change-Class"] === "behaviour")) {
        const id = change.trailers["Change-Id"]!;
        if (keepOld.some((k) => k.id === id)) continue;
        keepOld.push(await verifyKeepOld(dir, id, target, against, behaviourChanges ?? []));
      }
      for (const k of keepOld) {
        if (!k.builds || !k.probesGreen) issues.push(`keep-old.patch for ${k.id}: ${k.problem}`);
      }
      if (issues.length && status === "green") {
        // an unlabelled change can't be reported or reverted: a human has to look
        status = "blocked";
        detail = issues.join("; ");
      }
    }

    // generated files the new lock alone changed: only known when both builds were probed
    const files = probed && lockT1 ? await upstreamT1(probed.t1Snapshots.old, lockT1, probed.t1Snapshots.new) : [];
    const upstreamFiles = files.map((c) => `- ${c.kind} ${c.subject}`);
    const diffs = new Map(files.map((c) => [`${c.kind} ${c.subject}`, c.detail]));

    const record: RunRecord = {
      at,
      status,
      base,
      branch,
      lockCommit,
      ...(toplevel ? { toplevel } : {}),
      updatedInputs: inputs,
      failures: failing,
      changes: changes.map((c) => ({ sha: c.sha, subject: c.subject, id: c.trailers["Change-Id"], class: c.trailers["Change-Class"] })),
      ...(detail ? { detail } : {}),
      ...(behaviourChanges ? { behaviourChanges } : {}),
      ...(upstreamFiles.length ? { upstreamFiles } : {}),
      ...(pinned ? { pinned } : {}),
      ...(keepOld.length ? { keepOld } : {}),
    };

    // the run's entry on top of CHANGES.md: it reaches main with the handoff
    const changesFile = join(dir, ".flake-agent", "CHANGES.md");
    await mkdir(dirname(changesFile), { recursive: true });
    await writeFile(changesFile, prependEntry(await readFile(changesFile, "utf8").catch(() => undefined), changesEntry(record)));
    await git.run("add", ".flake-agent/CHANGES.md");
    // upstream-only findings have no commit of their own: `show <id>` reads these
    for (const f of runUpstream(record)) {
      const notes = join(dir, upstreamNotesPath(f.id));
      await mkdir(dirname(notes), { recursive: true });
      await writeFile(notes, upstreamNotes(f, record, diffs.get(f.finding)));
      await git.run("add", upstreamNotesPath(f.id));
    }
    await git.run("commit", "-q", "-m", `CHANGES.md: ${branch} (${status})`);

    const commit = await git.run("rev-parse", "HEAD");
    if (status === "green") {
      const req: SwitchRequest = { commit, branch, at, base };
      await writeFile(requestPath(stateDir), JSON.stringify(req) + "\n");
    }
    deps.out(`${branch} ${commit.slice(0, 12)}: ${status}\n`);
    return { ...record, commit };
  } finally {
    await release();
  }
}

export interface KeepOldResult {
  id: string;
  builds: boolean;
  probesGreen: boolean;
  problem?: string;
}

/** Probe findings not among the upstream-only ones the run already accepted. */
export function newFindings(found: string, accepted: string[]): string[] {
  return found.split("\n").filter((l) => l && !accepted.includes(l));
}

/**
 * Apply a behaviour change's keep-old.patch to HEAD in a scratch worktree, build
 * and probe it. Upstream-only findings show up on every tree; anything else is red.
 */
async function verifyKeepOld(dir: string, id: string, target: Target, against: string, accepted: string[]): Promise<KeepOldResult> {
  const patch = join(changeDir(dir, id), "keep-old.patch");
  if (!(await exists(patch))) return { id, builds: false, probesGreen: false, problem: "missing" };
  try {
    return await withPatched(dir, "HEAD", patch, async (wt) => {
      const t = { ...target, flake: wt };
      const built = await capture("nix", ["build", "--no-link", "--print-out-paths", configAttr(t, "config.system.build.toplevel")], {
        env: process.env as Record<string, string>,
        timeoutMs: 50 * 60_000,
      });
      if (built.code !== 0) return { id, builds: false, probesGreen: false, problem: `does not build: ${tail(built.stderr, 1)}` };
      const probes = await probeAll(wt, t, against, built.stdout.trim().split("\n").at(-1)!);
      const failing = newFindings(problems(probes), accepted);
      return failing.length
        ? { id, builds: true, probesGreen: false, problem: failing[0] }
        : { id, builds: true, probesGreen: true };
    });
  } catch (err) {
    return { id, builds: false, probesGreen: false, problem: (err as Error).message };
  }
}

export function pinMessage(input: string, ref: string, why: string, now: Date): string {
  return [
    `flake.lock: keep ${input} at its previous revision`,
    "",
    `${input} is broken upstream in a way the configuration cannot work around:`,
    tail(why, 5),
    "",
    `The rest of the update goes ahead; ${input} stays at ${ref}.`,
    "",
    `Change-Id: pin-${input.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${now.toISOString().slice(0, 7)}`,
    "Change-Class: blocked",
    `Upstream: ${ref}`,
  ].join("\n");
}
