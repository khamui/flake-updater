import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Per-repo snapshot directory: `.flake-agent/snapshots/<host>/`. */
export function snapshotDir(repo: string, host: string): string {
  return join(repo, ".flake-agent", "snapshots", host);
}

export async function writeSnapshot(repo: string, host: string, name: string, data: unknown): Promise<string> {
  const dir = snapshotDir(repo, host);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${name}.json`);
  await writeFile(file, JSON.stringify(data, null, 2) + "\n");
  return file;
}
