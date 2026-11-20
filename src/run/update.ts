import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configAttr } from "../discovery/discover.js";
import { capture, run } from "../nix/exec.js";
import { acquireLock } from "../preflight/environment.js";
import { probeAll, probeFailures, type ProbeRun } from "../probes/all.js";
import type { AgentConfig } from "./config.js";

export type RunStatus = "up-to-date" | "build-failed" | "probes-red" | "green" | "locked";

export interface RunRecord {
  at: string;
  status: RunStatus;
  branch?: string;
  commit?: string;
  toplevel?: string;
  updatedInputs?: string[];
  failures?: number;
  detail?: string;
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
  await git.run("clean", "-fdx");
  return { git, branch, base };
}

export interface UpdateDeps {
  out: (text: string) => void;
  now?: Date;
}

function summary(r: ProbeRun): string {
  const count = (tier: string, f: { severity: string }[]) =>
    `${tier}: ${f.filter((x) => x.severity === "fail").length} failing, ${f.length} total`;
  return [count("T0", r.t0), `T1: ${r.t1.length} changed files`, count("T2", r.t2), count("T3", r.t3)].join("\n");
}

/**
 * One AI-free update run: lock update (self input excluded), build, all probes,
 * and one commit with the lock and the new snapshots on agent/update-<date>.
 */
export async function updateRun(cfg: AgentConfig, stateDir: string, deps: UpdateDeps): Promise<RunRecord> {
  const now = deps.now ?? new Date();
  const at = now.toISOString();
  const release = await acquireLock(stateDir);
  if (!release) return { at, status: "locked", detail: "another run holds the lock" };
  try {
    const { git, branch, base } = await prepareBranch(cfg, stateDir, now);
    const dir = git.dir;
    const inputs = inputsToUpdate(await readFile(join(dir, "flake.lock"), "utf8"), cfg.selfInput);
    deps.out(`Updating ${inputs.join(", ")} on ${branch}\n`);
    await run("nix", ["flake", "update", "--flake", dir, ...inputs]);

    if ((await git.run("status", "--porcelain", "flake.lock")) === "") {
      await git.run("checkout", "--detach");
      await git.run("branch", "-D", branch);
      deps.out("Already up to date.\n");
      return { at, status: "up-to-date", updatedInputs: [], base };
    }

    const target = { flake: dir, host: cfg.host, user: cfg.user };
    const built = await capture("nix", ["build", "--no-link", "--print-out-paths", configAttr(target, "config.system.build.toplevel")], {
      env: process.env as Record<string, string>,
      timeoutMs: 50 * 60_000,
    });
    if (built.code !== 0) {
      await git.run("add", "flake.lock");
      await git.run("commit", "-m", `flake.lock: update ${inputs.join(", ")}\n\nBuild failed:\n${built.stderr.trim().split("\n").slice(-15).join("\n")}`);
      deps.out(`Build failed on ${branch}.\n`);
      return { at, status: "build-failed", base, branch, commit: await git.run("rev-parse", "HEAD"), updatedInputs: inputs, detail: built.stderr.trim().split("\n").at(-1) };
    }
    const toplevel = built.stdout.trim().split("\n").at(-1)!;

    const probes = await probeAll(dir, target, cfg.against, toplevel);
    const failures = probeFailures(probes);
    await git.run("add", "flake.lock", ".flake-agent/snapshots");
    await git.run("commit", "-m", `flake.lock: update ${inputs.join(", ")}\n\n${summary(probes)}`);
    const commit = await git.run("rev-parse", "HEAD");
    deps.out(`${branch} ${commit.slice(0, 12)}: ${failures.length ? `${failures.length} probe failures` : "probes green"}\n`);
    if (!failures.length) {
      const req: SwitchRequest = { commit, branch, at, base };
      await writeFile(requestPath(stateDir), JSON.stringify(req) + "\n");
    }
    return {
      at,
      status: failures.length ? "probes-red" : "green",
      base,
      branch,
      commit,
      toplevel,
      updatedInputs: inputs,
      failures: failures.length,
    };
  } finally {
    await release();
  }
}
