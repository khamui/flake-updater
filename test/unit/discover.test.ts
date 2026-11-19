import { describe, expect, it } from "vitest";
import { configAttr, discoveryExpr, parseDiscovery } from "../../src/discovery/discover.js";

describe("discovery", () => {
  it("reads all three package sources from the config", () => {
    const expr = discoveryExpr("khamui");
    expect(expr).toContain("config.environment.systemPackages");
    expect(expr).toContain('config.users.users."khamui".packages');
    expect(expr).toContain('hm."khamui".home.packages');
  });

  it("refuses names that could inject Nix code", () => {
    expect(() => discoveryExpr('x"; builtins.exec')).toThrow();
    expect(() => configAttr({ flake: ".", host: "a.b", user: "u" }, "config")).toThrow();
  });

  it("parses eval output into declared packages", () => {
    const json = JSON.stringify([
      { source: "system", name: "ripgrep-15.2.0", path: "/nix/store/x-ripgrep-15.2.0" },
      { source: "home", name: "fzf-0.70.0", path: "/nix/store/y-fzf-0.70.0" },
    ]);
    expect(parseDiscovery(json)).toEqual([
      { source: "system", name: "ripgrep-15.2.0", pname: "ripgrep", version: "15.2.0", outPath: "/nix/store/x-ripgrep-15.2.0" },
      { source: "home", name: "fzf-0.70.0", pname: "fzf", version: "0.70.0", outPath: "/nix/store/y-fzf-0.70.0" },
    ]);
  });
});
