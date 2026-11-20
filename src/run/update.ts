import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configAttr } from "../discovery/discover.js";
import { capture, run } from "../nix/exec.js";
import { acquireLock } from "../preflight/environment.js";
import { probeAll, probeFailures, type ProbeRun } from "../probes/all.js";
import type { AgentConfig } from "./config.js";
import type { FixOutcome, Verification } from "../agent/loop.js";
import { parseLog, trailerProblems, type ChangeCommit } from "../agent/trailers.js";

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

/** Clone or fetch the user's repo, then branch `agent/update-<date>` (suffixed if taken) off main. */
export async function prepareBranch(cfg: AgentConfig, stateDir: string, now: Date): Promise<{ git: Git; branch: string; base: string }> {
  const dir = cloneDir(stateDir);
  const git = new Git(dir, { name: "flake-agent", email: `flake-agent@${cfg.host}` });
  const upstream = join(cfg.repo, ".git");
  if (!(await exists(join(dir, ".git")))) {
    await run("git", ["-c", "safe.directory=*", "clone", "--no-checkout", upstream, dir]);
  }
  await git.run("fetch", "--prune", upstream, `+refs/heads/${cfg.mainBranch}:refs/remotes/upstream/${cfg.mainBranch}`);
  const base = await git.run("rev-parse", `refs/remotes/upstream/${cfg.mainBranch}`);

  let branch = branchName(now);
  for (let n = 2; await git.exists(`refs/heads/${branch}`); n++) branch = `${branchName(now)}-${n}`;
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
    let toplevel: string | undefined;
    let failing = 0;
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
        return { status: "build-failed", problems: `nix build failed:\n${tail(built.stderr, 25)}` };
      }
      toplevel = built.stdout.trim().split("\n").at(-1)!;
      const probes = await probeAll(dir, target, against, toplevel);
      failing = probeFailures(probes).length;
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
    if (v.status !== "green" && deps.fix) {
      const outcome = await deps.fix(v, { repo: dir, verify: async () => (v = await verify()), head: () => git.run("rev-parse", "HEAD") });
      if (outcome.status === "green") status = "green";
      else if (outcome.status === "upstream-only") {
        // not a failure (SPEC: upstream-only changes): switchable, reported as behaviour changes
        status = "green";
        behaviourChanges = outcome.problems.split("\n").filter(Boolean);
      }
      else if (outcome.status === "interrupted") {
        status = "interrupted";
        detail = outcome.failure.message;
      } else {
        status = "blocked";
        detail = tail(outcome.problems, 3);
      }
    } else if (v.status === "build-failed") {
      detail = tail(v.problems, 1);
    }

    let changes: ChangeCommit[] = [];
    if (deps.fix) {
      changes = parseLog(await git.run("log", "--reverse", "--format=%H%x00%B%x01", `${lockCommit}..HEAD`)).filter((c) => !c.subject.startsWith("snapshots: "));
      const issues = trailerProblems(changes);
      if (issues.length && status === "green") {
        // an unlabelled change can't be reported or reverted: a human has to look
        status = "blocked";
        detail = issues.join("; ");
      }
    }

    const commit = await git.run("rev-parse", "HEAD");
    if (status === "green") {
      const req: SwitchRequest = { commit, branch, at, base };
      await writeFile(requestPath(stateDir), JSON.stringify(req) + "\n");
    }
    deps.out(`${branch} ${commit.slice(0, 12)}: ${status}\n`);
    return {
      at,
      status,
      base,
      branch,
      commit,
      lockCommit,
      ...(toplevel ? { toplevel } : {}),
      updatedInputs: inputs,
      failures: failing,
      changes: changes.map((c) => ({ sha: c.sha, subject: c.subject, id: c.trailers["Change-Id"], class: c.trailers["Change-Class"] })),
      ...(detail ? { detail } : {}),
      ...(behaviourChanges ? { behaviourChanges } : {}),
    };
  } finally {
    await release();
  }
}
