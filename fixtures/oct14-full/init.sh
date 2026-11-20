#!/usr/bin/env bash
# Build the fixture as a user's config repo at <dest> (branch main), with its
# local upstreams at <dest>.upstream: vendor and tools, each with a v1 and a v2
# commit. The lock pins nvf/nixpkgs from before 2026-04-15 and the upstreams at v1.
set -euo pipefail
src=$(dirname "$(readlink -f "$0")")
dest=$(readlink -f "$1")
up="$dest.upstream"
g() { git -c user.name=fixture -c user.email=fixture@example "$@"; }

rm -rf "$up"
declare -A v1
for name in vendor tools; do
  mkdir -p "$up/$name"
  g -C "$up/$name" init -q -b main
  for v in v1 v2; do
    cp "$src/upstream/$name/$v/flake.nix" "$up/$name/flake.nix"
    g -C "$up/$name" add -A
    g -C "$up/$name" commit -qm "$name $v"
    [ "$v" = v1 ] && v1[$name]=$(git -C "$up/$name" rev-parse HEAD)
  done
done

mkdir -p "$dest"
sed "s|@UPSTREAM@|$up|g" "$src/flake.nix.in" > "$dest/flake.nix"
cp "$src/configuration.nix" "$dest/"
g -C "$dest" init -q -b main
g -C "$dest" add -A
nix flake lock "$dest" \
  --override-input nixpkgs github:NixOS/nixpkgs/46db2e09e1d3f113a13c0d7b81e2f221c63b8ce9 \
  --override-input nvf github:notashelf/nvf/0bffd83d435fb873a9f133b3a61e460fd4a26d46 \
  --override-input vendor "git+file://$up/vendor?rev=${v1[vendor]}" \
  --override-input tools "git+file://$up/tools?rev=${v1[tools]}" 2>/dev/null
g -C "$dest" add -A
g -C "$dest" commit -qm "fixture: config as of the Oct 14 update"
