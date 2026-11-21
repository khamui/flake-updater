import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Captured } from "../../src/nix/exec.js";
import { bwrapArgs, sandboxEnv, type Sandbox } from "../../src/probes/sandbox.js";
import { diffStarts, diffT2, normalise, runStarter, selectStarters, type T2Snapshot } from "../../src/probes/t2.js";
import {
  BUILTIN_VALIDATORS,
  loadCustomValidators,
  parseAlacrittyLog,
  selectValidators,
  sshHosts,
} from "../../src/probes/validators.js";

describe("sandbox", () => {
  it("hides the real home and swaps in the new system", () => {
    const args = bwrapArgs(
      { etc: { from: "/nix/store/new-etc/etc", onto: "/nix/store/old-etc/etc" }, system: { from: "/same", onto: "/same" } },
      "/tmp/flake-agent-x",
    );
    expect(args.join(" ")).toContain("--tmpfs /home --tmpfs /root");
    expect(args.join(" ")).toContain("--bind /nix/store/new-etc/etc /nix/store/old-etc/etc");
    // binding a path onto itself is skipped
    expect(args).not.toContain("/same");
  });

  it("points HOME and every scratch location into the scratch dir", () => {
    const env = sandboxEnv("/nix/store/sys", "kha", "/tmp/flake-agent-x");
    for (const key of ["HOME", "TMPDIR", "TMUX_TMPDIR", "XDG_RUNTIME_DIR"]) {
      expect(env[key]).toBe("/tmp/flake-agent-x");
    }
    expect(env.PATH!.split(":")[0]).toBe("/nix/store/sys/etc/profiles/per-user/kha/bin");
  });
});

