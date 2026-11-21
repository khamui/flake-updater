import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareRevert, type RevertDeps } from "../../src/revert/revert.js";
import type { T3Snapshot } from "../../src/probes/t3.js";

const ID = "nvf-tailwind-2026-11";

const neovim = (lsp: Record<string, { cmd: string; resolves: boolean }>) => ({
  startup: { errors: [], warnings: [] },
  keymaps: { n: {} },
  plugins: [],
  lsp,
  parsers: [],
  health: [],
});
const t3 = (lsp: Record<string, { cmd: string; resolves: boolean }>): T3Snapshot => ({ tier: "T3", probes: { neovim: neovim(lsp) } });
const WITH_TAILWIND = t3({ tailwindcss: { cmd: "tw", resolves: true } });
const WITHOUT = t3({});

/**
 * A user's repo whose main has a behaviour change already handed off: snapshot
 * before it, the change, its keep-old.patch, the snapshot after it.
 */
async function userRepo(opts: { patch?: boolean; lockChanges?: boolean } = {}) {
  const repo = await mkdtemp(join(tmpdir(), "revert-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git("config", "user.name", "kha");
  git("config", "user.email", "kha@example");
  const snap = join(repo, ".flake-agent/snapshots/laptop/t3.json");
  await mkdir(join(repo, ".flake-agent/snapshots/laptop"), { recursive: true });
  await writeFile(snap, JSON.stringify(WITH_TAILWIND));
  await writeFile(join(repo, "flake.lock"), "lock 1\n");
  await writeFile(join(repo, "c.nix"), "{ languages.tailwind.enable = true; }\n");
  git("add", ".");
  git("commit", "-qm", "init");

  if (opts.lockChanges) {
    await writeFile(join(repo, "flake.lock"), "lock 2\n");
    git("commit", "-qam", "flake.lock: update");
  }
  await writeFile(join(repo, "c.nix"), "{ lsp.presets.tailwind.enable = true; }\n");
  git("commit", "-qam", `nvf: tailwind language → lsp preset\n\nChange-Id: ${ID}\nChange-Class: behaviour`);
  if (opts.patch !== false) {
    await writeFile(join(repo, "c.nix"), "{ lsp.presets.tailwind.enable = true; lsp.servers.tailwind.enable = true; }\n");
    const patch = git("diff");
    git("checkout", "c.nix");
    await mkdir(join(repo, `.flake-agent/changes/${ID}`), { recursive: true });
    await writeFile(join(repo, `.flake-agent/changes/${ID}/keep-old.patch`), patch + "\n");
    git("add", ".");
    git("commit", "-qm", `keep-old patch\n\nChange-Id: ${ID}\nChange-Class: behaviour`);
  }
  await writeFile(snap, JSON.stringify(WITHOUT));
  git("commit", "-qam", "snapshots: probes on x");
  return { repo, git, main: git("rev-parse", "main") };
}

function deps(reverted: T3Snapshot): RevertDeps & { built: string[] } {
  const built: string[] = [];
  return {
    built,
    out: () => {},
    async build(dir) {
      built.push(await readFile(join(dir, "c.nix"), "utf8"));
      return { ok: true, toplevel: "/nix/store/x-system" };
    },
    async snapshot(dir) {
      await writeFile(join(dir, ".flake-agent/snapshots/laptop/t3.json"), JSON.stringify(reverted));
      return reverted;
    },
  };
}

const opts = (repo: string, note?: string) => ({ repo, mainBranch: "main", host: "laptop", id: ID, note: async () => note });

describe("revert", () => {
  it("applies keep-old.patch on a branch off main, confirms the old behaviour with the probes, and commits", async () => {
    const { repo, git, main } = await userRepo();
    const d = deps(WITH_TAILWIND);
    const r = await prepareRevert(opts(repo), d);

    expect(r).toMatchObject({ branch: `agent/revert-${ID}`, base: main, method: "keep-old", notRestored: [], noted: false });
    expect(r.restored.map((f) => `${f.kind} ${f.subject}`)).toEqual(["nvim-lsp-missing tailwindcss"]);
    expect(r.effect.map((f) => `${f.kind} ${f.subject}`)).toEqual(["nvim-lsp-added tailwindcss"]);
    expect(d.built).toEqual(["{ lsp.presets.tailwind.enable = true; lsp.servers.tailwind.enable = true; }\n"]);
    expect(git("log", "--format=%s", `main..${r.branch}`).split("\n")).toEqual([
      `snapshots: probes on the revert of ${ID}`,
      `Revert ${ID}: nvf: tailwind language → lsp preset`,
    ]);
    expect(git("log", "-1", "--format=%B", `${r.branch}^`)).toContain(`Reverts: ${ID}`);
    expect(git("show", `${r.branch}:c.nix`)).toContain("lsp.servers.tailwind.enable");
    expect(git("show", `${r.branch}:.flake-agent/snapshots/laptop/t3.json`)).toContain("tailwindcss");
    // the user's checkout is untouched
    expect(git("rev-parse", "main")).toBe(main);
    expect(git("status", "--porcelain")).toBe("");
    expect(git("worktree", "list").split("\n")).toHaveLength(1);
  });

  it("appends the note to PREFERENCES.md only when one is given", async () => {
    const { repo, git } = await userRepo();
    const r = await prepareRevert(opts(repo, `- ${ID}: keep tailwind as a language`), deps(WITH_TAILWIND));
    expect(r.noted).toBe(true);
    expect(git("log", "-1", "--format=%s", r.branch)).toBe(`PREFERENCES.md: keep ${ID} reverted`);
    expect(git("show", `${r.branch}:.flake-agent/PREFERENCES.md`)).toBe(`# Preferences\n\n- ${ID}: keep tailwind as a language`);
  });

  it("refuses a revert the probes say doesn't restore the old behaviour, and leaves no branch", async () => {
    const { repo, git } = await userRepo();
    await expect(prepareRevert(opts(repo), deps(WITHOUT))).rejects.toThrow(/does not restore the old behaviour:\n {2}nvim-lsp-missing tailwindcss/);
    expect(git("branch", "--list", "agent/*")).toBe("");
  });

  it("only warns when the snapshot before the change was taken on another lock", async () => {
    const { repo } = await userRepo({ lockChanges: true });
    // the snapshot before the change predates the lock update
    const r = await prepareRevert(opts(repo), deps(WITHOUT));
    expect(r.notRestored).toHaveLength(1);
    expect(r.caveat).toBe(`1 difference from before the change remains; that snapshot was taken on an older lock, so they are likely upstream's (flake-agent show ${ID}).`);
  });

  it("git-reverts a change without keep-old.patch", async () => {
    const { repo, git } = await userRepo({ patch: false });
    const r = await prepareRevert(opts(repo), deps(WITH_TAILWIND));
    expect(r.method).toBe("revert");
    expect(git("show", `${r.branch}:c.nix`)).toBe("{ languages.tailwind.enable = true; }");
  });

  it("refuses a change that isn't on main yet, or doesn't exist", async () => {
    const { repo, git } = await userRepo();
    git("checkout", "-qb", "agent/applied");
    git("commit", "-q", "--allow-empty", "-m", "later\n\nChange-Id: later-2026-12\nChange-Class: behaviour");
    git("checkout", "-q", "main");
    await expect(prepareRevert({ ...opts(repo), id: "later-2026-12" }, deps(WITH_TAILWIND))).rejects.toThrow(/not on main: merge agent\/applied/);
    await expect(prepareRevert({ ...opts(repo), id: "nope-2026-11" }, deps(WITH_TAILWIND))).rejects.toThrow(/no change nope-2026-11/);
    await expect(prepareRevert({ ...opts(repo), id: "upstream-package-removed-light-2026-11" }, deps(WITH_TAILWIND))).rejects.toThrow(/is upstream-only: .*#37/);
  });

  it("picks a new branch name when one revert of the change exists", async () => {
    const { repo } = await userRepo();
    await prepareRevert(opts(repo), deps(WITH_TAILWIND));
    expect((await prepareRevert(opts(repo), deps(WITH_TAILWIND))).branch).toBe(`agent/revert-${ID}-2`);
  });
});
