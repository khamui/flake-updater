import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { Sandbox } from "./sandbox.js";

export interface ValidatorResult {
  errors: string[];
  warnings: string[];
}

export interface Validator {
  name: string;
  /** `programs.<name>.enable` (NixOS or HM) that turns this validator on. */
  programs: string[];
  run(sb: Sandbox): Promise<ValidatorResult>;
}

/** Custom validators: `.flake-agent/probes/<program>.sh` in the config repo. */
export function customProbeDir(repo: string): string {
  return join(repo, ".flake-agent", "probes");
}

export function lines(text: string): string[] {
  return text.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
}

/** Exit code decides: non-zero → stderr is errors, zero → stderr is warnings. */
function byExitCode(code: number, stderr: string, what: string): ValidatorResult {
  const out = lines(stderr);
  if (code === 0) return { errors: [], warnings: out };
  return { errors: out.length ? out : [`${what} exited with ${code}`], warnings: [] };
}

function merge(...results: ValidatorResult[]): ValidatorResult {
  return { errors: results.flatMap((r) => r.errors), warnings: results.flatMap((r) => r.warnings) };
}

async function exists(sb: Sandbox, rel: string): Promise<boolean> {
  return (await sb.exec("test", ["-e", `${sb.home}/${rel}`])).code === 0;
}

/** Alacritty log lines: `[0.0006s] [WARN ] [alacritty_config_derive] Unused config key: x`. */
export function parseAlacrittyLog(log: string): ValidatorResult {
  const result: ValidatorResult = { errors: [], warnings: [] };
  let current: string[] | undefined;
  for (const line of log.split("\n")) {
    const m = /^\[[\d.]+s\] \[(ERROR|WARN)\s*\] (.*)$/.exec(line);
    if (m) {
      current = m[1] === "ERROR" ? result.errors : result.warnings;
      current.push(m[2]!);
    } else if (current && /^\s+\S/.test(line)) {
      // continuation of a multi-line message (e.g. a TOML parse error)
      current[current.length - 1] += `\n${line.trim()}`;
    } else {
      current = undefined;
    }
  }
  return result;
}

/** Hosts to resolve with `ssh -G`: every non-negated `Host` pattern, wildcards made concrete. */
export function sshHosts(config: string): string[] {
  const hosts = new Set<string>();
  for (const line of config.split("\n")) {
    const m = /^\s*Host\s+(.+)$/i.exec(line);
    if (!m) continue;
    for (const pattern of m[1]!.trim().split(/\s+/)) {
      if (pattern.startsWith("!")) continue;
      hosts.add(pattern.replace(/\*/g, "probe").replace(/\?/g, "x"));
    }
  }
  return [...hosts];
}

/** Starts Xvfb and returns its display, or undefined if it can't start. */
async function withXvfb<T>(fn: (display: string | undefined) => Promise<T>): Promise<T> {
  const xvfb = spawn("Xvfb", ["-displayfd", "1", "-nolisten", "tcp"], { stdio: ["ignore", "pipe", "ignore"] });
  const display = await new Promise<string | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 10_000);
    xvfb.on("error", () => resolve(undefined));
    xvfb.stdout.once("data", (d: Buffer) => {
      clearTimeout(timer);
      resolve(`:${d.toString().trim()}`);
    });
  });
  try {
    return await fn(display);
  } finally {
    xvfb.kill();
  }
}

const alacritty: Validator = {
  name: "alacritty",
  programs: ["alacritty"],
  async run(sb) {
    const migrate = await sb.exec("alacritty", ["migrate", "--dry-run"]);
    const parsed = byExitCode(migrate.code, migrate.code === 0 ? "" : migrate.stderr + migrate.stdout, "alacritty migrate");
    // config warnings (unknown keys, deprecations) are only logged by a real launch
    const launch = await withXvfb(async (display) => {
      if (!display) return { errors: [], warnings: ["Xvfb unavailable: launch check skipped"] };
      const r = await sb.exec("alacritty", ["-e", "true"], { env: { DISPLAY: display }, timeoutMs: 20_000 });
      return parseAlacrittyLog(r.stdout + r.stderr);
    });
    return merge(parsed, launch);
  },
};

