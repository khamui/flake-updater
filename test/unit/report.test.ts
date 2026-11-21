import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunState } from "../../src/preflight/state.js";
import { StateStore } from "../../src/preflight/state.js";
import { status } from "../../src/preflight/cycle.js";
import type { RunRecord } from "../../src/run/update.js";
import type { SwitchRecord } from "../../src/switch/switch.js";
import { changeLines, changesEntry, latestEvent, prependEntry } from "../../src/report/report.js";
import { showChange, withoutTrailers } from "../../src/report/show.js";
import type { T3Snapshot } from "../../src/probes/t3.js";
import { countsTowardsLimit } from "../../src/guard/structure.js";
import { upstreamFindings, upstreamNotes, upstreamNotesPath } from "../../src/report/upstream.js";

const SHA = "a".repeat(40);
const run: RunRecord = {
  at: "2026-11-25T03:00:00.000Z",
  status: "green",
  branch: "agent/update-2026-11-25",
  commit: SHA,
  updatedInputs: ["nixpkgs", "nvf"],
  changes: [
    { sha: "1", subject: "nvf: tailwind language → lsp preset", id: "nvf-tailwind-2026-11", class: "behaviour" },
    { sha: "2", subject: "nvf: languages.ts → languages.typescript", id: "nvf-ts-rename-2026-11", class: "mechanical" },
    { sha: "3", subject: "keep-old patch for tailwind", id: "nvf-tailwind-2026-11", class: "behaviour" },
    { sha: "4", subject: "tsls: outputHash override", id: "tsls-hash-2026-11", class: "review" },
    { sha: "5", subject: "flake.lock: keep tools at its previous revision", id: "pin-tools-2026-11", class: "blocked" },
  ],
  pinned: ["tools"],
  behaviourChanges: ["- binary-removed system/logoutd: shadow-4.19.4"],
};
const switched: SwitchRecord = { at: "2026-11-25T04:00:00.000Z", commit: SHA, branch: run.branch!, result: "switched", mode: "switch", from: 412, to: 413 };

