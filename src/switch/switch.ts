import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { capture, run } from "../nix/exec.js";
import { runGuard, type GuardResult } from "../guard/guard.js";
import type { AgentConfig } from "../run/config.js";
import { cloneDir, requestPath, type SwitchRequest } from "../run/update.js";
import { SYSTEM_PROFILE, listGenerations } from "./generations.js";

export type Mode = "switch" | "boot";

export interface SwitchRecord {
  at: string;
  commit: string;
  branch: string;
  result: "switched" | "needs-review" | "build-failed" | "activation-failed" | "dry-run" | "error";
  mode?: Mode;
  /** System generations before and after. */
  from?: number;
  to?: number;
  toplevel?: string;
  reasons?: string[];
  detail?: string;
}

async function resolved(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

/** `boot` when the kernel, initrd or systemd changes: those only take effect on reboot. */
export async function decideMode(current: string, next: string): Promise<Mode> {
  for (const part of ["kernel", "initrd", "systemd"]) {
    if ((await resolved(join(current, part))) !== (await resolved(join(next, part)))) return "boot";
  }
  return "switch";
}

export async function readRequest(agentStateDir: string): Promise<SwitchRequest | undefined> {
  try {
    const req = JSON.parse(await readFile(requestPath(agentStateDir), "utf8")) as Partial<SwitchRequest>;
    if (typeof req.commit !== "string" || !/^[0-9a-f]{40}$/.test(req.commit)) return undefined;
    if (typeof req.branch !== "string" || !/^agent\/[\w./-]+$/.test(req.branch)) return undefined;
    return { commit: req.commit, branch: req.branch, at: String(req.at ?? "") };
  } catch {
    return undefined;
  }
}

const git = (dir: string, ...args: string[]) => run("git", ["-c", "safe.directory=*", "-C", dir, ...args]).then((s) => s.trim());

/**
 * The switch service's own repository (root-owned): `main` straight from the
 * user's repo, the candidate commit fetched from the agent's clone. The agent
 * controls nothing here, so it can't move the guard's baseline.
 */
export async function syncRepo(cfg: AgentConfig, agentStateDir: string, switchStateDir: string, req: SwitchRequest): Promise<string> {
  const repo = join(switchStateDir, "repo.git");
  await mkdir(switchStateDir, { recursive: true });
  try {
    await git(repo, "rev-parse", "--git-dir");
  } catch {
    await run("git", ["init", "-q", "--bare", repo]);
  }
  await git(repo, "fetch", "-q", join(cfg.repo, ".git"), `+refs/heads/${cfg.mainBranch}:refs/heads/main`);
  await git(repo, "fetch", "-q", cloneDir(agentStateDir), `+refs/heads/${req.branch}:refs/candidates/${req.branch}`);
  await git(repo, "cat-file", "-e", `${req.commit}^{commit}`);
  return repo;
}

export interface SwitchDeps {
  guard: (repo: string, rev: string) => Promise<GuardResult>;
  build: (repo: string, rev: string) => Promise<{ ok: boolean; toplevel?: string; error?: string }>;
  apply: (toplevel: string, mode: Mode) => Promise<{ ok: boolean; error?: string }>;
  current: string;
  out: (text: string) => void;
}

export function realDeps(cfg: AgentConfig, out: (t: string) => void): SwitchDeps {
  return {
    guard: (repo, rev) =>
      runGuard({
        repo,
        host: cfg.host,
        user: cfg.user,
        rev,
        mainRef: "main",
        writeScope: cfg.writeScope,
        diffLimit: cfg.diffLimit,
        selfInput: cfg.selfInput,
      }),
    async build(repo, rev) {
      const ref = `git+file://${repo}?rev=${rev}#nixosConfigurations.${cfg.host}.config.system.build.toplevel`;
      const r = await capture("nix", ["build", "--no-link", "--print-out-paths", ref], {
        env: process.env as Record<string, string>,
        timeoutMs: 3 * 3600_000,
      });
      return r.code === 0
        ? { ok: true, toplevel: r.stdout.trim().split("\n").at(-1) }
        : { ok: false, error: r.stderr.trim().split("\n").slice(-5).join("\n") };
    },
    async apply(path, mode) {
      // nix-env --set given a path inside a store path (a symlink) would set the containing one
      const toplevel = await realpath(path);
      await run("nix-env", ["-p", SYSTEM_PROFILE, "--set", toplevel]);
      const r = await capture(join(toplevel, "bin", "switch-to-configuration"), [mode], {
        env: process.env as Record<string, string>,
        timeoutMs: 3600_000,
      });
      if (r.code === 0) return { ok: true };
      // back to the previous generation
      await run("nix-env", ["-p", SYSTEM_PROFILE, "--rollback"]);
      await capture(join(SYSTEM_PROFILE, "bin", "switch-to-configuration"), ["switch"], {
        env: process.env as Record<string, string>,
        timeoutMs: 3600_000,
      });
      return { ok: false, error: r.stderr.trim().split("\n").slice(-5).join("\n") };
    },
    current: "/run/current-system",
    out,
  };
}

/**
 * Guard → build → switch|boot for the agent's requested commit. Nothing the
 * agent wrote besides the commit id is trusted: the guard runs here, on the
 * exact commit, against main from the user's own repo.
 */
export async function switchCommit(
  repo: string,
  req: SwitchRequest,
  deps: SwitchDeps,
  opts: { dryRun?: boolean } = {},
): Promise<SwitchRecord> {
  const base = { at: new Date().toISOString(), commit: req.commit, branch: req.branch };
  const verdict = await deps.guard(repo, req.commit);
  if (verdict.verdict !== "pass") {
    deps.out(`Needs review: guard blocked ${req.commit.slice(0, 12)}\n${verdict.reasons.map((r) => `  ${r}\n`).join("")}`);
    return { ...base, result: "needs-review", reasons: verdict.reasons };
  }

  const built = await deps.build(repo, req.commit);
  if (!built.ok || !built.toplevel) {
    deps.out(`Build failed for ${req.commit.slice(0, 12)}\n`);
    return { ...base, result: "build-failed", detail: built.error };
  }
  const mode = await decideMode(deps.current, built.toplevel);
  const from = (await listGenerations(SYSTEM_PROFILE).catch(() => ({ current: undefined }))).current;
  if (opts.dryRun) {
    deps.out(`Would ${mode} to ${built.toplevel} (generation ${from ?? "?"} → next)\n`);
    return { ...base, result: "dry-run", mode, from, toplevel: built.toplevel };
  }

  const applied = await deps.apply(built.toplevel, mode);
  const to = (await listGenerations(SYSTEM_PROFILE).catch(() => ({ current: undefined }))).current;
  if (!applied.ok) {
    deps.out(`Activation failed, rolled back: ${applied.error}\n`);
    return { ...base, result: "activation-failed", mode, from, to, toplevel: built.toplevel, detail: applied.error };
  }
  deps.out(`${mode === "boot" ? "Boot entry set" : "Switched"}: generation ${from ?? "none"} → ${to}\n`);
  return { ...base, result: "switched", mode, from, to, toplevel: built.toplevel };
}

/** The switch service: one pending request, if any; the request is consumed either way. */
export async function switchService(
  cfg: AgentConfig,
  agentStateDir: string,
  switchStateDir: string,
  deps: SwitchDeps,
  opts: { dryRun?: boolean } = {},
): Promise<SwitchRecord | undefined> {
  const req = await readRequest(agentStateDir);
  if (!req) {
    deps.out("No switch request.\n");
    return undefined;
  }
  let record: SwitchRecord;
  try {
    const repo = await syncRepo(cfg, agentStateDir, switchStateDir, req);
    record = await switchCommit(repo, req, deps, opts);
  } catch (err) {
    // consume the request anyway: the path unit would re-trigger on it forever
    record = { at: new Date().toISOString(), commit: req.commit, branch: req.branch, result: "error", detail: (err as Error).message };
    deps.out(`Switch failed: ${record.detail}\n`);
  }
  if (!opts.dryRun) {
    await writeFile(join(switchStateDir, "last-switch.json"), JSON.stringify(record, null, 2) + "\n");
    await rm(requestPath(agentStateDir), { force: true });
  }
  return record;
}
