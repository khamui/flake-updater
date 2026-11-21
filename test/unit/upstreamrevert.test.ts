import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lockViolations } from "../../src/guard/structure.js";
import type { Finding } from "../../src/probes/t0.js";
import { upstreamFindings, upstreamNotes, upstreamNotesPath } from "../../src/report/upstream.js";
import {
  parseNotes,
  readRevertRequest,
  removedFeature,
  reproduces,
  upstreamRevertRun,
  writeRevertRequest,
  type RevertRequest,
  type UpstreamRevertDeps,
} from "../../src/revert/upstream.js";
import { DEFAULTS, type AgentConfig } from "../../src/run/config.js";
import { cloneDir, requestPath } from "../../src/run/update.js";

const AT = "2026-11-25T03:00:00.000Z";
const RUN = { at: AT, branch: "agent/update-2026-11-25", updatedInputs: ["nixpkgs"] };
const [ALIAS, LIGHT] = upstreamFindings(["- zsh-alias-removed ll: ls -l", "- package-removed light: 1.2.2"], AT);

const lock = (rev: string) =>
  JSON.stringify({
    version: 7,
    root: "root",
    nodes: { root: { inputs: { nixpkgs: "nixpkgs" } }, nixpkgs: { locked: { type: "github", owner: "NixOS", repo: "nixpkgs", rev }, original: { type: "github", owner: "NixOS", repo: "nixpkgs" } } },
  }, null, 2) + "\n";

/** A user's repo whose last run on main recorded both upstream-only findings: nixpkgs old → new dropped `ll` and `light`. */
async function userRepo() {
  const root = await mkdtemp(join(tmpdir(), "upstream-revert-"));
  const repo = join(root, "user");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=u", "-c", "user.email=u@x", "-C", cwd, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "flake.lock"), lock("old"));
  await writeFile(join(repo, "c.nix"), "{ }\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  await writeFile(join(repo, "flake.lock"), lock("new"));
  git(repo, "commit", "-qam", "flake.lock: update nixpkgs");
  for (const f of [ALIAS!, LIGHT!]) {
    await mkdir(join(repo, ".flake-agent/changes", f.id), { recursive: true });
    await writeFile(join(repo, upstreamNotesPath(f.id)), upstreamNotes(f, RUN));
  }
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "CHANGES.md: agent/update-2026-11-25 (green)");
  const cfg: AgentConfig = { ...DEFAULTS, repo, host: "laptop", user: "kha" };
  return { root, repo, git, cfg, state: join(root, "state") };
}

type Agent = (dir: string, i: number) => Promise<string>;

/** A system is what its tree says: the alias when c.nix sets it or nixpkgs is old, light when nixpkgs is old. */
function fakeDeps(state: string, agent?: Agent): UpstreamRevertDeps & { prompts: string[]; systems: Map<string, string> } {
  const systems = new Map<string, string>();
  const prompts: string[] = [];
  const features = (tree: string) => ({ ll: /shellAliases\.ll|"old"/.test(tree), light: /"old"/.test(tree) });
  let i = 0;
  return {
    prompts,
    systems,
    out: () => {},
    now: new Date("2026-11-26T10:00:00Z"),
    async build(dir) {
      const tree = (await readFile(join(dir, "c.nix"), "utf8")) + (await readFile(join(dir, "flake.lock"), "utf8"));
      const toplevel = `/nix/store/${createHash("sha256").update(tree).digest("hex").slice(0, 32)}-system`;
      systems.set(toplevel, tree);
      return { ok: true, toplevel };
    },
    async probe(_dir, against, toplevel) {
      const [a, b] = [features(systems.get(against)!), features(systems.get(toplevel)!)];
      const t0: Finding[] = a.light && !b.light ? [{ severity: "fail", kind: "package-removed", subject: "light", detail: "1.2.2" }] : [];
      const t3: Finding[] = a.ll && !b.ll ? [{ severity: "fail", kind: "zsh-alias-removed", subject: "ll", detail: "ls -l" }] : [];
      return { t0, t1: [], t2: [], t3 };
    },
    async snapshot(dir, toplevel) {
      await mkdir(join(dir, ".flake-agent/snapshots/laptop"), { recursive: true });
      await writeFile(join(dir, ".flake-agent/snapshots/laptop/t3.json"), JSON.stringify({ toplevel }));
    },
    async pin(dir, _input, ref) {
      await writeFile(join(dir, "flake.lock"), lock(ref.split("/").at(-1)!));
    },
    ...(agent
      ? {
          runAgent: async (prompt) => {
            prompts.push(prompt);
            return { summary: await agent(cloneDir(state), ++i) };
          },
        }
      : {}),
  };
}

