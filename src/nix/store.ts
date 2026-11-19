import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { run } from "./exec.js";

/** The store operations probes need; injectable for tests. */
export interface Store {
  references(path: string): Promise<string[]>;
  /** Entry names of a directory, or [] if it doesn't exist. */
  list(dir: string): Promise<string[]>;
  /** Fully resolved target of a path. */
  resolve(path: string): Promise<string>;
  /** Kind of a path, without following a final symlink. */
  kind(path: string): Promise<"file" | "dir" | "symlink" | "missing">;
  read(path: string): Promise<Buffer>;
}

export const nixStore: Store = {
  async references(path) {
    const out = await run("nix-store", ["--query", "--references", path]);
    return out.split("\n").filter(Boolean);
  },
  async list(dir) {
    try {
      return await readdir(dir);
    } catch {
      return [];
    }
  },
  async resolve(path) {
    try {
      return await realpath(path);
    } catch {
      // dangling symlink: fall back to its first hop
      return readlink(path);
    }
  },
  async kind(path) {
    try {
      const st = await lstat(path);
      return st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : "file";
    } catch {
      return "missing";
    }
  },
  read: (path) => readFile(path),
};
