import { mkdir, open, readdir, readFile, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { PreflightFailure } from "./subscription.js";

const POWER = "/sys/class/power_supply";

async function read(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return undefined;
  }
}

/** On mains power? A machine without a battery always is. */
export async function onAC(root = POWER): Promise<boolean> {
  let supplies: string[];
  try {
    supplies = await readdir(root);
  } catch {
    return true;
  }
  let sawBattery = false;
  for (const s of supplies) {
    const type = await read(join(root, s, "type"));
    if (type === "Mains" && (await read(join(root, s, "online"))) === "1") return true;
    if (type === "Battery") {
      sawBattery = true;
      if ((await read(join(root, s, "status"))) === "Discharging") return false;
    }
  }
  return !sawBattery;
}

export async function freeGB(path: string): Promise<number> {
  const s = await statfs(path);
  return (s.bavail * s.bsize) / 1024 ** 3;
}

/** The run lock: a file holding the pid of the run that owns it. */
export function lockPath(stateDir: string): string {
  return join(stateDir, "run.lock");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Pid holding the lock, or undefined if free (a stale lock from a dead pid is free). */
export async function lockHolder(stateDir: string): Promise<number | undefined> {
  const pid = Number(await read(lockPath(stateDir)));
  return pid && alive(pid) ? pid : undefined;
}

/** Take the run lock; returns a release function, or undefined if another run holds it. */
export async function acquireLock(stateDir: string): Promise<(() => Promise<void>) | undefined> {
  if (await lockHolder(stateDir)) return undefined;
  await mkdir(stateDir, { recursive: true });
  await rm(lockPath(stateDir), { force: true });
  try {
    const file = await open(lockPath(stateDir), "wx");
    await file.writeFile(String(process.pid));
    await file.close();
  } catch {
    return undefined; // lost a race
  }
  return () => rm(lockPath(stateDir), { force: true });
}

export interface EnvironmentOptions {
  stateDir: string;
  minFreeGB: number;
  storePath?: string;
  powerRoot?: string;
}

export async function checkEnvironment(opts: EnvironmentOptions): Promise<PreflightFailure | null> {
  if (!(await onAC(opts.powerRoot))) return { reason: "power", message: "On battery: runs only on AC power" };
  const free = await freeGB(opts.storePath ?? "/nix");
  if (free < opts.minFreeGB) {
    return { reason: "disk", message: `Only ${free.toFixed(1)} GB free on ${opts.storePath ?? "/nix"} (need ${opts.minFreeGB})` };
  }
  const holder = await lockHolder(opts.stateDir);
  if (holder) return { reason: "locked", message: `Another run is in progress (pid ${holder})` };
  return null;
}
