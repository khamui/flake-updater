{pkgs, ...}: {
  boot.loader.grub.device = "nodev";
  fileSystems."/" = {
    device = "/dev/disk/by-label/nixos";
    fsType = "ext4";
  };
  system.stateVersion = "26.05";

  users.users.kha.isNormalUser = true;

  # vendor ships a wrong hash for its data; pin the right one until they fix it
  nixpkgs.overlays = [
    (final: prev: {
      vendor-data = prev.vendor-data.overrideAttrs {
        outputHash = "sha256-rGZzIFq2K59C0ua8rMSP+4Szs4o0dJINE+By7BuVV24=";
      };
    })
  ];

  environment.systemPackages = [pkgs.tools];
  environment.etc."vendor-data".source = pkgs.vendor-data;

  programs.nvf = {
    enable = true;
    settings.vim = {
      lsp.enable = true;
      languages.ts.enable = true;
      languages.tailwind.enable = true;
      keymaps = [
        {
          key = "jk";
          mode = ["i"];
          action = "<ESC>";
        }
      ];
    };
  };
}
