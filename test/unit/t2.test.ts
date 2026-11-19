import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Captured } from "../../src/nix/exec.js";
import { bwrapArgs, sandboxEnv, type Sandbox } from "../../src/probes/sandbox.js";
import { diffT2, normalise, type T2Snapshot } from "../../src/probes/t2.js";
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
