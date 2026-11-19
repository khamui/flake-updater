import { chmod, cp, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { capture, which, type CaptureOptions, type Captured } from "../nix/exec.js";
import { nixStore, type Store } from "../nix/store.js";
import { homeGeneration } from "../nix/system.js";

/** Programs run against a system toplevel with a scratch HOME, never the real one. */
export interface Sandbox {
  toplevel: string;
  user: string;
  /** Scratch HOME holding a copy of the generation's HM files. */
  home: string;
  exec(cmd: string, args: string[], opts?: Omit<CaptureOptions, "cwd">): Promise<Captured>;
  dispose(): Promise<void>;
}

export interface Binds {
  /** New `etc` tree and the live one it replaces (`/etc/static` resolved). */
  etc?: { from: string; onto: string };
  /** New toplevel and the live one it replaces (`/run/current-system` resolved). */
  system?: { from: string; onto: string };
}

/**
 * bwrap arguments: the real filesystem, with the live system's etc and toplevel
 * swapped for the new build's (so shells started by a probe pick up the new
 * PATH and /etc) and an empty tmpfs over /home and /root.
 */
export function bwrapArgs(binds: Binds, home: string): string[] {
  const args = ["--dev-bind", "/", "/", "--die-with-parent"];
  for (const bind of [binds.etc, binds.system]) {
    if (bind && bind.from !== bind.onto) args.push("--bind", bind.from, bind.onto);
  }
  args.push("--tmpfs", "/home", "--tmpfs", "/root", "--chdir", home);
  return args;
}

export function sandboxEnv(toplevel: string, user: string, home: string): Record<string, string> {
  return {
    HOME: home,
    USER: user,
    LOGNAME: user,
    PATH: [`${toplevel}/etc/profiles/per-user/${user}/bin`, `${toplevel}/sw/bin`, "/run/wrappers/bin"].join(":"),
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    TMPDIR: home,
    TMUX_TMPDIR: home,
    XDG_RUNTIME_DIR: home,
  };
}

async function resolved(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

export async function openSandbox(toplevel: string, user: string, store: Store = nixStore): Promise<Sandbox> {
  const bwrap = await which("bwrap");
  if (!bwrap) throw new Error("bwrap not found: probes need it to hide the real home");

  // short path: unix socket paths (tmux, alacritty) are limited to ~100 bytes
  const home = await mkdtemp("/tmp/flake-agent-");

  const gen = await homeGeneration(store, toplevel, user);
  if (gen) {
    await cp(await realpath(`${gen}/home-files`), home, { recursive: true, verbatimSymlinks: true });
    await makeDirsWritable(home);
  }

  const binds: Binds = {};
  const [newEtc, liveEtc, newSystem, liveSystem] = await Promise.all([
    resolved(`${toplevel}/etc`),
    resolved("/etc/static"),
    resolved(toplevel),
    resolved("/run/current-system"),
  ]);
  if (newEtc && liveEtc) binds.etc = { from: newEtc, onto: liveEtc };
  if (newSystem && liveSystem) binds.system = { from: newSystem, onto: liveSystem };

  const base = sandboxEnv(toplevel, user, home);
  const prefix = bwrapArgs(binds, home);
  return {
    toplevel,
    user,
    home,
    exec: (cmd, args, opts = {}) =>
      capture(bwrap, [...prefix, "--", cmd, ...args], { ...opts, env: { ...base, ...opts.env } }),
    dispose: () => rm(home, { recursive: true, force: true }),
  };
}

/** Directories copied from the store are read-only; programs need to write state into HOME. */
async function makeDirsWritable(dir: string): Promise<void> {
  await chmod(dir, 0o755);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeDirsWritable(join(dir, entry.name));
  }
}
