{pkgs, ...}: {
  imports = [];

  boot.loader.grub.device = "nodev";
  fileSystems."/" = {
    device = "/dev/disk/by-label/nixos";
    fsType = "ext4";
  };
  system.stateVersion = "26.05";

  users.users.kha = {
    isNormalUser = true;
    shell = pkgs.zsh;
  };

  programs.zsh = {
    enable = true;
    shellAliases.ll = "ls -l";
  };
  programs.ssh.extraConfig = ''
    Host *
      ServerAliveInterval 60
  '';
  environment.systemPackages = [pkgs.git];
}
