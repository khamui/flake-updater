{
  lib,
  buildNpmPackage,
  nodejs_22,
  makeWrapper,
  nvd,
  git,
  gnutar,
  diffutils,
  bubblewrap,
  xvfb,
  claude-code,
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
  npmDepsHash = "sha256-0CzBHiIhh6BD8Cni9EwwwJ0hEMqml6HisUZUd4mlZzk=";

  # git: the update-run tests use a real repository
  nativeBuildInputs = [makeWrapper git];

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm test
    runHook postCheck
  '';

  # nix itself is not wrapped: the host's nix must match its daemon
  postInstall = ''
    # the SDK's prebuilt Claude Code binary doesn't run on NixOS; nixpkgs' claude-code is used instead
    rm -rf $out/lib/node_modules/flake-agent/node_modules/@anthropic-ai/claude-agent-sdk-*
    wrapProgram $out/bin/flake-agent \
      --prefix PATH : ${lib.makeBinPath [nvd git gnutar diffutils bubblewrap xvfb]} \
      --set-default FLAKE_AGENT_CLAUDE ${lib.getExe claude-code} \
      `# the agent runs flake-agent keep-old from its sessions` \
      --prefix PATH : $out/bin
  '';

  meta = {
    description = "Unattended NixOS flake updater agent";
    mainProgram = "flake-agent";
    platforms = lib.platforms.linux;
  };
}