describe("report", () => {
  it("has one line per change id, marked by class", () => {
    expect(changeLines(run).map((l) => `${l.mark} ${l.id}`)).toEqual([
      "⚠ nvf-tailwind-2026-11",
      "✓ nvf-ts-rename-2026-11",
      "⛔ tsls-hash-2026-11",
      "⏸ pin-tools-2026-11",
    ]);
  });

  it("reports a switch with generations, changes, details and undo", () => {
    const e = latestEvent({ lastRun: run }, switched, "main fast-forwarded to aaaaaaaaaaaa")!;
    expect(e.key).toBe("switch:2026-11-25T04:00:00.000Z");
    expect(e.text).toContain("System updated (2026-11-25), generation 412 → 413");
    expect(e.text).toContain("inputs: nixpkgs, nvf, 3 config changes, kept back: tools");
    expect(e.text).toMatch(/⚠ nvf-tailwind-2026-11 +nvf: tailwind language → lsp preset/);
    expect(e.text).toMatch(/⛔ tsls-hash-2026-11 +needs review: tsls: outputHash override/);
    expect(e.text).toContain("⚠ upstream: binary-removed system/logoutd: shadow-4.19.4  (upstream-binary-removed-system-logoutd-2026-11)");
    expect(e.text).toContain("Details:  flake-agent show nvf-tailwind-2026-11");
    expect(e.text).toContain("Undo:     flake-agent revert nvf-tailwind-2026-11");
    expect(e.text).toContain("Repo:     main fast-forwarded");
  });

  it("points at the first upstream-only finding when the agent changed nothing", () => {
    const e = latestEvent({ lastRun: { ...run, changes: [], pinned: [] } }, switched)!;
    expect(e.text).toContain("Details:  flake-agent show upstream-binary-removed-system-logoutd-2026-11");
    expect(e.text).not.toContain("Undo:");
  });

  it("has nothing to say about a green run that hasn't switched yet", () => {
    expect(latestEvent({ lastRun: run }, undefined)).toBeUndefined();
  });

  it("says when an upstream revert was blocked, and that nothing was switched", () => {
    const id = "upstream-zsh-alias-removed-ll-2026-11";
    const lastRevert = { at: "2026-11-26T10:00:00.000Z", requestAt: "x", id, status: "blocked" as const, branch: `agent/revert-${id}`, detail: "not restored after 3 attempts: …" };
    const e = latestEvent({ lastRun: run, lastRevert }, switched)!;
    expect(e.key).toBe("revert:2026-11-26T10:00:00.000Z");
    expect(e.text).toBe(`Revert of ${id} blocked (2026-11-26): nothing was switched\n  not restored after 3 attempts: …\n  Branch:   agent/revert-${id}\n`);
    // a revert that asked for the switch is reported by the switch
    expect(latestEvent({ lastRun: run, lastRevert: { ...lastRevert, status: "switch-requested" } }, undefined)).toBeUndefined();
  });

  it("reports a rollback as a new event", () => {
    const rolled = { ...switched, rolledBack: { at: "2026-11-25T04:05:00.000Z", reason: "nvim-startup-error neovim" } };
    const e = latestEvent({ lastRun: run }, rolled)!;
    expect(e.key).not.toBe(latestEvent({ lastRun: run }, switched)!.key);
    expect(e.text).toContain("Update rolled back (2026-11-25): nvim-startup-error neovim");
  });

  it("says which change a user's revert undid", () => {
    const rec: SwitchRecord = { ...switched, commit: "b".repeat(40), branch: "agent/revert-nvf-tailwind-2026-11", source: "user" };
    const e = latestEvent({ lastRun: run }, rec)!;
    expect(e.text).toMatch(/^System updated \(2026-11-25\), generation 412 → 413\n {2}↩ reverted nvf-tailwind-2026-11/);
    // not the run's report: the switched commit is the revert, not the run's
    expect(e.text).not.toContain("nvf-ts-rename");
  });

  it("reports guard blocks, blocked runs and pending choices, newest first", () => {
    const review: SwitchRecord = { ...switched, result: "needs-review", reasons: ["hash: outputHash changed"] };
    expect(latestEvent({ lastRun: run }, review)!.text).toContain("guard: hash: outputHash changed");

    const blocked: RunRecord = { ...run, at: "2026-11-26T03:00:00.000Z", status: "blocked", detail: "keep-old.patch for x: missing" };
    const state: RunState = { lastRun: blocked };
    expect(latestEvent(state, switched)!.text).toMatch(/^Update blocked \(2026-11-26\): nothing was switched/);

    const pending: RunState = { ...state, pending: { since: "2026-11-27T03:00:00.000Z", failure: { reason: "quota", message: "Quota exhausted" } } };
    expect(latestEvent(pending, switched)!.text).toContain("Update skipped — Quota exhausted");
  });
});