const tmux: Validator = {
  name: "tmux",
  programs: ["tmux"],
  async run(sb) {
    const conf = (await exists(sb, ".config/tmux/tmux.conf")) ? ".config/tmux/tmux.conf" : ".tmux.conf";
    // config errors are only reported for an explicit source-file into a running server
    const r = await sb.exec("tmux", ["-L", "probe", "-f", "/dev/null", "new-session", "-d", ";", "source-file", `${sb.home}/${conf}`]);
    await sb.exec("tmux", ["-L", "probe", "kill-server"]);
    return byExitCode(r.code, r.stderr, "tmux");
  },
};

const ZSH_FILES = [".zshenv", ".zprofile", ".zshrc", ".zlogin"];

const zsh: Validator = {
  name: "zsh",
  programs: ["zsh"],
  async run(sb) {
    const results: ValidatorResult[] = [];
    for (const file of ZSH_FILES) {
      if (!(await exists(sb, file))) continue;
      const r = await sb.exec("zsh", ["-n", `${sb.home}/${file}`]);
      results.push(byExitCode(r.code, r.stderr, `zsh -n ${file}`));
    }
    const interactive = await sb.exec("zsh", ["-i", "-c", "exit"]);
    results.push({ errors: [], warnings: lines(interactive.stderr) });
    return merge(...results);
  },
};

const neovim: Validator = {
  name: "neovim",
  programs: ["neovim", "nvf"],
  async run(sb) {
    const r = await sb.exec("nvim", ["--headless", "+lua io.stdout:write(vim.fn.execute('messages'))", "+qa"]);
    const errors = lines(r.stderr);
    const warnings: string[] = [];
    for (const line of lines(r.stdout)) {
      if (/^E\d+:|error/i.test(line)) errors.push(line);
      else if (/warn|deprecat/i.test(line)) warnings.push(line);
    }
    if (r.code !== 0 && errors.length === 0) errors.push(`nvim exited with ${r.code}`);
    return { errors, warnings };
  },
};

const git: Validator = {
  name: "git",
  programs: ["git"],
  async run(sb) {
    const r = await sb.exec("git", ["config", "-l"]);
    return byExitCode(r.code, r.stderr, "git config");
  },
};

const starship: Validator = {
  name: "starship",
  programs: ["starship"],
  async run(sb) {
    const r = await sb.exec("starship", ["print-config"]);
    return byExitCode(r.code, r.stderr, "starship");
  },
};

const ssh: Validator = {
  name: "ssh",
  programs: ["ssh"],
  async run(sb) {
    const config = `${sb.home}/.ssh/config`;
    const text = await sb.exec("cat", [config]);
    if (text.code !== 0) return { errors: [], warnings: [] };
    const results: ValidatorResult[] = [];
    for (const host of sshHosts(text.stdout)) {
      const r = await sb.exec("ssh", ["-F", config, "-G", host]);
      results.push(byExitCode(r.code, r.stderr.split("\n").map((l) => (l ? `${host}: ${l}` : l)).join("\n"), `ssh -G ${host}`));
    }
    return merge(...results);
  },
};

export const BUILTIN_VALIDATORS: Validator[] = [alacritty, tmux, zsh, neovim, git, starship, ssh];

/**
 * A custom validator is a shell script, run with `sh -s` inside the sandbox
 * (the repo itself may live under the hidden /home). Exit code non-zero → its
 * stderr lines are errors; zero → warnings.
 */
export function scriptValidator(program: string, script: string): Validator {
  return {
    name: `custom:${program}`,
    programs: [program],
    async run(sb) {
      const r = await sb.exec("sh", ["-s"], { input: script });
      return byExitCode(r.code, r.stderr, `${program} probe`);
    },
  };
}

export async function loadCustomValidators(repo: string): Promise<Validator[]> {
  const dir = customProbeDir(repo);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => extname(n) === ".sh").sort();
  } catch {
    return [];
  }
  return Promise.all(
    names.map(async (n) => scriptValidator(basename(n, ".sh"), await readFile(join(dir, n), "utf8"))),
  );
}

/** Validators for the enabled programs; custom ones run alongside the built-in ones. */
export function selectValidators(enabled: Set<string>, validators: Validator[]): Validator[] {
  return validators.filter((v) => v.programs.some((p) => enabled.has(p)));
}

