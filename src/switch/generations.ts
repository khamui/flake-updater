import { lstat, readdir, readlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { capture, run } from "../nix/exec.js";

export const SYSTEM_PROFILE = "/nix/var/nix/profiles/system";

export interface Generation {
  number: number;
  /** Link mtime: when the generation was created. */
  createdMs: number;
}

/** Generations of a profile (`<name>-<n>-link` next to it) and the current one. */
export async function listGenerations(profile: string): Promise<{ generations: Generation[]; current?: number }> {
  const dir = dirname(profile);
  const name = basename(profile);
  const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)-link$`);
  const generations: Generation[] = [];
  for (const entry of await readdir(dir)) {
    const m = re.exec(entry);
    if (m) generations.push({ number: Number(m[1]), createdMs: (await lstat(join(dir, entry))).mtimeMs });
  }
  generations.sort((a, b) => a.number - b.number);
  let current: number | undefined;
  try {
    current = Number(re.exec(await readlink(profile))?.[1]);
  } catch {
    // no profile link
  }
  return { generations, current };
}

/** `7d` → milliseconds (nix only accepts days here). */
export function parseAge(age: string): number {
  const m = /^(\d+)d$/.exec(age);
  if (!m) throw new Error(`unsupported age ${age} (expected <n>d)`);
  return Number(m[1]) * 86_400_000;
}

/**
 * Generations to delete: older than `maxAgeMs`, but never the current one and
 * never one of the newest `keep`.
 */
export function selectForDeletion(gens: Generation[], current: number | undefined, maxAgeMs: number, keep: number, nowMs: number): number[] {
  const newest = new Set(
    [...gens]
      .sort((a, b) => b.number - a.number)
      .slice(0, keep)
      .map((g) => g.number),
  );
  return gens
    .filter((g) => g.number !== current && !newest.has(g.number) && nowMs - g.createdMs > maxAgeMs)
    .map((g) => g.number);
}

/** Profiles under a directory (recursively): every `<name>` that has `<name>-<n>-link` siblings. */
export async function findProfiles(root: string): Promise<string[]> {
  const out = new Set<string>();
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const m = /^(.+)-\d+-link$/.exec(e.name);
      if (m) out.add(join(dir, m[1]!));
      else if (e.isDirectory()) await walk(join(dir, e.name));
    }
  };
  await walk(root);
  return [...out].sort();
}

/**
 * `nix-collect-garbage --delete-older-than <age>` that keeps the newest
 * `keepSystem` system generations whatever their age; other profiles keep
 * their current generation as usual.
 */
export async function collectGarbage(opts: { age?: string; keepSystem: number; profilesRoot?: string; now?: number; out: (t: string) => void }): Promise<void> {
  if (opts.age) {
    const maxAge = parseAge(opts.age);
    for (const profile of await findProfiles(opts.profilesRoot ?? "/nix/var/nix/profiles")) {
      const { generations, current } = await listGenerations(profile);
      const keep = profile === SYSTEM_PROFILE ? opts.keepSystem : 1;
      const doomed = selectForDeletion(generations, current, maxAge, keep, opts.now ?? Date.now());
      if (!doomed.length) continue;
      opts.out(`${profile}: deleting generations ${doomed.join(" ")}\n`);
      await run("nix-env", ["-p", profile, "--delete-generations", ...doomed.map(String)]);
    }
  }
  const gc = await capture("nix-store", ["--gc"], { env: process.env as Record<string, string>, timeoutMs: 6 * 3600_000 });
  opts.out(gc.stdout.split("\n").filter(Boolean).slice(-1).join("") + "\n");
  if (gc.code !== 0) throw new Error(`nix-store --gc failed: ${gc.stderr.trim()}`);
}