const commitAs = (dir: string, message: string) =>
  execFileSync("git", ["-c", "user.name=agent", "-c", "user.email=a@x", "-C", dir, "commit", "-qam", message]);
const restoreAlias: Agent = async (dir) => {
  await writeFile(join(dir, "c.nix"), '{ programs.zsh.shellAliases.ll = "ls -l"; }\n');
  commitAs(dir, `zsh: keep the ll alias\n\nChange-Id: ${ALIAS!.id}\nChange-Class: behaviour\nUpstream: https://github.com/NixOS/nixpkgs/pull/1`);
  return "Set the alias explicitly.";
};

describe("revert requests", () => {
  it("are only upstream ids, readable by the user and the agent's group", async () => {
    const dir = await mkdtemp(join(tmpdir(), "revert-req-"));
    await writeRevertRequest(dir, { id: ALIAS!.id, at: AT, note: "keep\nll" });
    expect(await readRevertRequest(dir)).toEqual({ id: ALIAS!.id, at: AT, note: "keep ll" });
    expect((await stat(join(dir, "revert-request.json"))).mode & 0o777).toBe(0o640);
    for (const id of ["nvf-tailwind-2026-11", "upstream-../../etc", "upstream-x; rm -rf"]) {
      await writeFile(join(dir, "revert-request.json"), JSON.stringify({ id, at: AT }));
      expect(await readRevertRequest(dir)).toBeUndefined();
    }
  });
});

describe("upstream-only notes", () => {
  it("give back the finding and the run's inputs", () => {
    const n = parseNotes(LIGHT!.id, upstreamNotes(LIGHT!, RUN))!;
    expect(n).toMatchObject({ finding: "package-removed light: 1.2.2", kind: "package-removed", subject: "light", inputs: ["nixpkgs"] });
    expect(removedFeature(n.kind)).toBe(true);
    expect(removedFeature("zsh-alias-removed")).toBe(false);
    expect(parseNotes("x", "no finding")).toBeUndefined();
  });

  it("are restored when main, probed against the candidate, shows the finding again", () => {
    const f = (kind: string, subject: string): Finding => ({ severity: "info", kind, subject, detail: "" });
    expect(reproduces({ kind: "zsh-alias-removed", subject: "ll" }, { t0: [], t1: [], t2: [], t3: [f("zsh-alias-removed", "ll")] })).toBe(true);
    expect(reproduces({ kind: "zsh-alias-removed", subject: "ll" }, { t0: [], t1: [], t2: [], t3: [f("zsh-alias-removed", "la")] })).toBe(false);
    const t1 = [f("file-changed", "etc/pam.d/sudo")];
    expect(reproduces({ kind: "file-changed", subject: "etc/pam.d/ (18 files)" }, { t0: [], t1, t2: [], t3: [] })).toBe(true);
    expect(reproduces({ kind: "file-changed", subject: "etc/pam.d/sudo (+2 more)" }, { t0: [], t1, t2: [], t3: [] })).toBe(true);
  });
});