describe("validator output", () => {
  it("parses alacritty's log into errors and warnings, incl. multi-line messages", () => {
    const log = [
      'Created log file at "/tmp/Alacritty-1.log"',
      "[0.000674626s] [WARN ] [alacritty_config_derive] Unused config key: bogus_key",
      '[0.000778052s] [ERROR] [alacritty_config_derive] Unable to load config "a.toml": Config error: TOML parse error at line 137, column 2',
      "                                                     |",
      "                                                 137 | [window]",
      "                                                 duplicate key",
      'Deleted log file at "/tmp/Alacritty-1.log"',
    ].join("\n");
    const r = parseAlacrittyLog(log);
    expect(r.warnings).toEqual(["[alacritty_config_derive] Unused config key: bogus_key"]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("TOML parse error");
    expect(r.errors[0]).toContain("duplicate key");
  });

  it("derives a concrete host for every Host pattern", () => {
    const config = "Host github.com\n  User git\nHost vps *.lan !bad\nHost *\n  ServerAliveInterval 30\n";
    expect(sshHosts(config)).toEqual(["github.com", "vps", "probe.lan", "probe"]);
  });

  it("removes the scratch home and store hashes from messages", () => {
    const msg = `/tmp/flake-agent-ab/.zshrc:31: not found /nix/store/${"a".repeat(32)}-starship-1.26/bin`;
    expect(normalise(msg, "/tmp/flake-agent-ab")).toBe("~/.zshrc:31: not found /nix/store/starship-1.26/bin");
  });
});

describe("registry", () => {
  it("selects validators for enabled programs only", () => {
    const names = selectValidators(new Set(["nvf", "tmux", "lazygit"]), BUILTIN_VALIDATORS).map((v) => v.name);
    expect(names).toEqual(["tmux", "neovim"]);
  });

  it("picks up per-repo custom validators next to the built-in ones", async () => {
    const repo = await mkdtemp(join(tmpdir(), "repo-"));
    await mkdir(join(repo, ".flake-agent", "probes"), { recursive: true });
    await writeFile(join(repo, ".flake-agent", "probes", "tmux.sh"), "tmux -V >&2\n");
    await writeFile(join(repo, ".flake-agent", "probes", "README.md"), "not a probe\n");

    const custom = await loadCustomValidators(repo);
    expect(custom.map((v) => v.name)).toEqual(["custom:tmux"]);

    const names = selectValidators(new Set(["tmux"]), [...BUILTIN_VALIDATORS, ...custom]).map((v) => v.name);
    expect(names).toEqual(["tmux", "custom:tmux"]);
  });

  it("runs a custom validator as a script inside the sandbox", async () => {
    const repo = await mkdtemp(join(tmpdir(), "repo-"));
    await mkdir(join(repo, ".flake-agent", "probes"), { recursive: true });
    await writeFile(join(repo, ".flake-agent", "probes", "foot.sh"), "foot --check-config\n");
    const [validator] = await loadCustomValidators(repo);

    const calls: { cmd: string; args: string[]; input?: string }[] = [];
    const sb: Sandbox = {
      toplevel: "/sys",
      user: "kha",
      home: "/tmp/h",
      exec: async (cmd, args, opts): Promise<Captured> => {
        calls.push({ cmd, args, input: opts?.input });
        return { code: 1, stdout: "", stderr: "unknown option: fnt\n" };
      },
      dispose: async () => {},
    };
    expect(await validator!.run(sb)).toEqual({ errors: ["unknown option: fnt"], warnings: [] });
    expect(calls).toEqual([{ cmd: "sh", args: ["-s"], input: "foot --check-config\n" }]);
  });
});

describe("diffT2", () => {
  const snap = (results: T2Snapshot["results"]): T2Snapshot => ({ tier: "T2", results });

  it("is empty when nothing new is reported", () => {
    const s = snap({ ssh: { errors: [], warnings: ["vps: Pseudo-terminal will not be allocated"] } });
    expect(diffT2(s, s)).toEqual([]);
  });

  it("fails on any error and on new warnings only", () => {
    const old = snap({ starship: { errors: [], warnings: ["old warning"] } });
    const next = snap({
      starship: { errors: [], warnings: ["old warning", "Unknown key 'foo'"] },
      alacritty: { errors: ["TOML parse error"], warnings: [] },
    });
    expect(diffT2(old, next).map((f) => [f.severity, f.kind, f.subject, f.detail])).toEqual([
      ["fail", "validator-warning", "starship", "Unknown key 'foo'"],
      ["fail", "validator-error", "alacritty", "TOML parse error"],
    ]);
  });
});

describe("starts cleanly", () => {
  const sb = (exec: Sandbox["exec"]): Sandbox => ({ toplevel: "/nix/store/sys", user: "kha", home: "/tmp/flake-agent-x", exec, dispose: async () => {} });
  const ok = (stderr = ""): Captured => ({ code: 0, stdout: "x 1.0\n", stderr });

  it("checks enabled programs with an obvious binary that no validator covers", () => {
    const enabled = new Map<string, string | null>([["helix", "hx"], ["tmux", "tmux"], ["dconf", null], ["bat", "bat"]]);
    const { starters, unchecked } = selectStarters(enabled, selectValidators(new Set(enabled.keys()), BUILTIN_VALIDATORS));
    expect(starters).toEqual([{ program: "bat", bin: "bat" }, { program: "helix", bin: "hx" }]);
    expect(unchecked).toEqual({ dconf: "no obvious binary" });
  });

  it("runs only --version, and says when the binary isn't there", async () => {
    const calls: string[] = [];
    const r = await runStarter(sb(async (cmd, args) => (calls.push([cmd, ...args].join(" ")), ok())), { program: "helix", bin: "hx" });
    expect(r).toEqual({ code: 0, stderr: [] });
    expect(calls).toEqual(['sh -c command -v "$1" sh hx', "hx --version"]);
    const missing = await runStarter(sb(async () => ({ code: 1, stdout: "", stderr: "" })), { program: "helix", bin: "hx" });
    expect(missing).toEqual({ unchecked: "hx not installed", missing: true });
  });

  it("gives up on a hanging binary: unchecked, not failed", async () => {
    const hang = sb(async (cmd) => (cmd === "sh" ? ok() : new Promise<Captured>(() => {})));
    const started = Date.now();
    // the race allows the timeout plus 2 s for a binary whose output stays open
    expect(await runStarter(hang, { program: "x", bin: "x" }, 10)).toEqual({ unchecked: "x --version timed out after 0.01 s" });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await runStarter(sb(async (cmd) => (cmd === "sh" ? ok() : { code: 124, stdout: "", stderr: "timed out" })), { program: "x", bin: "x" })).toMatchObject({ unchecked: expect.stringMatching(/timed out/) });
  });

  it("strips PIDs and timestamps from stderr", async () => {
    const r = await runStarter(sb(async (cmd) => (cmd === "sh" ? ok() : ok("(process:326137): thunar-WARNING **: 15:16:17.683: no display\n"))), { program: "thunar", bin: "thunar" });
    expect(r).toEqual({ code: 0, stderr: ["(process:N): thunar-WARNING **: N:N:N.N: no display"] });
  });

  it("fails a program that started cleanly before and now rejects the config", () => {
    const before = { helix: { code: 0, stderr: [] } };
    const after = { helix: { code: 1, stderr: ["Error: unknown field `editor.foo` in config.toml"] } };
    expect(diffStarts(before, after)).toEqual([
      { severity: "fail", kind: "start-failed", subject: "helix", detail: "--version exited with 1: Error: unknown field `editor.foo` in config.toml" },
      { severity: "fail", kind: "start-stderr", subject: "helix", detail: "Error: unknown field `editor.foo` in config.toml" },
    ]);
  });

  it("checks a newly enabled program against nothing, and leaves what was already broken or unchecked", () => {
    const missing = { helix: { unchecked: "hx not installed", missing: true as const } };
    expect(diffStarts(missing, { helix: { code: 2, stderr: [] } }).map((f) => f.kind)).toEqual(["start-failed"]);
    expect(diffStarts({}, { helix: { code: 0, stderr: ["note"] } })).toEqual([]);
    // rofi without a display: exits 1 on both sides
    const rofi = { rofi: { code: 1, stderr: ["No valid backend"] } };
    expect(diffStarts(rofi, rofi)).toEqual([]);
    expect(diffStarts({ x: { unchecked: "x --version timed out after 5 s" } }, { x: { code: 1, stderr: [] } })).toEqual([]);
    expect(diffStarts({ x: { code: 0, stderr: [] } }, { x: { unchecked: "no obvious binary" } })).toEqual([]);
  });

  it("is part of diffT2", () => {
    const t2 = (starts: T2Snapshot["starts"]): T2Snapshot => ({ tier: "T2", results: {}, starts });
    expect(diffT2(t2({ bat: { code: 0, stderr: [] } }), t2({ bat: { code: 1, stderr: [] } })).map((f) => f.kind)).toEqual(["start-failed"]);
  });
});
