import { chmod, chown, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { modelFor } from "../agent/loop.js";
import { parseLog, trailerProblems } from "../agent/trailers.js";
import type { Target } from "../discovery/discover.js";
import { acquireLock } from "../preflight/environment.js";
import type { PreflightFailure } from "../preflight/subscription.js";
import type { ProbeRun } from "../probes/all.js";
import type { Finding } from "../probes/t0.js";
import { upstreamNotesPath } from "../report/upstream.js";
import { previousRef } from "../run/pin.js";
import type { AgentConfig } from "../run/config.js";
import { prepareBranch, requestPath, type SwitchRequest } from "../run/update.js";
import { PREFERENCES } from "../guard/structure.js";

/**
 * \`flake-agent revert <upstream-id>\`, written by the user for the agent service
 * (SPEC: upstream-only changes). Only ever read from the user's request dir
 * (/run/flake-agent): the agent service can't write there, so the agent can't
 * ask for a revert of its own.
 */
export interface RevertRequest {
  id: string;
  at: string;
  /** A removed feature: the user confirmed keeping an input at its previous revision. */
  pin?: boolean;
  /** For PREFERENCES.md, appended by the run (the agent never edits it). */
  note?: string;
}

export const revertRequestPath = (dir: string) => join(dir, "revert-request.json");

const UPSTREAM_ID = /^upstream-[a-z0-9][a-z0-9.-]*$/;

export async function readRevertRequest(dir: string): Promise<RevertRequest | undefined> {
  try {
    const r = JSON.parse(await readFile(revertRequestPath(dir), "utf8")) as Partial<RevertRequest>;
    if (typeof r.id !== "string" || !UPSTREAM_ID.test(r.id) || typeof r.at !== "string" || !r.at) return undefined;
    const note = typeof r.note === "string" && r.note.trim() && r.note.length <= 500 ? r.note.trim().replace(/\s*\n\s*/g, " ") : undefined;
    return { id: r.id, at: r.at, ...(r.pin === true ? { pin: true } : {}), ...(note ? { note } : {}) };
  } catch {
    return undefined;
  }
}

/** Readable by the user and the agent service (the dir's group), no one else. */
export async function writeRevertRequest(dir: string, req: RevertRequest): Promise<string> {
  const file = revertRequestPath(dir);
  await writeFile(file, JSON.stringify(req) + "\n", { mode: 0o640 });
  await chmod(file, 0o640);
  const group = (await stat(dir)).gid;
  await chown(file, process.getuid?.() ?? -1, group).catch(() => undefined);
  return file;
}

/** What the run recorded for an upstream-only id (`upstreamNotes`). */
export interface UpstreamNotes {
  id: string;
  /** `<kind> <subject>[: <detail>]` */
  finding: string;
  kind: string;
  subject: string;
  inputs: string[];
  text: string;
}

export function parseNotes(id: string, text: string): UpstreamNotes | undefined {
  const finding = /^Finding: (.+)$/m.exec(text)?.[1]?.trim();
  if (!finding) return undefined;
  const head = finding.split(": ")[0]!;
  const space = head.indexOf(" ");
  const inputs = /^Run: .*, inputs: (.+)$/m.exec(text)?.[1]?.split(",").map((s) => s.trim()).filter((s) => s && s !== "none") ?? [];
  return { id, finding, kind: head.slice(0, space), subject: head.slice(space + 1), inputs, text };
}

/** Nothing in the config can bring back a package or binary upstream dropped: only the old input can. */
export const removedFeature = (kind: string) => /^(package|binary)-removed$/.test(kind);

/** The lock the run that recorded `id` started from: before its `flake.lock: update` commit. */
export async function lockBeforeRun(git: (...args: string[]) => Promise<string>, rev: string, id: string): Promise<string | undefined> {
  const added = (await git("log", "-1", "--diff-filter=A", "--format=%H", rev, "--", upstreamNotesPath(id))).trim();
  if (!added) return undefined;
  const update = (await git("log", "--format=%H%x00%s", added))
    .split("\n")
    .map((l) => l.split("\0"))
    .find(([, s]) => s?.startsWith("flake.lock: update"));
  if (!update) return undefined;
  return git("show", `${update[0]}^:flake.lock`).catch(() => undefined);
}

/**
 * Whether a candidate restores the upstream-only finding: probed with the
 * candidate as the old side and main as the new one (ADR 0002: same lock
 * unless a pin is the change), main shows the finding again.
 */
export function reproduces(n: Pick<UpstreamNotes, "kind" | "subject">, probes: Pick<ProbeRun, "t0" | "t1" | "t2" | "t3">): boolean {
  // grouped T1 entries: `etc/pam.d/ (18 files)`, `etc/a.crt (+2 more)`
  const group = /^(.*?) \((?:\d+ files|\+\d+ more)\)$/.exec(n.subject)?.[1];
  const all: Finding[] = [...probes.t0, ...probes.t1, ...probes.t2, ...probes.t3];
  return all.some((f) => f.kind === n.kind && (f.subject === n.subject || (group !== undefined && (f.subject === group || (group.endsWith("/") && f.subject.startsWith(group))))));
}

export function revertRules(cfg: Pick<AgentConfig, "host" | "selfInput">, repo: string, id: string): string {
  return `You restore one behaviour of a NixOS flake configuration that a flake input update changed on its own (an upstream-only change). The lock stays as it is. The user asked for the old behaviour back.

Rules:
- Work only inside ${repo}. Never edit flake.lock, the inputs block of flake.nix, any hardware-configuration.nix, .flake-agent/PREFERENCES.md, or a services.flake-agent block. Hooks refuse such edits.
- Read .flake-agent/PREFERENCES.md first if it exists, and follow it.
- Verify with: nix build .#nixosConfigurations.${cfg.host}.config.system.build.toplevel --no-link
- Find out why upstream changed (release notes, changelogs, commits, issues) with WebFetch: the NixOS and home-manager manuals, and the GitHub repositories of this flake's inputs. Nothing else is reachable.
- Write the closest explicit configuration for the old behaviour:
  - a changed default: the old value, set explicitly in the file that already configures that program;
  - a package behaviour change: an override, an explicit keymap, alias or binding, or an overlay pin.
- One commit: git add <files> && git commit -F - <<'EOF' … EOF (a quoted here-document; redirections, command substitution and files outside the repository are refused). A subject line, then a body saying what upstream changed, what you wrote and what it restores, then these trailers:
    Change-Id: ${id}
    Change-Class: <behaviour|review>   (review if it touches overlays, overrides, hashes or fetchers)
    Upstream: <link to the upstream change>
- If configuration cannot restore it, make no commit and say in your final answer: "Not restorable: <reason>".
- Never update ${cfg.selfInput}, never push, never touch other branches.
- Finish with a short summary of what you changed and why.`;
}

export function revertPrompt(n: UpstreamNotes, iteration: number, problems: string | undefined, preferences: string | undefined): string {
  return [
    `Iteration ${iteration}. Restore the old behaviour for ${n.id}:`,
    "",
    n.text.trim(),
    "",
    problems ? `After your last attempt:\n${problems.trim()}\n` : "",
    preferences ? `.flake-agent/PREFERENCES.md:\n${preferences.trim()}\n` : "",
    "Restore it, verify the build, and commit as described.",
  ].join("\n");
}

export interface RevertRunRecord {
  at: string;
  /** The request's \`at\`: each request is handled once. */
  requestAt: string;
  id: string;
  status: "switch-requested" | "blocked" | "failed" | "interrupted";
  method?: "agent" | "pin";
  /** method pin: the input kept at its previous revision. */
  input?: string;
  branch?: string;
  commit?: string;
  base?: string;
  detail?: string;
}

export interface UpstreamRevertDeps {
  out: (text: string) => void;
  now?: Date;
  /** Build a tree's system. */
  build: (dir: string) => Promise<{ ok: boolean; toplevel?: string; error?: string }>;
  /** All tiers, `against` the old side; snapshots written under `snapshots`, not the branch. */
  probe: (dir: string, against: string, toplevel: string, snapshots: string) => Promise<Pick<ProbeRun, "t0" | "t1" | "t2" | "t3">>;
  /** Snapshot a system into the tree (committed with the revert). */
  snapshot: (dir: string, toplevel: string) => Promise<void>;
  /** `nix flake lock --override-input input ref`. */
  pin: (dir: string, input: string, ref: string) => Promise<void>;
  /** One agent session with the revert rules; absent = AI-free (only pins work). */
  runAgent?: (prompt: string, model: string, system: string) => Promise<{ quota?: PreflightFailure; summary: string }>;
}

const tail = (text: string, n: number) => text.trim().split("\n").slice(-n).join("\n");

/**
 * The agent service's run for a revert request: on \`agent/revert-<id>\` off main,
 * the agent writes the old behaviour explicitly (or, for a removed feature the
 * user confirmed, an input is kept at its previous revision); each candidate is
 * built and probed against main built now, and kept only if main then shows
 * the upstream change again. Restored → snapshots, the user's note, a switch
 * request (the switch service guards it as any agent commit). Not restored
 * within the fix-loop limit → blocked, nothing switched.
 */
export async function upstreamRevertRun(cfg: AgentConfig, stateDir: string, req: RevertRequest, target: Omit<Target, "flake">, deps: UpstreamRevertDeps): Promise<RevertRunRecord> {
  const now = deps.now ?? new Date();
  const at = now.toISOString();
  const rec = (r: Omit<RevertRunRecord, "at" | "requestAt" | "id">): RevertRunRecord => ({ at, requestAt: req.at, id: req.id, ...r });
  const release = await acquireLock(stateDir);
  if (!release) return rec({ status: "failed", detail: "another run holds the lock" });
  const scratch = await mkdtemp(join(tmpdir(), "flake-agent-revert-probes-"));
  try {
    const { git, branch, base } = await prepareBranch(cfg, stateDir, now, `agent/revert-${req.id}`);
    const dir = git.dir;
    const fail = (status: RevertRunRecord["status"], detail: string) => rec({ status, branch, base, detail });

    const notes = parseNotes(req.id, await git.run("show", `${base}:${upstreamNotesPath(req.id)}`).catch(() => ""));
    if (!notes) return fail("failed", `no upstream-only change ${req.id} on ${cfg.mainBranch}`);
    deps.out(`Reverting ${req.id} (${notes.finding}) on ${branch}\n`);

    const main = await deps.build(dir);
    if (!main.ok || !main.toplevel) return fail("failed", `${cfg.mainBranch} does not build: ${tail(main.error ?? "", 1)}`);
    /** Build HEAD; restored when main, probed against it, shows the finding again. */
    const check = async (): Promise<{ restored: boolean; toplevel?: string; problems: string }> => {
      await git.run("reset", "-q", "--hard", "HEAD");
      await git.run("clean", "-fdq");
      const built = await deps.build(dir);
      if (!built.ok || !built.toplevel) return { restored: false, problems: `nix build failed:\n${tail(built.error ?? "", 25)}` };
      const probes = await deps.probe(dir, built.toplevel, main.toplevel!, scratch);
      return reproduces(notes, probes)
        ? { restored: true, toplevel: built.toplevel, problems: "" }
        : { restored: false, toplevel: built.toplevel, problems: `Builds, but the probes still show the new behaviour: ${notes.finding}` };
    };

    let method: RevertRunRecord["method"];
    let input: string | undefined;
    let restored: { toplevel?: string } | undefined;
    if (removedFeature(notes.kind)) {
      if (!req.pin) return fail("failed", `${notes.finding}: only an input kept at its previous revision restores it, and that wasn't confirmed`);
      const before = await lockBeforeRun((...a) => git.run(...a), base, req.id);
      const lock = await readFile(join(dir, "flake.lock"), "utf8");
      for (const name of before ? notes.inputs : []) {
        const prev = previousRef(before!, name);
        if (!prev || prev === previousRef(lock, name)) continue;
        await deps.pin(dir, name, prev);
        if ((await git.run("status", "--porcelain", "flake.lock")) === "") continue;
        await git.run("add", "flake.lock");
        await commit(git.run.bind(git), pinMessage(req.id, name, prev, notes.finding));
        deps.out(`Trying ${name} at ${prev}\n`);
        const r = await check();
        if (r.restored) {
          [method, input, restored] = ["pin", name, r];
          break;
        }
        await git.run("reset", "-q", "--hard", "HEAD^");
      }
      if (!restored) return fail("blocked", `no input kept at its previous revision restores ${notes.finding}`);
    } else {
      if (!deps.runAgent) return fail("failed", "an upstream-only revert needs the agent");
      const prefs = await readFile(join(dir, PREFERENCES), "utf8").catch(() => undefined);
      const system = revertRules(cfg, dir, req.id);
      let problems: string | undefined;
      for (let i = 1; i <= cfg.maxFixIterations && !restored; i++) {
        const model = modelFor(i, cfg);
        deps.out(`Revert iteration ${i}/${cfg.maxFixIterations} (${model})\n`);
        const head = await git.run("rev-parse", "HEAD");
        const r = await deps.runAgent(revertPrompt(notes, i, problems, prefs), model, system);
        if (r.quota) return fail("interrupted", r.quota.message);
        if (r.summary.trim()) deps.out(`${r.summary.trim().replace(/^/gm, "  | ")}\n`);
        const why = /Not restorable:\s*(.+)/i.exec(r.summary)?.[1];
        const committed = (await git.run("rev-parse", "HEAD")) !== head;
        if (!committed && why) return fail("blocked", `not restorable by configuration: ${why.trim()}`);
        const c = await check();
        if (c.restored) [method, restored] = ["agent", c];
        else problems = committed ? c.problems : `You made no commit. ${c.problems}`;
      }
      if (!restored) return fail("blocked", `not restored after ${cfg.maxFixIterations} attempts: ${tail(problems ?? "", 1)}`);
      const changes = parseLog(await git.run("log", "--reverse", "--format=%H%x00%B%x01", `${base}..HEAD`));
      const issues = [
        ...trailerProblems(changes),
        ...changes.filter((c) => c.trailers["Change-Id"] !== req.id).map((c) => `${c.sha.slice(0, 12)}: Change-Id is not ${req.id}`),
      ];
      if (issues.length) return fail("blocked", issues.join("; "));
    }

    await deps.snapshot(dir, restored.toplevel!);
    await git.run("add", ".flake-agent/snapshots");
    if ((await git.run("status", "--porcelain", ".flake-agent/snapshots")) !== "") await commit(git.run.bind(git), `snapshots: probes on the revert of ${req.id}`);
    if (req.note) {
      const file = join(dir, PREFERENCES);
      const existing = await readFile(file, "utf8").catch(() => undefined);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${existing === undefined ? "# Preferences\n\n" : existing.endsWith("\n") ? existing : `${existing}\n`}- ${req.note}\n`);
      await git.run("add", PREFERENCES);
      await commit(git.run.bind(git), `PREFERENCES.md: keep ${req.id} reverted`);
    }
    const head = await git.run("rev-parse", "HEAD");
    const sw: SwitchRequest = { commit: head, branch, at, base };
    await writeFile(requestPath(stateDir), JSON.stringify(sw) + "\n");
    deps.out(`${branch} ${head.slice(0, 12)}: restored, switch requested\n`);
    return rec({ status: "switch-requested", method, ...(input ? { input } : {}), branch, commit: head, base });
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await release();
  }
}

async function commit(git: (...args: string[]) => Promise<string>, message: string): Promise<void> {
  await git("commit", "-q", "-m", message);
}

export function pinMessage(id: string, input: string, ref: string, finding: string): string {
  return [
    `flake.lock: keep ${input} at its previous revision`,
    "",
    `Upstream removed it, and nothing in the configuration brings it back: ${finding}.`,
    `The user asked for it back (flake-agent revert ${id}); ${input} stays at ${ref}.`,
    "",
    `Change-Id: ${id}`,
    "Change-Class: blocked",
    `Upstream: ${ref}`,
  ].join("\n");
}
