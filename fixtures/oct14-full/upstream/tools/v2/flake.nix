{
  description = "tools 2: broken upstream";
  outputs = _: {
    overlays.default = final: prev: {
      tools = prev.runCommand "tools-2" {} "echo 'tools 2: upstream build is broken (missing generated sources)' >&2; exit 1";
    };
  };
}