describe("CHANGES.md", () => {
  it("puts each run's entry on top", () => {
    const first = prependEntry(undefined, changesEntry(run));
    expect(first).toMatch(/^# Changes\n\nWritten by flake-agent, newest first.\n\n## 2026-11-25 — agent\/update-2026-11-25 \(green\)/);
    expect(first).toContain("- ✓ `nvf-ts-rename-2026-11` nvf: languages.ts → languages.typescript");
    expect(first).toContain("- ⚠ upstream `upstream-binary-removed-system-logoutd-2026-11` binary-removed system/logoutd: shadow-4.19.4");

    const files = changesEntry({ ...run, upstreamFiles: ["- file-changed etc/foo.conf"] });
    expect(files).toContain("- ⚠ upstream `upstream-file-changed-etc-foo.conf-2026-11` file-changed etc/foo.conf");

    const second = prependEntry(first, changesEntry({ ...run, at: "2026-12-02T03:00:00.000Z", branch: "agent/update-2026-12-02" }));
    expect(second.indexOf("2026-12-02")).toBeLessThan(second.indexOf("## 2026-11-25"));
    expect(second.match(/# Changes/g)).toHaveLength(1);
  });

  it("doesn't count towards the guard's diff limit, nor do keep-old patches and notes", () => {
    expect(countsTowardsLimit(".flake-agent/CHANGES.md")).toBe(false);
    expect(countsTowardsLimit(".flake-agent/changes/x-2026-11/keep-old.patch")).toBe(false);
    expect(countsTowardsLimit(".flake-agent/changes/x-2026-11/notes.md")).toBe(false);
    // anything else there could be imported by the config
    expect(countsTowardsLimit(".flake-agent/changes/x-2026-11/evil.nix")).toBe(true);
  });
});

describe("status", () => {
  it("shows the last run's changes, the generation and what the switch service did", async () => {
    const state = new StateStore(await mkdtemp(join(tmpdir(), "status-")));
    await state.save({ lastRun: run });
    const out: string[] = [];
    await status(state, (t) => out.push(t), { generation: 413, lastSwitch: { ...switched, result: "needs-review", reasons: ["hash: outputHash changed"] } });
    const text = out.join("");
    expect(text).toContain("Generation: 413");
    expect(text).toContain("⛔ tsls-hash-2026-11  needs review");
    expect(text).toContain("Last switch: needs-review");
    expect(text).toContain("⛔ guard: hash: outputHash changed");
    expect(text).toContain("⚠ upstream upstream-binary-removed-system-logoutd-2026-11  binary-removed system/logoutd: shadow-4.19.4");
  });
});

describe("show", () => {
  const neovim = (keymaps: Record<string, string>, lsp: Record<string, { cmd: string; resolves: boolean }>) => ({
    startup: { errors: [], warnings: [] },
    keymaps: { n: keymaps },
    plugins: [],
    lsp,
    parsers: [],
    health: [],
  });
  const zsh = (aliases: Record<string, string>) => ({ aliases, functions: [], bindings: {}, completion: { compinit: true, completions: 1 }, stderr: [] });
  const t3 = (n: object, z: object) => JSON.stringify({ tier: "T3", probes: { neovim: n, zsh: z } });

  it("lists the keymaps, aliases and servers the change affected, from the snapshots around it", async () => {
    const repo = await mkdtemp(join(tmpdir(), "show-"));
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=a", "-c", "user.email=a@x", "-C", repo, ...args], { encoding: "utf8" });
    const snap = join(repo, ".flake-agent/snapshots/laptop");
    await mkdir(snap, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    await writeFile(join(snap, "t3.json"), t3(neovim({ "<leader>f": "Telescope" }, { tailwindcss: { cmd: "tw", resolves: true } }), zsh({ ll: "ls -l" })));
    await writeFile(join(repo, "c.nix"), "{ languages.tailwind.enable = true; }\n");
    git("add", ".");
    git("commit", "-qm", "init");
    git("checkout", "-qb", "agent/update-2026-11-25");

    await writeFile(join(repo, "c.nix"), "{ lsp.presets.tailwindcss-language-server.enable = true; }\n");
    git("commit", "-qam", [
      "nvf: tailwind language → lsp preset",
      "",
      "Upstream: nvf 26.07 removed languages.tailwind.",
      "",
      "Change-Id: nvf-tailwind-2026-11\nChange-Class: behaviour\nUpstream: https://github.com/notashelf/nvf/pull/1",
    ].join("\n"));
    await mkdir(join(repo, ".flake-agent/changes/nvf-tailwind-2026-11"), { recursive: true });
    await writeFile(join(repo, ".flake-agent/changes/nvf-tailwind-2026-11/notes.md"), "The preset attaches only in tailwind projects.\n");
    await writeFile(join(repo, ".flake-agent/changes/nvf-tailwind-2026-11/keep-old.patch"), "diff\n");
    git("add", ".");
    git("commit", "-qm", "keep-old\n\nChange-Id: nvf-tailwind-2026-11\nChange-Class: behaviour\nUpstream: https://github.com/notashelf/nvf/pull/1");
    await writeFile(join(snap, "t3.json"), t3(neovim({ "<leader>f": "Telescope find_files" }, {}), zsh({})));
    git("commit", "-qam", "snapshots: probes on x");

    const text = (await showChange(repo, "nvf-tailwind-2026-11", "laptop"))!;
    expect(text).toContain("nvf-tailwind-2026-11 (behaviour) on agent/update-2026-11-25");
    // a prose line that looks like a trailer stays
    expect(text).toContain("Upstream: nvf 26.07 removed languages.tailwind.");
    expect(text).toContain("Upstream: https://github.com/notashelf/nvf/pull/1");
    expect(text).toContain("nvim-keymap-changed n <leader>f: Telescope → Telescope find_files");
    expect(text).toContain("nvim-lsp-missing tailwindcss: no longer configured");
    expect(text).toContain("zsh-alias-removed ll: ls -l");
    expect(text).toContain("The preset attaches only in tailwind projects.");
    expect(text).toContain("flake-agent revert nvf-tailwind-2026-11 applies .flake-agent/changes/nvf-tailwind-2026-11/keep-old.patch");
    expect(text).toContain("+{ lsp.presets.tailwindcss-language-server.enable = true; }");
    expect(text).not.toContain("t3.json");

    expect(await showChange(repo, "nope-2026-11", "laptop")).toBeUndefined();
    expect(text).toContain("(history: the run's snapshots, not built;");
  });

  it("builds the branch with and without the change, so later edits and stale snapshots don't show", async () => {
    const repo = await mkdtemp(join(tmpdir(), "show-built-"));
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=a", "-c", "user.email=a@x", "-C", repo, ...args], { encoding: "utf8" });
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    await writeFile(join(repo, "c.nix"), "{ languages.tailwind.enable = true; }\n");
    git("add", ".");
    git("commit", "-qm", "init");
    git("checkout", "-qb", "agent/update-2026-11-25");
    await writeFile(join(repo, "c.nix"), "{ lsp.presets.tailwind.enable = true; }\n");
    git("commit", "-qam", "nvf: tailwind language → lsp preset\n\nChange-Id: nvf-tailwind-2026-11\nChange-Class: behaviour");
    // the user's later alias, in its own file
    await writeFile(join(repo, "z.nix"), "{ shellAliases.ll = \"ls -l\"; }\n");
    git("add", ".");
    git("commit", "-qm", "zsh: ll");

    const config = async (dir: string) => (await Promise.all(["c.nix", "z.nix"].map((n) => readFile(join(dir, n), "utf8").catch(() => "")))).join("");
    const deps = {
      build: async (dir: string) => ({ ok: true, toplevel: `/nix/store/${(await config(dir)).length}-system` }),
      snapshot: async (dir: string) => {
        const text = await config(dir);
        return JSON.parse(
          t3(neovim({}, /languages\.tailwind/.test(text) ? { tailwindcss: { cmd: "tw", resolves: true } } : {}), zsh(/ll/.test(text) ? { ll: "ls -l" } : {})),
        ) as T3Snapshot;
      },
    };
    const text = (await showChange(repo, "nvf-tailwind-2026-11", "laptop", deps))!;
    expect(text).toMatch(/Affected keymaps, aliases and language servers \([0-9a-f]{12} built with and without it\):\n {2}nvim-lsp-missing tailwindcss/);
    expect(text).not.toContain("zsh-alias");

    const broken = { ...deps, build: async () => ({ ok: false, error: "error: boom" }) };
    expect(await showChange(repo, "nvf-tailwind-2026-11", "laptop", broken)).toContain("(history: the run's snapshots, does not build: error: boom;");
  });

  it("resolves an upstream-only id from the notes the run recorded", async () => {
    const repo = await mkdtemp(join(tmpdir(), "show-upstream-"));
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=a", "-c", "user.email=a@x", "-C", repo, ...args], { encoding: "utf8" });
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    await writeFile(join(repo, "c.nix"), "{ }\n");
    git("add", ".");
    git("commit", "-qm", "init");
    git("checkout", "-qb", "agent/update-2026-11-25");
    const [f] = upstreamFindings(run.behaviourChanges!, run.at);
    await mkdir(join(repo, dirname(upstreamNotesPath(f!.id))), { recursive: true });
    await writeFile(join(repo, upstreamNotesPath(f!.id)), upstreamNotes(f!, run));
    git("add", ".");
    git("commit", "-qm", "CHANGES.md: agent/update-2026-11-25 (green)");
    git("checkout", "-q", "main");

    const text = (await showChange(repo, f!.id, "laptop"))!;
    expect(text).toContain(`${f!.id} (upstream-only)`);
    expect(text).toContain("Finding: binary-removed system/logoutd: shadow-4.19.4");
    expect(text).toContain(`flake-agent revert ${f!.id} asks the agent`);
    expect(await showChange(repo, "upstream-nope-2026-11", "laptop")).toBeUndefined();
  });

  it("drops trailer paragraphs only", () => {
    expect(withoutTrailers("What changed.\n\nUpstream: prose that looks like a trailer\nand goes on.\n\nChange-Id: x\nUpstream: y\n\nCo-Authored-By: z")).toBe(
      "What changed.\n\nUpstream: prose that looks like a trailer\nand goes on.",
    );
  });
});
