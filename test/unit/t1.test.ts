import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Store } from "../../src/nix/store.js";
import { attributeT1, diffT1, snapshotT1, contentChange, unifiedDiff, upstreamT1, type T1Snapshot } from "../../src/probes/t1.js";

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

describe("upstream-only generated files", () => {
  const snap = (files: Record<string, string>): T1Snapshot => ({
    tier: "T1",
    files: Object.fromEntries(Object.entries(files).map(([k, hash]) => [k, { hash, path: `/${k}@${hash}` }])),
  });
  const diff = (file: string, minus: string[], plus: string[]) =>
    [`--- /nix/store/${"a".repeat(32)}-etc/${file}`, `+++ /nix/store/${"b".repeat(32)}-etc/${file}`, "@@ -1 +1 @@", ...minus.map((l) => `-${l}`), ...plus.map((l) => `+${l}`)].join("\n");
  const BUMP = diff("foo.service", [`ExecStart=/nix/store/${"a".repeat(32)}-foo-1.2/bin/foo --flag`], [`ExecStart=/nix/store/${"b".repeat(32)}-foo-1.3/bin/foo --flag`]);
  const REAL = diff("foo.conf", ["colour = auto"], ["colour = always"]);
  const pam = (svc: string) => diff(`pam.d/${svc}`, [`password sufficient /nix/store/${"a".repeat(32)}-linux-pam/pam_unix.so nullok yescrypt`], [`password sufficient /nix/store/${"b".repeat(32)}-linux-pam/pam_unix.so nullok`]);

  it("leaves out store paths, the NixOS version and binaries", () => {
    expect(contentChange(BUMP)).toBe("");
    expect(contentChange(diff("os-release", ['BUILD_ID="26.11.20260723.e2587ca"'], ['BUILD_ID="26.11.20261119.0bb8272"']))).toBe("");
    expect(contentChange("Binary files /nix/store/x/bin/a and /nix/store/y/bin/a differ")).toBe("");
    expect(contentChange(REAL)).toBe("-colour = auto\n+colour = always");
    expect(contentChange("Only in /nix/store/x-etc: new.conf")).toBe("Only in /nix/store/…: new.conf");
  });

  it("keeps a removed Lua comment, which diff prints as ---", () => {
    expect(contentChange("--- a/init.lua\n+++ b/init.lua\n@@ -1 +0,0 @@\n--- keep me")).toBe("--- keep me");
  });

  it("reports files the lock alone changed, not the agent's or version bumps", async () => {
    const old = snap({ "etc/foo.conf": "f1", "etc/foo.service": "s1", "home:kha/.zshrc": "z1", "etc/gone": "g1", "etc/gone.mode": "m1" });
    const lock = snap({ "etc/foo.conf": "f2", "etc/foo.service": "s2", "home:kha/.zshrc": "z2" });
    // the agent then edits .zshrc
    const final = snap({ "etc/foo.conf": "f2", "etc/foo.service": "s2", "home:kha/.zshrc": "z3" });
    const differ = async (a: string) => (a.startsWith("/etc/foo.service") ? BUMP : REAL);
    const found = await upstreamT1(old, lock, final, differ);
    expect(found.map((c) => `${c.kind} ${c.subject}`)).toEqual(["file-changed etc/foo.conf", "file-removed etc/gone"]);
    expect(found[0]!.detail).toBe(REAL);
  });

  it("reports files with the same change once", async () => {
    const svcs = ["login", "passwd", "sudo"];
    const old = snap(Object.fromEntries([...svcs.map((s) => [`etc/pam.d/${s}`, "1"]), ["etc/a.crt", "1"], ["etc/ssl/b.crt", "1"]]));
    const next = snap(Object.fromEntries([...svcs.map((s) => [`etc/pam.d/${s}`, "2"]), ["etc/a.crt", "2"], ["etc/ssl/b.crt", "2"]]));
    const differ = async (a: string) => (a.includes("pam.d") ? pam(a.split("/")[3]!.split("@")[0]!) : diff("x.crt", ["CERT1"], ["CERT2"]));
    const found = await upstreamT1(old, next, next, differ);
    expect(found.map((c) => c.subject)).toEqual(["etc/a.crt (+1 more)", "etc/pam.d/ (3 files)"]);
    expect(found[1]!.detail).toMatch(/^# etc\/pam.d\/login\n# etc\/pam.d\/passwd\n# etc\/pam.d\/sudo\n---/);
  });
});
