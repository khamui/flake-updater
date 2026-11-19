import { describe, expect, it } from "vitest";
import {
  changedLines,
  diffSizeViolations,
  globToRegExp,
  lockViolations,
  writeScopeViolations,
} from "../../src/guard/structure.js";

const FLAKE = (inputs: string) => `{
  description = "config";
  inputs = {
${inputs}
  };
  outputs = { nixpkgs, ... }: { };
}
`;
const INPUTS = '    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";\n    flake-updater.url = "github:khamui/flake-updater";';

describe("write scope", () => {
  it("blocks a new flake input", () => {
    const after = FLAKE(`${INPUTS}\n    evil.url = "github:evil/flake";`);
    expect(writeScopeViolations([{ path: "flake.nix", before: FLAKE(INPUTS), after }])).toEqual([
      "write-scope: flake.nix inputs block changed",
    ]);
  });

  it("allows edits to flake.nix outside the inputs block", () => {
    const after = FLAKE(INPUTS).replace("outputs = { nixpkgs, ... }: { };", "outputs = { nixpkgs, ... }: { x = 1; };");
    expect(writeScopeViolations([{ path: "flake.nix", before: FLAKE(INPUTS), after }])).toEqual([]);
  });

  it("blocks hardware-configuration.nix and PREFERENCES.md at any depth", () => {
    const changes = [
      { path: "hosts/laptop/hardware-configuration.nix", before: "{}", after: "{ x = 1; }" },
      { path: ".flake-agent/PREFERENCES.md", before: "a", after: "b" },
      { path: "home/laptop/programs/nvf.nix", before: "{}", after: "{ a = 1; }" },
    ];
    expect(writeScopeViolations(changes)).toEqual([
      "write-scope: hosts/laptop/hardware-configuration.nix may not be edited",
      "write-scope: .flake-agent/PREFERENCES.md may not be edited",
    ]);
  });

  it("honours per-host allow and deny overrides", () => {
    const hw = { path: "hosts/vm/hardware-configuration.nix", before: "{}", after: "{ x = 1; }" };
    const secret = { path: "secrets/wifi.nix", before: "{}", after: "{ x = 1; }" };
    expect(writeScopeViolations([hw, secret], { allow: ["hosts/vm/**"], deny: ["secrets/**"] })).toEqual([
      "write-scope: secrets/wifi.nix may not be edited",
    ]);
  });

  it("blocks changes to the services.flake-agent block, not to the rest of the file", () => {
    const before = "{ ... }: {\n  services.flake-agent = { enable = true; diffLimit = 60; };\n  programs.git.enable = true;\n}\n";
    const raised = before.replace("diffLimit = 60", "diffLimit = 600");
    const other = before.replace("programs.git.enable = true", "programs.git.enable = false");
    expect(writeScopeViolations([{ path: "hosts/laptop/configuration.nix", before, after: raised }])).toEqual([
      "write-scope: services.flake-agent config changed in hosts/laptop/configuration.nix",
    ]);
    expect(writeScopeViolations([{ path: "hosts/laptop/configuration.nix", before, after: other }])).toEqual([]);
  });

  it("refuses any direct flake.lock edit from the agent's hook", () => {
    const lock = [{ path: "flake.lock", before: "{}", after: "{ }" }];
    expect(writeScopeViolations(lock, {}, "hook")).toEqual(["write-scope: flake.lock is only written by `nix flake update`"]);
    expect(writeScopeViolations(lock, {}, "guard")).toEqual([]);
  });

  it("matches globs like git", () => {
    expect(globToRegExp("**/hardware-configuration.nix").test("hardware-configuration.nix")).toBe(true);
    expect(globToRegExp("**/hardware-configuration.nix").test("a/b/hardware-configuration.nix")).toBe(true);
    expect(globToRegExp("hosts/*.nix").test("hosts/a/b.nix")).toBe(false);
  });
});

const github = (owner: string, repo: string, rev: string, extra: object = {}) => ({
  locked: { owner, repo, rev, type: "github", narHash: `sha256-${rev}`, lastModified: 1 },
  original: { owner, repo, type: "github", ...extra },
});

const lock = (nodes: Record<string, object>, root: Record<string, string | string[]>) =>
  JSON.stringify({
    version: 7,
    root: "root",
    nodes: { ...nodes, root: { inputs: root } },
  });

const BEFORE = lock(
  {
    nixpkgs: github("NixOS", "nixpkgs", "aaa", { ref: "nixos-unstable" }),
    "home-manager": { ...github("nix-community", "home-manager", "bbb"), inputs: { nixpkgs: ["nixpkgs"] } },
    "flake-updater": github("khamui", "flake-updater", "ccc"),
  },
  { nixpkgs: "nixpkgs", "home-manager": "home-manager", "flake-updater": "flake-updater" },
);

describe("lock integrity", () => {
  it("passes a plain nix flake update (new revisions, same sources)", () => {
    const after = BEFORE.replace(/"rev":"aaa"/, '"rev":"aa2"').replace(/"rev":"bbb"/, '"rev":"bb2"');
    expect(lockViolations(BEFORE, after)).toEqual([]);
  });

  it("blocks a changed original", () => {
    const after = BEFORE.replace('"ref":"nixos-unstable"', '"ref":"evil-branch"');
    expect(lockViolations(BEFORE, after)).toEqual([
      'lock: original of nixpkgs changed: {"owner":"NixOS","repo":"nixpkgs","type":"github","ref":"nixos-unstable"} → {"owner":"NixOS","repo":"nixpkgs","type":"github","ref":"evil-branch"}',
    ]);
  });

  it("blocks a new top-level input", () => {
    const parsed = JSON.parse(BEFORE);
    parsed.nodes.evil = github("evil", "flake", "ddd");
    parsed.nodes.root.inputs.evil = "evil";
    expect(lockViolations(BEFORE, JSON.stringify(parsed))).toEqual(["lock: new top-level input evil"]);
  });

  it("blocks any change to the self input", () => {
    const after = BEFORE.replace('"rev":"ccc"', '"rev":"cc2"');
    expect(lockViolations(BEFORE, after)).toEqual(["lock: self input flake-updater changed (only updated by hand)"]);
  });

  it("blocks a node locked to another source than its original names (fork redirect)", () => {
    const parsed = JSON.parse(BEFORE);
    parsed.nodes["home-manager"].locked.owner = "evil";
    expect(lockViolations(BEFORE, JSON.stringify(parsed))).toEqual([
      'lock: node home-manager locked owner="evil" but original says "nix-community"',
    ]);
  });

  it("blocks a changed follows", () => {
    const parsed = JSON.parse(BEFORE);
    parsed.nodes.root.inputs.nixpkgs = ["home-manager", "nixpkgs"];
    expect(lockViolations(BEFORE, JSON.stringify(parsed))).toEqual([
      'lock: nixpkgs follows "nixpkgs" → ["home-manager","nixpkgs"]',
    ]);
  });
});

describe("diff size", () => {
  const numstat = (n: number) => `${n}\t0\thome/laptop/programs/nvf.nix\n400\t300\tflake.lock\n90\t90\t.flake-agent/snapshots/laptop/t3.json\n`;

  it("counts added and deleted lines, excluding the lock and snapshots", () => {
    expect(changedLines("3\t2\ta.nix\n-\t-\timg.png\n")).toBe(5);
    expect(changedLines(numstat(10))).toBe(10);
  });

  it("passes 60 changed lines and blocks 61", () => {
    expect(diffSizeViolations(numstat(60))).toEqual([]);
    expect(diffSizeViolations(numstat(61))).toEqual(["diff-size: 61 changed lines > 60"]);
  });
});
