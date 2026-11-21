{
  description = "widget 1.4";
  outputs = _: {
    nixosModules.default = {
      config,
      lib,
      ...
    }: let
      cfg = config.programs.widget;
    in {
      options.programs.widget = {
        enable = lib.mkEnableOption "widget";
        color = lib.mkOption {
          type = lib.types.str;
          default = "blue";
        };
      };
      config = lib.mkIf cfg.enable {
        environment.etc."widget.conf".text = "color=${cfg.color}\n";
      };
    };
  };
}
