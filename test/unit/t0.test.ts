import { describe, expect, it } from "vitest";
import type { Store } from "../../src/nix/store.js";
import { diffT0, snapshotT0, type T0Snapshot } from "../../src/probes/t0.js";

const p = (name: string) => `/nix/store/${"a".repeat(32)}-${name}`;

/** A fake system: toplevel → sw (system-path), per-user env → home-manager-path. */
function fakeStore(): Store {
  const refs: Record<string, string[]> = {
    [p("system-path")]: [p("ripgrep-15.2.0"), p("bzip2-1.0.8"), p("bzip2-1.0.8-man")],
    [p("user-environment")]: [p("home-manager-path"), p("thunderbird-157.0.1")],
    [p("home-manager-path")]: [p("neovim-0.12.0"), p("fzf-0.70.0")],
  };
  const links: Record<string, string> = {
    "/sys/sw": p("system-path"),
    "/sys/etc/profiles/per-user/kha": p("user-environment"),
    [`${p("system-path")}/bin/rg`]: `${p("ripgrep-15.2.0")}/bin/rg`,
    [`${p("user-environment")}/bin/nvim`]: `${p("neovim-0.12.0")}/bin/nvim`,
    [`${p("user-environment")}/bin/fzf`]: `${p("fzf-0.70.0")}/bin/fzf`,
  };
  const dirs: Record<string, string[]> = {
    [`${p("system-path")}/bin`]: ["rg"],
    [`${p("user-environment")}/bin`]: ["nvim", "fzf"],
  };
  return {
    references: async (path) => refs[path] ?? [],
    list: async (dir) => dirs[dir] ?? [],
    resolve: async (path) => links[path] ?? path,
  };
}

describe("snapshotT0", () => {
  it("collects packages through nested buildEnvs and binaries per profile", async () => {
    const snap = await snapshotT0(fakeStore(), "/sys", "kha");
    expect(snap.packages).toEqual({
      bzip2: ["1.0.8", "1.0.8-man"],
      fzf: ["0.70.0"],
      neovim: ["0.12.0"],
      ripgrep: ["15.2.0"],
      thunderbird: ["157.0.1"],
    });
    expect(snap.binaries).toEqual({
      system: { rg: "ripgrep-15.2.0" },
      "user:kha": { fzf: "fzf-0.70.0", nvim: "neovim-0.12.0" },
    });
  });

  it("is identical for the same system", async () => {
    const a = await snapshotT0(fakeStore(), "/sys", "kha");
    const b = await snapshotT0(fakeStore(), "/sys", "kha");
    expect(diffT0(a, b)).toEqual([]);
  });
});

describe("diffT0", () => {
  const base: T0Snapshot = {
    tier: "T0",
    packages: { neovim: ["0.12.0"], fzf: ["0.70.0"] },
    binaries: { "user:kha": { nvim: "neovim-0.12.0", fzf: "fzf-0.70.0" } },
  };

  it("fails on a removed package and its binary", () => {
    const next: T0Snapshot = {
      tier: "T0",
      packages: { neovim: ["0.12.0"] },
      binaries: { "user:kha": { nvim: "neovim-0.12.0" } },
    };
    const fails = diffT0(base, next).filter((f) => f.severity === "fail");
    expect(fails.map((f) => [f.kind, f.subject])).toEqual([
      ["package-removed", "fzf"],
      ["binary-removed", "user:kha/fzf"],
    ]);
  });

  it("reports version bumps and additions as info only", () => {
    const next: T0Snapshot = {
      tier: "T0",
      packages: { neovim: ["0.12.1"], fzf: ["0.70.0"], btop: ["1.4"] },
      binaries: { "user:kha": { nvim: "neovim-0.12.1", fzf: "fzf-0.70.0", btop: "btop-1.4" } },
    };
    const findings = diffT0(base, next);
    expect(findings.every((f) => f.severity === "info")).toBe(true);
    expect(findings.map((f) => f.kind)).toEqual(["package-version", "package-added", "binary-added"]);
  });
});
