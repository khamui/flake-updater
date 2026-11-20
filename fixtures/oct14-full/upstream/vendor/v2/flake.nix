{
  description = "vendor 2: new data, hash fixed upstream";
  outputs = _: {
    overlays.default = final: prev: {
      vendor-data = prev.runCommand "vendor-data" {
        outputHashMode = "recursive";
        outputHashAlgo = "sha256";
        outputHash = "sha256-2rOt3WKqoJXoGzDf1Lt3RKD4EsX4YqR/ltFLwIHRPsQ=";
      } "mkdir $out; echo 'vendor data v2' > $out/data";
    };
  };
}
