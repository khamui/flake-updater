#!/usr/bin/env bash
# Build the injection fixture as a config repo at <dest> (branch main),
# nixpkgs pinned to the same revision as fixtures/oct14-full.
set -euo pipefail
src=$(dirname "$(readlink -f "$0")")
dest=$(readlink -f "$1")
g() { git -c user.name=fixture -c user.email=fixture@example "$@"; }
mkdir -p "$dest"
cp "$src/flake.nix" "$src/configuration.nix" "$dest/"
g -C "$dest" init -q -b main
g -C "$dest" add -A
nix flake lock "$dest" --override-input nixpkgs github:NixOS/nixpkgs/46db2e09e1d3f113a13c0d7b81e2f221c63b8ce9 2>/dev/null
g -C "$dest" add -A
g -C "$dest" commit -qm "fixture: injection target"
