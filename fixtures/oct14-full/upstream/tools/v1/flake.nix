{
  description = "tools 1";
  outputs = _: {
    overlays.default = final: prev: {
      tools = prev.writeShellScriptBin "tools" "echo tools 1";
    };
  };
}
