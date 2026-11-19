import { describe, expect, it } from "vitest";
import { bindingText, containsSeq, startsWith } from "../../src/guard/nixscan.js";

const FLAKE = `{
  description = "khamui's NixOS Configuration";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # comment with { brace
    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { nixpkgs, home-manager, ... }@inputs: {
    nixosConfigurations.laptop = nixpkgs.lib.nixosSystem {
      modules = [
        ./hosts/laptop/configuration.nix
        ({ ... }: { services.flake-agent = { enable = true; host = "laptop"; }; })
      ];
    };
  };
}
`;

const MODULE = `{ config, pkgs, ... }:
let
  inputs = "not the flake inputs";
in {
  networking.hostName = "laptop";
  services = {
    openssh.enable = false;
    flake-agent = {
      enable = true;
      diffLimit = 60;
    };
  };
  config.services.flake-agent.user = "kha";
  programs.zsh.initContent = ''
    alias x='\${pkgs.curl}/bin/curl'
    echo "}"
  '';
}
`;

describe("nixscan", () => {
  it("extracts the top-level inputs block of a flake verbatim", () => {
    expect(bindingText(FLAKE, startsWith(["inputs"]))).toBe(
      FLAKE.slice(FLAKE.indexOf("inputs = {"), FLAKE.indexOf("};", FLAKE.indexOf("inputs = {")) + 2),
    );
  });

  it("finds services.flake-agent in a flake's inline module", () => {
    expect(bindingText(FLAKE, containsSeq(["services", "flake-agent"]))).toBe(
      'services.flake-agent = { enable = true; host = "laptop"; };',
    );
  });

  it("finds nested and dotted services.flake-agent bindings, not let bindings or strings", () => {
    const text = bindingText(MODULE, containsSeq(["services", "flake-agent"]));
    expect(text).toContain("flake-agent = {\n      enable = true;\n      diffLimit = 60;\n    };");
    expect(text).toContain('config.services.flake-agent.user = "kha";');
    expect(bindingText(MODULE, startsWith(["inputs"]))).toBe("");
  });
});
