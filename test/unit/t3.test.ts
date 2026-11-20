import { describe, expect, it } from "vitest";
import { DEEP_PROBES } from "../../src/probes/deep/index.js";
import { classifyStartup, neovimProbe, type NeovimCapture } from "../../src/probes/deep/neovim.js";
import { diffT3, selectDeepProbes } from "../../src/probes/t3.js";

const base: NeovimCapture = {
  startup: { errors: [], warnings: [] },
  keymaps: {
    i: { jk: "<Esc>", "<C-S>": "<callback: vim.lsp.buf.signature_help()>" },
    n: { "<leader> ": "<cmd>HopWord<CR>" },
  },
  plugins: ["hop.nvim", "vim-tmux-navigator"],
  lsp: {
    "bash-language-server": { cmd: "/nix/store/bash-language-server-5.8.1/bin/bash-language-server", resolves: true },
    nil: { cmd: "/nix/store/nil-2026-07-23/bin/nil", resolves: true },
  },
  parsers: ["bash", "lua", "nix"],
  health: ["- ⚠️ WARNING Unknown filetype 'ash'"],
};

const kinds = (old: NeovimCapture, next: NeovimCapture) =>
  neovimProbe.diff(old, next).map((f) => [f.severity, f.kind, f.subject]);

describe("neovim deep probe", () => {
  it("is empty for the same capture", () => {
    expect(neovimProbe.diff(base, base)).toEqual([]);
  });

  it("fails on a removed or changed keymap, reports added ones", () => {
    const next = { ...base, keymaps: { i: { "<C-S>": "<callback: other>" }, n: { ...base.keymaps.n, "<leader>f": "<cmd>Telescope<CR>" } } };
    expect(kinds(base, next)).toEqual([
      ["fail", "nvim-keymap-removed", "i jk"],
      ["fail", "nvim-keymap-changed", "i <C-S>"],
      ["info", "nvim-keymap-added", "n <leader>f"],
    ]);
  });

  it("fails when a language's LSP server and parser go missing", () => {
    const next = { ...base, lsp: { nil: base.lsp.nil! }, parsers: ["lua", "nix"] };
    expect(kinds(base, next)).toEqual([
      ["fail", "nvim-lsp-missing", "bash-language-server"],
      ["fail", "nvim-parser-missing", "bash"],
    ]);
  });

  it("fails when an LSP command no longer resolves", () => {
    const next = { ...base, lsp: { ...base.lsp, nil: { ...base.lsp.nil!, resolves: false } } };
    expect(kinds(base, next)).toEqual([["fail", "nvim-lsp-missing", "nil"]]);
  });

  it("fails when a server attaches to fewer filetypes or changes whether it needs a workspace root", () => {
    const tw = (filetypes: string[], workspaceRequired: boolean) => ({ cmd: "tw", resolves: true, filetypes, workspaceRequired });
    const old = { ...base, lsp: { tailwindcss: tw(["css", "html"], false) } };
    expect(kinds(old, { ...base, lsp: { tailwindcss: tw(["css", "svelte"], true) } })).toEqual([
      ["fail", "nvim-lsp-filetypes-removed", "tailwindcss"],
      ["info", "nvim-lsp-filetypes-added", "tailwindcss"],
      ["fail", "nvim-lsp-workspace", "tailwindcss"],
    ]);
    // snapshots from before these were captured compare as unchanged
    expect(kinds(base, { ...base, lsp: { ...base.lsp, nil: { ...base.lsp.nil!, filetypes: ["nix"], workspaceRequired: true } } })).toEqual([]);
  });

  it("fails on any startup error, even one the old config had", () => {
    const broken = { ...base, startup: { errors: ["E5113: Lua chunk: init.lua:2: boom"], warnings: [] } };
    expect(kinds(broken, broken)).toEqual([["fail", "nvim-startup-error", "neovim"]]);
  });

  it("reports plugins and new health warnings as info, new health errors as failures", () => {
    const next = {
      ...base,
      plugins: ["vim-tmux-navigator"],
      health: [...base.health, "- ⚠️ WARNING new one", "- ❌ ERROR Parser bash failed to load"],
    };
    expect(kinds(base, next)).toEqual([
      ["info", "nvim-plugin-missing", "hop.nvim"],
      ["info", "nvim-health-warning", "neovim"],
      ["fail", "nvim-health-error", "neovim"],
    ]);
  });

  it("dedupes startup errors from stderr and :messages and drops traceback lines", () => {
    const err = "Error in VIMINIT..script init.lua:\nE5113: Lua chunk: init.lua:2: boom\nstack traceback:\n\t[C]: in function 'error'\n\tinit.lua:2: in main chunk\n";
    expect(classifyStartup(err, err)).toEqual({
      errors: ["Error in VIMINIT..script init.lua:", "E5113: Lua chunk: init.lua:2: boom"],
      warnings: [],
    });
  });
});

describe("T3", () => {
  it("selects deep probes by enabled program", () => {
    expect(selectDeepProbes(new Set(["nvf"]), DEEP_PROBES).map((p) => p.name)).toEqual(["neovim"]);
    expect(selectDeepProbes(new Set(["git"]), DEEP_PROBES)).toEqual([]);
  });

  it("only diffs probes captured on both sides", () => {
    const old = { tier: "T3" as const, probes: {} };
    const next = { tier: "T3" as const, probes: { neovim: base } };
    expect(diffT3(old, next, DEEP_PROBES)).toEqual([]);
  });
});

describe("snapshot files", () => {
  it("serialise the same capture identically whatever the key order", async () => {
    const { canonical } = await import("../../src/probes/snapshots.js");
    expect(JSON.stringify(canonical({ b: { y: 1, x: [{ d: 1, c: 2 }] }, a: 1 }))).toBe('{"a":1,"b":{"x":[{"c":2,"d":1}],"y":1}}');
  });
});
