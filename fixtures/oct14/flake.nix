{
  description = "flake-agent fixture: nvf pinned before the 26.07 deprecation drop (the Oct 14 update)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nvf.url = "github:notashelf/nvf";
    nvf.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = {
    nixpkgs,
    nvf,
    ...
  }: {
    nixosConfigurations.fixture = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        nvf.nixosModules.default
        ./configuration.nix
      ];
    };
  };
}
