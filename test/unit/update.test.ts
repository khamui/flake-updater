import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULTS, loadConfig, type AgentConfig } from "../../src/run/config.js";
import { branchName, inputsToUpdate, prepareBranch } from "../../src/run/update.js";

const LOCK = JSON.stringify({
  version: 7,
  root: "root",
  nodes: {
    root: { inputs: { nixpkgs: "nixpkgs", nvf: "nvf", "flake-updater": "flake-updater", "home-manager": "home-manager" } },
  },
});

describe("update run", () => {
  it("updates every root input except the tool itself", () => {
    expect(inputsToUpdate(LOCK, "flake-updater")).toEqual(["home-manager", "nixpkgs", "nvf"]);
    expect(inputsToUpdate(LOCK, "self-renamed")).toContain("flake-updater");
  });

  it("names the branch by date", () => {
    expect(branchName(new Date("2026-11-25T03:00:00Z"))).toBe("agent/update-2026-11-25");
  });

  it("loads the module's config with defaults, CLI values winning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cfg-"));
    await writeFile(join(dir, "c.json"), JSON.stringify({ repo: "/home/kha/cfg", host: "laptop", user: "kha", diffLimit: 40 }));
    const cfg = await loadConfig(join(dir, "c.json"), { model: "claude-opus-5-5", host: undefined });
    expect(cfg).toEqual({ ...DEFAULTS, repo: "/home/kha/cfg", host: "laptop", user: "kha", diffLimit: 40, model: "claude-opus-5-5" });
    await expect(loadConfig(undefined, { host: "x" })).rejects.toThrow("config: repo is required");
  });

  it("clones the user's repo and branches off main, suffixing a taken name", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-"));
    const user = join(root, "user");
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=u", "-c", "user.email=u@x", "-C", cwd, ...args], { encoding: "utf8" }).trim();
    execFileSync("git", ["init", "-q", "-b", "main", user]);
    await writeFile(join(user, "flake.lock"), LOCK);
    git(user, "add", ".");
    git(user, "commit", "-qm", "init");
    // uncommitted work in the user's tree is not picked up
    await writeFile(join(user, "wip.nix"), "{}");

    const cfg: AgentConfig = { ...DEFAULTS, repo: user, host: "laptop", user: "kha" };
    const state = join(root, "state");
    const now = new Date("2026-11-25T03:00:00Z");
    const first = await prepareBranch(cfg, state, now);
    expect(first.branch).toBe("agent/update-2026-11-25");
    expect(first.base).toBe(git(user, "rev-parse", "main"));
    expect(git(first.git.dir, "ls-files")).toBe("flake.lock");

    const second = await prepareBranch(cfg, state, now);
    expect(second.branch).toBe("agent/update-2026-11-25-2");
  });
});
