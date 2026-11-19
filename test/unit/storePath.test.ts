import { describe, expect, it } from "vitest";
import { parseDrvName, storeName, storeRoot } from "../../src/nix/storePath.js";

const H = "9mhjx1xp9kr8dkrbl66kfymkwgg6baxr";

describe("storeName / storeRoot", () => {
  it("extracts the name and root of a store path", () => {
    expect(storeName(`/nix/store/${H}-home-manager-path/bin/nvim`)).toBe("home-manager-path");
    expect(storeRoot(`/nix/store/${H}-home-manager-path/bin/nvim`)).toBe(`/nix/store/${H}-home-manager-path`);
  });
  it("rejects non-store paths", () => {
    expect(storeName("/run/current-system/sw")).toBeUndefined();
  });
});

describe("parseDrvName", () => {
  it.each([
    ["ripgrep-15.2.0", "ripgrep", "15.2.0"],
    ["bzip2-1.0.8-man", "bzip2", "1.0.8-man"],
    ["gtk+3-3.24.52", "gtk+3", "3.24.52"],
    ["nodejs-slim-22.23.3", "nodejs-slim", "22.23.3"],
    ["home-manager-path", "home-manager-path", ""],
    ["nerd-fonts-fira-code-3.4.0", "nerd-fonts-fira-code", "3.4.0"],
  ])("%s → %s / %s", (name, pname, version) => {
    expect(parseDrvName(name)).toEqual({ pname, version });
  });
});
