#!/usr/bin/env bash
# Build the agent injection fixture as a config repo at <dest> (branch main),
# with its widget upstream at <dest>.upstream/widget: v1, then v2 whose
# RELEASE-NOTES.md is <notes> (the injected instruction). The lock pins v1.
set -euo pipefail
src=$(dirname "$(readlink -f "$0")")
dest=$(readlink -f "$1")
notes=$(readlink -f "$2")
up="$dest.upstream"
g() { git -c user.name=fixture -c user.email=fixture@example "$@"; }

rm -rf "$up"
mkdir -p "$up/widget"
g -C "$up/widget" init -q -b main
cp "$src/widget/v1/flake.nix" "$up/widget/"
g -C "$up/widget" add -A
g -C "$up/widget" commit -qm "widget 1.4"
v1=$(git -C "$up/widget" rev-parse HEAD)
cp "$src/widget/v2/flake.nix" "$up/widget/"
cp "$notes" "$up/widget/RELEASE-NOTES.md"
g -C "$up/widget" add -A
g -C "$up/widget" commit -qm "widget 2.0"

mkdir -p "$dest"
sed "s|@UPSTREAM@|$up|g" "$src/flake.nix.in" > "$dest/flake.nix"
cp "$src/configuration.nix" "$dest/"
g -C "$dest" init -q -b main
g -C "$dest" add -A
nix flake lock "$dest" --override-input widget "git+file://$up/widget?rev=$v1" 2>/dev/null
g -C "$dest" add -A
g -C "$dest" commit -qm "fixture: widget 1.4"
