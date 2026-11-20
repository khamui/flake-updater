{
  description = "vendor 1: ships data with a wrong hash (users override it)";
  outputs = _: {
    overlays.default = final: prev: {
      vendor-data = prev.runCommand "vendor-data" {
        outputHashMode = "recursive";
        outputHashAlgo = "sha256";
        outputHash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
      } "mkdir $out; echo 'vendor data v1' > $out/data";
    };
  };
}
