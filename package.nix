{
  lib,
  buildNpmPackage,
  nodejs_22,
  makeWrapper,
  nvd,
  diffutils,
  bubblewrap,
  xvfb,
}:
buildNpmPackage {
  pname = "flake-agent";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./package.json
      ./package-lock.json
      ./tsconfig.json
      ./src
      ./test
    ];
  };

  nodejs = nodejs_22;
  npmDepsHash = "sha256-lcCkIKuBLoc0H2lSLp17oxpiqvxaq3SSfjAgF/TOAhE=";

  nativeBuildInputs = [makeWrapper];

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm test
    runHook postCheck
  '';

  # nix itself is not wrapped: the host's nix must match its daemon
  postInstall = ''
    wrapProgram $out/bin/flake-agent \
      --prefix PATH : ${lib.makeBinPath [nvd diffutils bubblewrap xvfb]}
  '';

  meta = {
    description = "Unattended NixOS flake updater agent";
    mainProgram = "flake-agent";
    platforms = lib.platforms.linux;
  };
}
