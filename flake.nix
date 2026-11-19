{
  description = "flake-agent: unattended NixOS flake updater";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = {nixpkgs, ...}: let
    systems = ["x86_64-linux" "aarch64-linux"];
    forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
  in {
    packages = forAll (pkgs: {
      default = pkgs.callPackage ./package.nix {};
    });

    # the package build runs the vitest suite (doCheck)
    checks = forAll (pkgs: {
      default = pkgs.callPackage ./package.nix {};
    });

    devShells = forAll (pkgs: {
      default = pkgs.mkShell {packages = [pkgs.nodejs_22 pkgs.nvd];};
    });
  };
}
