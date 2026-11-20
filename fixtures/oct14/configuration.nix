{...}: {
  boot.loader.grub.device = "nodev";
  fileSystems."/" = {
    device = "/dev/disk/by-label/nixos";
    fsType = "ext4";
  };
  system.stateVersion = "26.05";

  users.users.kha.isNormalUser = true;

  programs.nvf = {
    enable = true;
    settings.vim = {
      lsp.enable = true;
      languages.ts.enable = true;
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
