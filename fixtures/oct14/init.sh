#!/usr/bin/env bash
# Turn the fixture into a git repo with `main`, as a user's config repo: init.sh <dir>
set -euo pipefail
src=$(dirname "$(readlink -f "$0")")
dest=$1
mkdir -p "$dest"
cp "$src"/flake.nix "$src"/flake.lock "$src"/configuration.nix "$dest"/
git -C "$dest" init -q -b main
git -C "$dest" add -A
git -C "$dest" -c user.name=fixture -c user.email=fixture@example commit -qm "fixture: nvf before the 26.07 deprecation drop"
