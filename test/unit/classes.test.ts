import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkBash } from "../../src/agent/hooks.js";
import { captureKeepOld, withPatched } from "../../src/agent/keepold.js";
import { parseLog, trailerProblems } from "../../src/agent/trailers.js";
import { lockedRef, previousRef } from "../../src/run/pin.js";
import { newFindings, pinMessage } from "../../src/run/update.js";

describe("partial updates", () => {
  const lock = JSON.stringify({
    version: 7,
    root: "root",
    nodes: {
      root: { inputs: { nvf: "nvf", tools: "tools", nixpkgs: ["nvf", "nixpkgs"] } },
      nvf: { locked: { type: "github", owner: "notashelf", repo: "nvf", rev: "0bffd83" } },
      tools: { locked: { type: "git", url: "file:///up/tools", rev: "abc", ref: "main" } },
    },
  });

  it("refers to exactly what an input was locked to", () => {
    expect(previousRef(lock, "nvf")).toBe("github:notashelf/nvf/0bffd83");
    expect(previousRef(lock, "tools")).toBe("git+file:///up/tools?rev=abc&ref=main");
    expect(previousRef(lock, "nixpkgs")).toBeUndefined(); // a follows: nothing of its own
    expect(lockedRef({ type: "path", path: "/x" })).toBeUndefined();
  });

  it("labels the pin as a blocked change, with valid trailers", () => {
    const msg = pinMessage("tools", "git+file:///up/tools?rev=abc", "error: builder for tools-2 failed", new Date("2026-11-20T00:00:00Z"));
    const commits = parseLog(`x\x00${msg}\x01`);
    expect(commits[0]!.trailers).toMatchObject({ "Change-Id": "pin-tools-2026-11", "Change-Class": "blocked" });
    expect(trailerProblems(commits)).toEqual([]);
  });
});

describe("keep-old patches", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=a", "-c", "user.email=a@x", "-C", cwd, ...args], { encoding: "utf8" }).trim();

  it("captures the old-behaviour edit, restores the tree, and applies again later", async () => {
    const repo = await mkdtemp(join(tmpdir(), "keepold-"));
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    await writeFile(join(repo, "nvf.nix"), "{ vim.lsp.presets.tailwindcss-language-server.enable = true; }\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "behaviour: tailwind language → lsp preset");

    // the agent edits the tree back to the old behaviour, then saves it
    await writeFile(join(repo, "nvf.nix"), "{ vim.lsp.servers.tailwindcss = { filetypes = [ \"html\" ]; }; }\n");
    const file = await captureKeepOld(repo, "nvf-tailwind-2026-11");
    expect(file).toBe(join(repo, ".flake-agent/changes/nvf-tailwind-2026-11/keep-old.patch"));
    expect(await readFile(join(repo, "nvf.nix"), "utf8")).toContain("presets.tailwindcss-language-server");
    expect(await readFile(file, "utf8")).toContain('+{ vim.lsp.servers.tailwindcss = { filetypes = [ "html" ]; }; }');

    const applied = await withPatched(repo, "HEAD", file, (wt) => readFile(join(wt, "nvf.nix"), "utf8"));
    expect(applied).toContain("vim.lsp.servers.tailwindcss");
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("refuses an empty diff and odd ids", async () => {
    const repo = await mkdtemp(join(tmpdir(), "keepold-"));
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    await writeFile(join(repo, "a.nix"), "{ }\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "x");
    await expect(captureKeepOld(repo, "x-2026-11")).rejects.toThrow("no changes to the working tree");
    await expect(captureKeepOld(repo, "../../etc")).rejects.toThrow("invalid change id");
  });

  it("is allowed from the agent's Bash", () => {
    expect(checkBash("flake-agent keep-old nvf-tailwind-2026-11", { selfInput: "flake-updater" })).toBeNull();
    expect(checkBash("flake-agent switch", { selfInput: "flake-updater" })).toBe("flake-agent: only probe, guard and keep-old");
  });
});

describe("keep-old verification", () => {
  it("only counts findings beyond the accepted upstream-only ones", () => {
    const accepted = ["- binary-removed system/logoutd: shadow-4.19.4", "- package-removed fuse: 2.9.9-bin"];
    expect(newFindings(accepted.join("\n"), accepted)).toEqual([]);
    expect(newFindings(`${accepted[0]}\n- nvim-lsp-missing tailwindcss: no longer configured`, accepted)).toEqual([
      "- nvim-lsp-missing tailwindcss: no longer configured",
    ]);
  });
});
