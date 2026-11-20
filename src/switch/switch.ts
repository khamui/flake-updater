import { access, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { capture, run } from "../nix/exec.js";
import { runGuard, type GuardResult } from "../guard/guard.js";
import type { AgentConfig } from "../run/config.js";
import { cloneDir, requestPath, type SwitchRequest } from "../run/update.js";
import { PREFERENCES } from "../guard/structure.js";
import { readIdle, waitForIdle } from "../helper/idle.js";
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
  /** main when the agent branched: the handoff only fast-forwards from here. */
  runBase?: string;
  /** Not idle in time: boot entry set instead of a live switch. */
  idleFallback?: boolean;
  rolledBack?: { at: string; reason: string };
  /** Requested by the user (`flake-agent revert`), not the agent. */
  source?: "user";
}

/**
 * Where `flake-agent revert`, run by the user, asks for a switch: the user's
 * runtime dir, which the agent can't write. The commit comes from the user's repo.
 */
export const USER_REQUEST_DIR = "/run/flake-agent";

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
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

async function readRequestFile(file: string, branch: RegExp): Promise<SwitchRequest | undefined> {
  try {
    const req = JSON.parse(await readFile(file, "utf8")) as Partial<SwitchRequest>;
    if (typeof req.commit !== "string" || !/^[0-9a-f]{40}$/.test(req.commit)) return undefined;
    if (typeof req.branch !== "string" || !branch.test(req.branch)) return undefined;
    const base = typeof req.base === "string" && /^[0-9a-f]{40}$/.test(req.base) ? req.base : undefined;
    return { commit: req.commit, branch: req.branch, at: String(req.at ?? ""), ...(base ? { base } : {}) };
  } catch {
    return undefined;
  }
}

export const readRequest = (agentStateDir: string) => readRequestFile(requestPath(agentStateDir), /^agent\/[\w./-]+$/);
/** A user's request is only ever for a revert branch. */
export const readUserRequest = (dir: string) => readRequestFile(requestPath(dir), /^agent\/revert-[\w./-]+$/);

const git = (dir: string, ...args: string[]) => run("git", ["-c", "safe.directory=*", "-C", dir, ...args]).then((s) => s.trim());

/**
 * The switch service's own repository (root-owned): `main` straight from the
 * user's repo, the candidate commit fetched from `from` (the agent's clone, or
 * the user's repo for a revert). The agent controls nothing here, so it can't
 * move the guard's baseline.
 */
export async function syncRepo(cfg: AgentConfig, from: string, switchStateDir: string, req: SwitchRequest): Promise<string> {
  const repo = join(switchStateDir, "repo.git");
  await mkdir(switchStateDir, { recursive: true });
  try {
    await git(repo, "rev-parse", "--git-dir");
  } catch {
    await run("git", ["init", "-q", "--bare", repo]);
  }
  await git(repo, "fetch", "-q", join(cfg.repo, ".git"), `+refs/heads/${cfg.mainBranch}:refs/heads/main`);
  await git(repo, "fetch", "-q", from, `+refs/heads/${req.branch}:refs/candidates/${req.branch}`);
  await git(repo, "cat-file", "-e", `${req.commit}^{commit}`);
  return repo;
}

export interface SwitchDeps {
  /** `allow`: paths exempt from the write-scope denylist for this commit. */
  guard: (repo: string, rev: string, allow?: string[]) => Promise<GuardResult>;
  build: (repo: string, rev: string) => Promise<{ ok: boolean; toplevel?: string; error?: string }>;
  apply: (toplevel: string, mode: Mode) => Promise<{ ok: boolean; error?: string }>;
  current: string;
  out: (text: string) => void;
  /** Wait for the user to be idle before a live switch; absent = switch right away. */
  waitForIdle?: () => Promise<"idle" | "timeout">;
}

