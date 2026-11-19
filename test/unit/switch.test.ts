import { lutimes, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { findProfiles, listGenerations, parseAge, selectForDeletion } from "../../src/switch/generations.js";
import { decideMode, readRequest, switchCommit, type SwitchDeps } from "../../src/switch/switch.js";
import { requestPath } from "../../src/run/update.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 25);
const gens = (n: number, ageDays: number) =>
  Array.from({ length: n }, (_, i) => ({ number: i + 1, createdMs: NOW - ageDays * DAY }));

describe("retention", () => {
  it("keeps the newest N system generations however old they are", () => {
    expect(selectForDeletion(gens(9, 30), 9, parseAge("7d"), 5, NOW)).toEqual([1, 2, 3, 4]);
  });

  it("deletes nothing younger than the age limit", () => {
    expect(selectForDeletion(gens(9, 2), 9, parseAge("7d"), 5, NOW)).toEqual([]);
  });

  it("never deletes the current generation, even after a rollback to an old one", () => {
    expect(selectForDeletion(gens(9, 30), 2, parseAge("7d"), 5, NOW)).toEqual([1, 3, 4]);
  });

  it("accepts only <n>d ages, like nix", () => {
    expect(parseAge("14d")).toBe(14 * DAY);
    expect(() => parseAge("2w")).toThrow();
  });

  it("lists generations and the current one from the profile links", async () => {
    const dir = await mkdtemp(join(tmpdir(), "profiles-"));
    for (const n of [3, 1, 2]) {
      await symlink(`/nix/store/x-${n}`, join(dir, `system-${n}-link`));
      await lutimes(join(dir, `system-${n}-link`), new Date(NOW - n * DAY), new Date(NOW - n * DAY));
    }
    await symlink("system-2-link", join(dir, "system"));
    await mkdir(join(dir, "per-user", "root"), { recursive: true });
    await symlink("/nix/store/y", join(dir, "per-user", "root", "profile-1-link"));

    const { generations, current } = await listGenerations(join(dir, "system"));
    expect(generations.map((g) => g.number)).toEqual([1, 2, 3]);
    expect(current).toBe(2);
    expect(await findProfiles(dir)).toEqual([join(dir, "per-user", "root", "profile"), join(dir, "system")]);
  });
});

describe("switch or boot", () => {
  const system = async (parts: Record<string, string>) => {
    const dir = await mkdtemp(join(tmpdir(), "sys-"));
    for (const [name, target] of Object.entries(parts)) {
      await mkdir(target, { recursive: true });
      await symlink(target, join(dir, name));
    }
    return dir;
  };

  it("boots when the kernel, initrd or systemd changes, switches otherwise", async () => {
    const root = await mkdtemp(join(tmpdir(), "store-"));
    const p = (n: string) => join(root, n);
    const current = await system({ kernel: p("k1"), initrd: p("i1"), systemd: p("s1") });
    expect(await decideMode(current, await system({ kernel: p("k1"), initrd: p("i1"), systemd: p("s1") }))).toBe("switch");
    expect(await decideMode(current, await system({ kernel: p("k2"), initrd: p("i1"), systemd: p("s1") }))).toBe("boot");
    expect(await decideMode(current, await system({ kernel: p("k1"), initrd: p("i2"), systemd: p("s1") }))).toBe("boot");
    expect(await decideMode(current, await system({ kernel: p("k1"), initrd: p("i1"), systemd: p("s2") }))).toBe("boot");
  });
});

describe("switch service", () => {
  const SHA = "a".repeat(40);
  const req = { commit: SHA, branch: "agent/update-2026-11-25", at: "x" };

  const deps = (verdict: "pass" | "block"): SwitchDeps & { build: ReturnType<typeof vi.fn>; apply: ReturnType<typeof vi.fn> } => ({
    guard: async () => ({ verdict, reasons: verdict === "block" ? ["users.users.kha.openssh.authorizedKeys.keys: added …"] : [], base: "b", rev: SHA }),
    build: vi.fn(async () => ({ ok: true, toplevel: "/nix/store/new" })),
    apply: vi.fn(async () => ({ ok: true })),
    current: "/nix/store/new",
    out: () => {},
  });

  it("never builds or applies a commit the guard blocks, whatever the agent wrote", async () => {
    const state = await mkdtemp(join(tmpdir(), "agent-"));
    // an agent-written verdict is not an input to the switch service
    await writeFile(join(state, "guard-verdict.json"), JSON.stringify({ verdict: "pass" }));
    const d = deps("block");
    const record = await switchCommit("/repo", req, d);
    expect(record.result).toBe("needs-review");
    expect(record.reasons).toHaveLength(1);
    expect(d.build).not.toHaveBeenCalled();
    expect(d.apply).not.toHaveBeenCalled();
  });

  it("builds and applies a commit that passes", async () => {
    const d = deps("pass");
    const record = await switchCommit("/repo", req, d);
    expect(record.result).toBe("switched");
    expect(d.apply).toHaveBeenCalledWith("/nix/store/new", "switch");
  });

  it("does not apply on a dry run", async () => {
    const d = deps("pass");
    expect((await switchCommit("/repo", req, d, { dryRun: true })).result).toBe("dry-run");
    expect(d.apply).not.toHaveBeenCalled();
  });

  it("accepts only a full commit id and an agent/ branch from the request", async () => {
    const state = await mkdtemp(join(tmpdir(), "agent-"));
    const write = (v: object) => writeFile(requestPath(state), JSON.stringify(v));
    await write(req);
    expect(await readRequest(state)).toEqual(req);
    await write({ ...req, commit: "HEAD" });
    expect(await readRequest(state)).toBeUndefined();
    await write({ ...req, branch: "main" });
    expect(await readRequest(state)).toBeUndefined();
    await write({ ...req, branch: "agent/x; rm -rf /" });
    expect(await readRequest(state)).toBeUndefined();
  });
});

