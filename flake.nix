{
  description = "flake-agent: unattended NixOS flake updater";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = {
    self,
    nixpkgs,
    ...
  }: let
    systems = ["x86_64-linux" "aarch64-linux"];
    # claude-code (the Agent SDK's runtime) is unfree; allow exactly that package
    pkgsFor = system:
      import nixpkgs {
        inherit system;
        config.allowUnfreePredicate = p: nixpkgs.lib.getName p == "claude-code";
      };
    forAll = f: nixpkgs.lib.genAttrs systems (system: f (pkgsFor system));
  in {
    packages = forAll (pkgs: {
      default = pkgs.callPackage ./package.nix {};
    });

    # the package build runs the vitest suite (doCheck)
    checks = forAll (pkgs: {
      default = pkgs.callPackage ./package.nix {};
    });

    nixosModules.default = import ./nix/module.nix self;

    # VM tests: slow without KVM, so not part of `nix flake check`
    legacyPackages = forAll (pkgs: {
      tests.module = import ./nix/test.nix {inherit self pkgs;};
      tests.switch = import ./nix/switch-test.nix {inherit self pkgs;};
    });

    devShells = forAll (pkgs: {
      default = pkgs.mkShell {packages = [pkgs.nodejs_22 pkgs.nvd];};
    });
  };
}
