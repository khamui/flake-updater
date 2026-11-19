import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import { alacrittyProbe, bindingId, bindingsOf, type AlacrittyCapture } from "../../src/probes/deep/alacritty.js";
import { parseListKeys, parseOptions, tmuxProbe, type TmuxCapture } from "../../src/probes/deep/tmux.js";
import { parseZshCapture, zshProbe, type ZshCapture } from "../../src/probes/deep/zsh.js";

const kinds = (findings: { severity: string; kind: string; subject: string }[]) =>
  findings.map((f) => [f.severity, f.kind, f.subject]);

describe("zsh deep probe", () => {
  const stdout = [
    "@@aliases",
    "k=cd ~",
    "v=nvim",
    "@@galiases",
    "G=| grep",
    "@@saliases",
    "@@functions",
    "lg",
    "_git",
    "compdef",
    "@@bindkey",
    'bindkey "^A" beginning-of-line',
    'bindkey -R "!"-"~" self-insert',
    "@@completion",
    "1 1850",
  ].join("\n");
  const base: ZshCapture = { ...parseZshCapture(stdout), stderr: [] };

  it("parses aliases, functions, bindings and completion", () => {
    expect(base).toEqual({
      aliases: { "-g G": "| grep", k: "cd ~", v: "nvim" },
      functions: ["compdef", "lg"],
      bindings: { '"^A"': "beginning-of-line", '-R "!"-"~"': "self-insert" },
      completion: { compinit: true, completions: 1850 },
      stderr: [],
    });
  });

  it("is empty for the same capture", () => {
    expect(zshProbe.diff(base, base)).toEqual([]);
  });

  it("fails on a removed alias or binding and on any stderr", () => {
    const next: ZshCapture = {
      ...base,
      aliases: { "-g G": "| grep", v: "nvim" },
      bindings: { '"^A"': "vi-beginning-of-line", '-R "!"-"~"': "self-insert" },
      stderr: ["~/.zshrc:12: command not found: starship"],
    };
    expect(kinds(zshProbe.diff(base, next))).toEqual([
      ["fail", "zsh-startup-stderr", "zsh"],
      ["fail", "zsh-alias-removed", "k"],
      ["fail", "zsh-binding-changed", '"^A"'],
    ]);
  });

  it("fails when compinit is gone", () => {
    const next = { ...base, completion: { compinit: false, completions: 0 } };
    expect(kinds(zshProbe.diff(base, next))).toEqual([["fail", "zsh-completion-missing", "compinit"]]);
  });
});

describe("tmux deep probe", () => {
  const keys = [
    "bind-key    -T copy-mode-vi C-h               select-pane -L",
    "bind-key -r -T prefix       M-j               split-window -v",
    'bind-key    -T root         C-h               if-shell "$is_vim" "send-keys C-h" "select-pane -L"',
  ].join("\n");
  const base: TmuxCapture = {
    prefix: "C-n",
    bindings: parseListKeys(keys),
    options: { ...parseOptions("base-index 1\nmouse on", "session"), ...parseOptions("mode-keys vi", "window") },
    errors: [],
  };

  it("parses list-keys per table and options per scope", () => {
    expect(base.bindings).toEqual({
      "copy-mode-vi C-h": "select-pane -L",
      "prefix M-j": "-r split-window -v",
      "root C-h": 'if-shell "$is_vim" "send-keys C-h" "select-pane -L"',
    });
    expect(base.options).toEqual({ "session:base-index": "1", "session:mouse": "on", "window:mode-keys": "vi" });
  });

  it("is empty for the same capture", () => {
    expect(tmuxProbe.diff(base, base)).toEqual([]);
  });

  it("fails on a removed binding or prefix change, reports option changes as info", () => {
    const { ["root C-h"]: _, ...bindings } = base.bindings;
    const next = { ...base, prefix: "C-b", bindings, options: { ...base.options, "session:mouse": "off" } };
    expect(kinds(tmuxProbe.diff(base, next))).toEqual([
      ["fail", "tmux-prefix-changed", "prefix"],
      ["fail", "tmux-binding-removed", "root C-h"],
      ["info", "tmux-option-changed", "session:mouse"],
    ]);
  });
});

describe("alacritty deep probe", () => {
  const config = parse(`
[[keyboard.bindings]]
action = "Paste"
key = "V"
mods = "Shift|Control"

[[keyboard.bindings]]
chars = "\\u001b"
key = "Escape"
mode = "Vi"
`) as Record<string, unknown>;

  const base: AlacrittyCapture = {
    config: "~/.config/alacritty/alacritty.toml",
    configHash: "h1",
    bindings: bindingsOf(config),
    errors: [],
    warnings: [],
  };

  it("keys bindings by sorted mods, key and mode", () => {
    expect(bindingId({ key: "V", mods: "Shift|Control" })).toBe("Control|Shift+V");
    expect(base.bindings).toEqual({ "Control|Shift+V": "Paste", "Escape [Vi]": 'chars "\\u001b"' });
  });

  it("reads pre-0.13 key_bindings too", () => {
    expect(bindingsOf({ key_bindings: [{ key: "N", mods: "Control", action: "SpawnNewInstance" }] })).toEqual({
      "Control+N": "SpawnNewInstance",
    });
  });

  it("is empty for the same capture", () => {
    expect(alacrittyProbe.diff(base, base)).toEqual([]);
  });

  it("fails on a removed binding and on config errors", () => {
    const next = {
      ...base,
      configHash: "h2",
      bindings: { "Control|Shift+V": "Paste" },
      errors: ["Config error: TOML parse error at line 3"],
    };
    expect(kinds(alacrittyProbe.diff(base, next))).toEqual([
      ["fail", "alacritty-config-error", "alacritty"],
      ["info", "alacritty-config-changed", "~/.config/alacritty/alacritty.toml"],
      ["fail", "alacritty-binding-removed", "Escape [Vi]"],
    ]);
  });
});