describe("upstream revert run", () => {
  const request = (id: string, extra: Partial<RevertRequest> = {}): RevertRequest => ({ id, at: "2026-11-26T09:00:00.000Z", ...extra });
  const target = { host: "laptop", user: "kha" };

  it("lets the agent write the old behaviour, keeps it once the probes confirm it, and asks for the switch", async () => {
    const { cfg, state, git } = await userRepo();
    const d = fakeDeps(state, restoreAlias);
    const r = await upstreamRevertRun(cfg, state, request(ALIAS!.id, { note: `${ALIAS!.id}: keep ll` }), target, d);

    expect(r).toMatchObject({ status: "switch-requested", method: "agent", id: ALIAS!.id, branch: `agent/revert-${ALIAS!.id}` });
    expect(d.prompts[0]).toContain(`Finding: zsh-alias-removed ll: ls -l`);
    const clone = cloneDir(state);
    expect(git(clone, "log", "--format=%s", `${r.base}..${r.branch}`).split("\n")).toEqual([
      `PREFERENCES.md: keep ${ALIAS!.id} reverted`,
      `snapshots: probes on the revert of ${ALIAS!.id}`,
      "zsh: keep the ll alias",
    ]);
    expect(git(clone, "show", `${r.branch}:.flake-agent/PREFERENCES.md`)).toBe(`# Preferences\n\n- ${ALIAS!.id}: keep ll`);
    expect(JSON.parse(await readFile(requestPath(state), "utf8"))).toMatchObject({ commit: r.commit, branch: r.branch, base: r.base });
  });

  it("feeds back what is still different, and blocks after the fix-loop limit without a switch", async () => {
    const { cfg, state } = await userRepo();
    const d = fakeDeps(state, async () => "I looked around.");
    const r = await upstreamRevertRun(cfg, state, request(ALIAS!.id), target, d);
    expect(r.status).toBe("blocked");
    expect(r.detail).toMatch(/^not restored after 3 attempts: .*still show the new behaviour: zsh-alias-removed ll/);
    expect(d.prompts).toHaveLength(3);
    expect(d.prompts[1]).toContain("You made no commit. Builds, but the probes still show the new behaviour");
    await expect(stat(requestPath(state))).rejects.toThrow();
  });

  it("stops when the agent says configuration can't restore it", async () => {
    const { cfg, state } = await userRepo();
    const r = await upstreamRevertRun(cfg, state, request(ALIAS!.id), target, fakeDeps(state, async () => "Not restorable: the alias came from a removed module"));
    expect(r).toMatchObject({ status: "blocked", detail: "not restorable by configuration: the alias came from a removed module" });
  });

  it("blocks a commit that doesn't carry the revert's Change-Id", async () => {
    const { cfg, state } = await userRepo();
    const wrongId: Agent = async (dir) => {
      await writeFile(join(dir, "c.nix"), '{ programs.zsh.shellAliases.ll = "ls -l"; }\n');
      commitAs(dir, "zsh: ll\n\nChange-Id: something-else-2026-11\nChange-Class: behaviour\nUpstream: x");
      return "done";
    };
    const r = await upstreamRevertRun(cfg, state, request(ALIAS!.id), target, fakeDeps(state, wrongId));
    expect(r.status).toBe("blocked");
    expect(r.detail).toMatch(/Change-Id is not upstream-zsh-alias-removed-ll-2026-11/);
  });

  it("keeps the input back for a removed package, once confirmed, and the guard accepts the pin", async () => {
    const { cfg, state, git, repo } = await userRepo();
    const d = fakeDeps(state, async () => {
      throw new Error("no agent for a removed feature");
    });
    const r = await upstreamRevertRun(cfg, state, request(LIGHT!.id, { pin: true }), target, d);
    expect(r).toMatchObject({ status: "switch-requested", method: "pin", input: "nixpkgs" });
    const clone = cloneDir(state);
    const pin = git(clone, "log", "-1", "--format=%B", `${r.branch}~1`);
    expect(pin).toContain("flake.lock: keep nixpkgs at its previous revision");
    expect(pin).toContain(`Change-Id: ${LIGHT!.id}\nChange-Class: blocked`);
    expect(lockViolations(git(repo, "show", "main:flake.lock"), git(clone, "show", `${r.branch}:flake.lock`))).toEqual([]);
  });

  it("does nothing for a removed package without confirmation", async () => {
    const { cfg, state } = await userRepo();
    const r = await upstreamRevertRun(cfg, state, request(LIGHT!.id), target, fakeDeps(state));
    expect(r).toMatchObject({ status: "failed", detail: expect.stringMatching(/only an input kept at its previous revision restores it/) });
  });

  it("refuses an id main has no notes for", async () => {
    const { cfg, state } = await userRepo();
    const r = await upstreamRevertRun(cfg, state, request("upstream-nope-2026-11"), target, fakeDeps(state, restoreAlias));
    expect(r).toMatchObject({ status: "failed", detail: "no upstream-only change upstream-nope-2026-11 on main" });
  });
});
