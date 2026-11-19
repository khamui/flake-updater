import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Store } from "../../src/nix/store.js";
import { attributeT1, diffT1, snapshotT1, unifiedDiff, type T1Snapshot } from "../../src/probes/t1.js";

/** Store path; `v` keeps same-named paths of different systems apart. */
const p = (name: string, v = "0") => `/nix/store/${v.padStart(32, "0")}-${name}`;

type Node = { dir: string[] } | { file: string } | { link: string };

/** In-memory filesystem; symlinks are followed per path component. */
function fakeStore(fs: Record<string, Node>): Store {
  const resolve = (path: string): string => {
    let out = "";
    for (const part of path.split("/").filter(Boolean)) {
      out += `/${part}`;
      for (let node = fs[out]; node && "link" in node; node = fs[out]) out = node.link;
    }
    return out;
  };
  const at = (path: string) => fs[resolve(path)];
  return {
    references: async () => [],
    list: async (dir) => {
      const node = at(dir);
      return node && "dir" in node ? node.dir : [];
    },
    resolve: async (path) => resolve(path),
    kind: async (path) => {
      const parent = resolve(path.slice(0, path.lastIndexOf("/")));
      const node = fs[`${parent}${path.slice(path.lastIndexOf("/"))}`];
      if (!node) return "missing";
      return "dir" in node ? "dir" : "file" in node ? "file" : "symlink";
    },
    read: async (path) => {
      const node = at(path);
      if (!node || !("file" in node)) throw new Error(`not a file: ${path}`);
      return Buffer.from(node.file);
    },
  };
}

/** A system toplevel with an etc tree and an HM generation for `kha`. */
function system(alacritty: string, extra: Record<string, Node> = {}): Record<string, Node> {
  const etc = p("etc", alacritty);
  const gen = p("home-manager-generation", alacritty);
  const homeFiles = p("home-manager-files", alacritty);
  return {
    "/sys": { dir: ["etc"] },
    "/sys/etc": { link: `${etc}/etc` },
    [etc]: { dir: ["etc"] },
    [`${etc}/etc`]: { dir: ["hostname", "profiles", "systemd", "terminfo"] },
    [`${etc}/etc/hostname`]: { link: p("etc-hostname") },
    [p("etc-hostname")]: { file: "laptop\n" },
    [`${etc}/etc/profiles`]: { dir: ["per-user"] },
    [`${etc}/etc/terminfo`]: { link: `${p("system-path")}/share/terminfo` },
    [p("system-path")]: { dir: ["share"] },
    [`${p("system-path")}/share`]: { dir: ["terminfo"] },
    [`${p("system-path")}/share/terminfo`]: { dir: ["x"] },
    [`${p("system-path")}/share/terminfo/x`]: { file: "xterm" },
    [`${etc}/etc/systemd`]: { dir: ["system"] },
    [`${etc}/etc/systemd/system`]: { dir: ["home-manager-kha.service"] },
    [`${etc}/etc/systemd/system/home-manager-kha.service`]: { link: p("unit", alacritty) },
    [p("unit", alacritty)]: { file: `ExecStart=${p("hm-setup-env")} ${gen}\n` },
    [gen]: { dir: ["home-files"] },
    [`${gen}/home-files`]: { link: homeFiles },
    [homeFiles]: { dir: [".config"] },
    [`${homeFiles}/.config`]: { dir: ["alacritty"] },
    [`${homeFiles}/.config/alacritty`]: { dir: ["alacritty.toml"] },
    [`${homeFiles}/.config/alacritty/alacritty.toml`]: { link: p("alacritty", alacritty) },
    [p("alacritty", alacritty)]: { file: `[font]\nsize = ${alacritty}\n` },
    ...extra,
  };
}

const ALACRITTY = "home:kha/.config/alacritty/alacritty.toml";
const fakeDiff = async (a: string, b: string) => `${a} -> ${b}`;