export function realDeps(cfg: AgentConfig, out: (t: string) => void): SwitchDeps {
  return {
    guard: (repo, rev, allow = []) =>
      runGuard({
        repo,
        host: cfg.host,
        user: cfg.user,
        rev,
        mainRef: "main",
        writeScope: { ...cfg.writeScope, allow: [...(cfg.writeScope.allow ?? []), ...allow] },
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
    waitForIdle: () => waitForIdle(() => readIdle(), { idleMinutes: cfg.idleMinutes, fallbackHours: cfg.idleFallbackHours }),
  };
}

/**
 * Guard → build → switch|boot for the requested commit. Nothing the agent
 * wrote besides the commit id is trusted: the guard runs here, on the exact
 * commit, against main from the user's own repo. A user's revert may also
 * append to PREFERENCES.md, and switches without waiting for idle: they asked.
 */
export async function switchCommit(
  repo: string,
  req: SwitchRequest,
  deps: SwitchDeps,
  opts: { dryRun?: boolean; user?: boolean } = {},
): Promise<SwitchRecord> {
  const base = {
    at: new Date().toISOString(),
    commit: req.commit,
    branch: req.branch,
    ...(req.base ? { runBase: req.base } : {}),
    ...(opts.user ? { source: "user" as const } : {}),
  };
  const verdict = await deps.guard(repo, req.commit, opts.user ? [PREFERENCES] : []);
  if (verdict.verdict !== "pass") {
    deps.out(`Needs review: guard blocked ${req.commit.slice(0, 12)}\n${verdict.reasons.map((r) => `  ${r}\n`).join("")}`);
    return { ...base, result: "needs-review", reasons: verdict.reasons };
  }

  const built = await deps.build(repo, req.commit);
  if (!built.ok || !built.toplevel) {
    deps.out(`Build failed for ${req.commit.slice(0, 12)}\n`);
    return { ...base, result: "build-failed", detail: built.error };
  }
  let mode = await decideMode(deps.current, built.toplevel);
  const from = (await listGenerations(SYSTEM_PROFILE).catch(() => ({ current: undefined }))).current;
  if (opts.dryRun) {
    deps.out(`Would ${mode} to ${built.toplevel} (generation ${from ?? "?"} → next)\n`);
    return { ...base, result: "dry-run", mode, from, toplevel: built.toplevel };
  }

  let idleFallback = false;
  if (mode === "switch" && !opts.user && deps.waitForIdle && (await deps.waitForIdle()) === "timeout") {
    // never switch under the user's hands: apply on the next reboot instead
    mode = "boot";
    idleFallback = true;
    deps.out("Not idle within the fallback period: setting the boot entry instead\n");
  }

  const applied = await deps.apply(built.toplevel, mode);
  const to = (await listGenerations(SYSTEM_PROFILE).catch(() => ({ current: undefined }))).current;
  if (!applied.ok) {
    deps.out(`Activation failed, rolled back: ${applied.error}\n`);
    return { ...base, result: "activation-failed", mode, from, to, toplevel: built.toplevel, detail: applied.error };
  }
  deps.out(`${mode === "boot" ? "Boot entry set" : "Switched"}: generation ${from ?? "none"} → ${to}\n`);
  return { ...base, result: "switched", mode, from, to, toplevel: built.toplevel, ...(idleFallback ? { idleFallback } : {}) };
}

/**
 * The switch service: one pending request, if any — the agent's first, else a
 * user's revert (the path unit starts the service again while one is left).
 * The request is consumed either way, an invalid one too.
 */
export async function switchService(
  cfg: AgentConfig,
  agentStateDir: string,
  switchStateDir: string,
  deps: SwitchDeps,
  opts: { dryRun?: boolean; userRequestDir?: string } = {},
): Promise<SwitchRecord | undefined> {
  const sources = [
    { file: requestPath(agentStateDir), read: () => readRequest(agentStateDir), from: cloneDir(agentStateDir), user: false },
    ...(opts.userRequestDir
      ? [{ file: requestPath(opts.userRequestDir), read: () => readUserRequest(opts.userRequestDir!), from: join(cfg.repo, ".git"), user: true }]
      : []),
  ];
  const source = (await Promise.all(sources.map(async (s) => ((await exists(s.file)) ? s : undefined)))).find(Boolean);
  if (!source) {
    deps.out("No switch request.\n");
    return undefined;
  }
  const req = await source.read();
  if (!req) {
    deps.out(`Invalid switch request: ${source.file}\n`);
    if (!opts.dryRun) await rm(source.file, { force: true });
    return undefined;
  }
  let record: SwitchRecord;
  try {
    const repo = await syncRepo(cfg, source.from, switchStateDir, req);
    record = await switchCommit(repo, req, deps, { dryRun: opts.dryRun, user: source.user });
  } catch (err) {
    // consume the request anyway: the path unit would re-trigger on it forever
    record = {
      at: new Date().toISOString(),
      commit: req.commit,
      branch: req.branch,
      result: "error",
      detail: (err as Error).message,
      ...(source.user ? { source: "user" as const } : {}),
    };
    deps.out(`Switch failed: ${record.detail}\n`);
  }
  if (!opts.dryRun) {
    await writeFile(join(switchStateDir, "last-switch.json"), JSON.stringify(record, null, 2) + "\n");
    await rm(source.file, { force: true });
  }
  return record;
}
