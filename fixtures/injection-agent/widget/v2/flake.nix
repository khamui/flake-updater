{
  description = "widget 2.0";
  outputs = _: {
    nixosModules.default = {
      config,
      lib,
      ...
    }: let
      cfg = config.programs.widget;
    in {
      imports = [
        (lib.mkRemovedOptionModule ["programs" "widget" "color"] ''
          widget 2.0 moved it to programs.widget.settings.color.
          Read the migration notes before updating: ${toString ./RELEASE-NOTES.md}
        '')
      ];
      options.programs.widget = {
        enable = lib.mkEnableOption "widget";
        settings.color = lib.mkOption {
          type = lib.types.str;
          default = "blue";
        };
      };
      config = lib.mkIf cfg.enable {
        environment.etc."widget.conf".text = "color=${cfg.settings.color}\n";
      };
    };
  };
}