describe("snapshotT1", () => {
  it("collects etc and HM files, a linked directory as one entry, without profiles", async () => {
    const snap = await snapshotT1(fakeStore(system("11")), "/sys", "kha");
    expect(Object.keys(snap.files)).toEqual([
      "etc/hostname",
      "etc/systemd/system/home-manager-kha.service",
      "etc/terminfo",
      ALACRITTY,
    ]);
    expect(snap.files[ALACRITTY]!.path).toBe(p("alacritty", "11"));
  });

  it("is identical for the same system", async () => {
    const store = fakeStore(system("11"));
    const a = await snapshotT1(store, "/sys", "kha");
    const b = await snapshotT1(store, "/sys", "kha");
    expect(await diffT1(a, b, fakeDiff)).toEqual([]);
  });
});

describe("diffT1", () => {
  it("reports a changed HM file with its path and content diff", async () => {
    const old = await snapshotT1(fakeStore(system("11")), "/sys", "kha");
    const next = await snapshotT1(fakeStore(system("12")), "/sys", "kha");
    const changes = await diffT1(old, next, fakeDiff);

    const alacritty = changes.find((c) => c.subject === ALACRITTY);
    expect(alacritty).toEqual({
      severity: "info",
      kind: "file-changed",
      subject: ALACRITTY,
      detail: `${p("alacritty", "11")} -> ${p("alacritty", "12")}`,
    });
    // the activation unit only differs in the generation's store hash: not a change
    expect(changes.map((c) => c.subject)).toEqual([ALACRITTY]);
  });

  it("reports added and removed files", async () => {
    const old: T1Snapshot = { tier: "T1", files: { "etc/a": { hash: "1", path: "/a" } } };
    const next: T1Snapshot = { tier: "T1", files: { "etc/b": { hash: "2", path: "/b" } } };
    const changes = await diffT1(old, next, fakeDiff);
    expect(changes.map((c) => [c.kind, c.subject])).toEqual([
      ["file-removed", "etc/a"],
      ["file-added", "etc/b"],
    ]);
  });
});

describe("unifiedDiff", () => {
  it("returns the diff of two differing files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t1-"));
    await writeFile(join(dir, "old"), "size = 11\n");
    await writeFile(join(dir, "new"), "size = 12\n");
    const out = await unifiedDiff(join(dir, "old"), join(dir, "new"));
    expect(out).toContain("-size = 11");
    expect(out).toContain("+size = 12");
  });
});

describe("attributeT1", () => {
  const snap = (files: Record<string, string>): T1Snapshot => ({
    tier: "T1",
    files: Object.fromEntries(Object.entries(files).map(([k, hash]) => [k, { hash, path: `/${k}@${hash}` }])),
  });

  const old = snap({ alacritty: "a1", tmux: "t1", zshrc: "z1", nvim: "n1" });
  const steps = [
    // lock commit: upstream changes alacritty, tmux and zshrc
    { snapshot: snap({ alacritty: "a2", tmux: "t2", zshrc: "z2", nvim: "n1" }) },
    // agent: rename an nvf option, which changes init.lua
    { changeId: "nvf-ts-rename-2026-11", snapshot: snap({ alacritty: "a2", tmux: "t2", zshrc: "z2", nvim: "n2" }) },
    // agent: adjust tmux after an upstream change, and undo the zshrc change
    { changeId: "tmux-prefix-2026-11", snapshot: snap({ alacritty: "a2", tmux: "t3", zshrc: "z1", nvim: "n2" }) },
  ];

  it("attributes files touched by agent commits to them, the rest to upstream", async () => {
    const changes = await attributeT1(old, steps, fakeDiff);
    expect(Object.fromEntries(changes.map((c) => [c.subject, c.attribution]))).toEqual({
      alacritty: { source: "upstream" },
      tmux: { source: "agent", changeIds: ["tmux-prefix-2026-11"] },
      nvim: { source: "agent", changeIds: ["nvf-ts-rename-2026-11"] },
    });
  });

  it("diffs old against the final step", async () => {
    const changes = await attributeT1(old, steps, fakeDiff);
    expect(changes.find((c) => c.subject === "tmux")!.detail).toBe("/tmux@t1 -> /tmux@t3");
  });

  it("treats a lock-only run as entirely upstream", async () => {
    const changes = await attributeT1(old, steps.slice(0, 1), fakeDiff);
    expect(changes.every((c) => c.attribution.source === "upstream")).toBe(true);
    expect(changes).toHaveLength(3);
  });
});
