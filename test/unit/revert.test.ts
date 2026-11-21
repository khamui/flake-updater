import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
 * A user's repo whose main has a behaviour change already handed off: the
 * change, its keep-old.patch (into k.nix, or wrong), and committed snapshots
 * that are deliberately stale: decisions must not read them (ADR 0002).
 */
async function userRepo(opts: { patch?: boolean | "wrong"; later?: "own-file" | "same-line"; noop?: boolean } = {}) {
  const repo = await mkdtemp(join(tmpdir(), "revert-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git("config", "user.name", "kha");
  git("config", "user.email", "kha@example");
  const snap = join(repo, ".flake-agent/snapshots/laptop/t3.json");
  await mkdir(join(repo, ".flake-agent/snapshots/laptop"), { recursive: true });
  await writeFile(snap, JSON.stringify(WITHOUT));
  await writeFile(join(repo, "flake.lock"), "lock 1\n");
  await writeFile(join(repo, "c.nix"), "{ languages.tailwind.enable = true; }\n");
  git("add", ".");
  git("commit", "-qm", "init");

  if (opts.noop) await writeFile(join(repo, "notes.txt"), "nothing the system reads\n");
  else await writeFile(join(repo, "c.nix"), "{ lsp.presets.tailwind.enable = true; }\n");
  git("add", ".");
  git("commit", "-qm", `nvf: tailwind language → lsp preset\n\nChange-Id: ${ID}\nChange-Class: behaviour`);
  if (opts.patch !== false) {
    await writeFile(join(repo, "k.nix"), opts.patch === "wrong" ? "{ lsp.servers.other.enable = true; }\n" : "{ lsp.servers.tailwind.enable = true; }\n");
    git("add", "-N", "k.nix");
    const patch = git("diff");
    git("rm", "-q", "--cached", "k.nix");
    await rm(join(repo, "k.nix"));
    await mkdir(join(repo, `.flake-agent/changes/${ID}`), { recursive: true });
    await writeFile(join(repo, `.flake-agent/changes/${ID}/keep-old.patch`), patch + "\n");
    git("add", ".");
    git("commit", "-qm", `keep-old patch\n\nChange-Id: ${ID}\nChange-Class: behaviour`);
  }
  await writeFile(snap, JSON.stringify(WITH_TAILWIND));
  git("commit", "-qam", "snapshots: probes on x");
  if (opts.later === "own-file") {
    // the user's own neovim edit after the change, with no snapshot
    await writeFile(join(repo, "u.nix"), "{ lsp.servers.lua.enable = true; }\n");
    git("add", ".");
    git("commit", "-qm", "nvim: lua server");
  } else if (opts.later === "same-line") {
    await writeFile(join(repo, "c.nix"), "{ lsp.presets.tailwind.enable = true; lsp.servers.lua.enable = true; }\n");
    git("commit", "-qam", "nvim: lua server");
  }
  return { repo, git, main: git("rev-parse", "main") };
}

/** The system a tree builds: neovim's servers, read from its files. */
function deps(): RevertDeps & { built: string[] } {
  const built: string[] = [];
  const config = async (dir: string) =>
    (await Promise.all(["c.nix", "k.nix", "u.nix"].map((n) => readFile(join(dir, n), "utf8").catch(() => "")))).join("");
  const probe = (text: string) =>
    t3({
      ...(/languages\.tailwind|servers\.tailwind/.test(text) ? { tailwindcss: { cmd: "tw", resolves: true } } : {}),
      ...(/servers\.lua/.test(text) ? { lua_ls: { cmd: "lua-ls", resolves: true } } : {}),
      ...(/servers\.other/.test(text) ? { other: { cmd: "other", resolves: true } } : {}),
    });
  return {
    built,
    out: () => {},
    async build(dir) {
      const text = await config(dir);
      built.push(text);
      return { ok: true, toplevel: `/nix/store/${createHash("sha256").update(text).digest("hex").slice(0, 32)}-system` };
    },
    async snapshot(dir) {
      const snap = probe(await config(dir));
      await mkdir(join(dir, ".flake-agent/snapshots/laptop"), { recursive: true });
      await writeFile(join(dir, ".flake-agent/snapshots/laptop/t3.json"), JSON.stringify(snap));
      return snap;
    },
  };
}

const opts = (repo: string, note?: string) => ({ repo, mainBranch: "main", host: "laptop", id: ID, note: async () => note });

describe("revert", () => {
  it("applies keep-old.patch on a branch off main, confirms the old behaviour against main built without the change, and commits", async () => {
    const { repo, git, main } = await userRepo();
    const d = deps();
    const r = await prepareRevert(opts(repo), d);

    expect(r).toMatchObject({ branch: `agent/revert-${ID}`, base: main, method: "keep-old", notRestored: [], noted: false });
    expect(r.caveat).toBeUndefined();
    expect(r.restored.map((f) => `${f.kind} ${f.subject}`)).toEqual(["nvim-lsp-missing tailwindcss"]);
    expect(r.effect.map((f) => `${f.kind} ${f.subject}`)).toEqual(["nvim-lsp-added tailwindcss"]);
    // the revert, main, main without the change's commits
    expect(d.built).toEqual([
      "{ lsp.presets.tailwind.enable = true; }\n{ lsp.servers.tailwind.enable = true; }\n",
      "{ lsp.presets.tailwind.enable = true; }\n",
      "{ languages.tailwind.enable = true; }\n",
    ]);
    // the revert's snapshot equals the one committed: no snapshot commit
    expect(git("log", "--format=%s", `main..${r.branch}`).split("\n")).toEqual([`Revert ${ID}: nvf: tailwind language → lsp preset`]);
    expect(git("log", "-1", "--format=%B", r.branch)).toContain(`Reverts: ${ID}`);
    expect(git("show", `${r.branch}:k.nix`)).toContain("lsp.servers.tailwind.enable");
    // the user's checkout is untouched
    expect(git("rev-parse", "main")).toBe(main);
    expect(git("status", "--porcelain")).toBe("");
    expect(git("worktree", "list").split("\n")).toHaveLength(1);
  });

  it("appends the note to PREFERENCES.md only when one is given", async () => {
    const { repo, git } = await userRepo();
    const r = await prepareRevert(opts(repo, `- ${ID}: keep tailwind as a language`), deps());
    expect(r.noted).toBe(true);
    expect(git("log", "-1", "--format=%s", r.branch)).toBe(`PREFERENCES.md: keep ${ID} reverted`);
    expect(git("show", `${r.branch}:.flake-agent/PREFERENCES.md`)).toBe(`# Preferences\n\n- ${ID}: keep tailwind as a language`);
  });

  it("refuses a revert the probes say doesn't restore the old behaviour, and leaves no branch", async () => {
    const { repo, git } = await userRepo({ patch: "wrong" });
    await expect(prepareRevert(opts(repo), deps())).rejects.toThrow(/does not restore the old behaviour:\n {2}nvim-lsp-missing tailwindcss/);
    expect(git("branch", "--list", "agent/*")).toBe("");
  });

  it("isn't thrown off by the user's later edit to the same program", async () => {
    const { repo } = await userRepo({ later: "own-file" });
    const r = await prepareRevert(opts(repo), deps());
    expect(r.restored.map((f) => `${f.kind} ${f.subject}`)).toEqual(["nvim-lsp-missing tailwindcss"]);
    expect(r.notRestored).toEqual([]);
    // the lua server is on both sides: not part of the change, not touched by the revert
    expect(r.effect.map((f) => `${f.kind} ${f.subject}`)).toEqual(["nvim-lsp-added tailwindcss"]);
  });

  it("only checks the build when main no longer reverts cleanly without the change", async () => {
    const { repo } = await userRepo({ later: "same-line" });
    const r = await prepareRevert(opts(repo), deps());
    expect(r.caveat).toMatch(/^main without the change's commits: git revert failed/);
    expect(r.restored).toEqual([]);
    expect(r.effect.map((f) => `${f.kind} ${f.subject}`)).toEqual(["nvim-lsp-added tailwindcss"]);
  });

  it("refuses a change main builds the same without", async () => {
    const { repo, git } = await userRepo({ noop: true, patch: false });
    await expect(prepareRevert(opts(repo), deps())).rejects.toThrow(/builds the same system without .*nothing to revert/);
    expect(git("branch", "--list", "agent/*")).toBe("");
  });

  it("git-reverts a change without keep-old.patch, built once besides main", async () => {
    const { repo, git } = await userRepo({ patch: false });
    const d = deps();
    const r = await prepareRevert(opts(repo), d);
    expect(r.method).toBe("revert");
    expect(r.restored.map((f) => `${f.kind} ${f.subject}`)).toEqual(["nvim-lsp-missing tailwindcss"]);
    expect(d.built).toHaveLength(2);
    expect(git("show", `${r.branch}:c.nix`)).toBe("{ languages.tailwind.enable = true; }");
  });

  it("refuses a change that isn't on main yet, or doesn't exist", async () => {
    const { repo, git } = await userRepo();
    git("checkout", "-qb", "agent/applied");
    git("commit", "-q", "--allow-empty", "-m", "later\n\nChange-Id: later-2026-12\nChange-Class: behaviour");
    git("checkout", "-q", "main");
    await expect(prepareRevert({ ...opts(repo), id: "later-2026-12" }, deps())).rejects.toThrow(/not on main: merge agent\/applied/);
    await expect(prepareRevert({ ...opts(repo), id: "nope-2026-11" }, deps())).rejects.toThrow(/no change nope-2026-11/);
    await expect(prepareRevert({ ...opts(repo), id: "upstream-package-removed-light-2026-11" }, deps())).rejects.toThrow(/is upstream-only: .*agent service prepares its revert/);
  });

  it("picks a new branch name when one revert of the change exists", async () => {
    const { repo } = await userRepo();
    await prepareRevert(opts(repo), deps());
    expect((await prepareRevert(opts(repo), deps())).branch).toBe(`agent/revert-${ID}-2`);
  });
});
