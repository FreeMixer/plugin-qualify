#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
#
# Build the package's files and install exactly the set npm publishes.
#
#   packaging/build.sh <destdir> <libdir>
#
# The tree is compiled with the pnpm and the dependencies the lockfile names, then `npm pack` picks
# the files that go in the package, and they land in <destdir><libdir>/node_modules/@openmixer/plugin-qualify
# with the `plugin-qualify`, `plugin-qualify-sync` and `plugin-qualify-records-package` commands linked into <destdir>/usr/bin and their manual pages
# beside them, and the sync's settings file in <destdir>/etc/omx.
set -euo pipefail

dest=$(readlink -m "${1:?usage: build.sh <destdir> <libdir>}")
libdir=${2:?usage: build.sh <destdir> <libdir>}
pnpm_version=$(node -p "require('./package.json').packageManager.split('@')[1]")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

npm install --prefix "$work/pnpm" --no-audit --no-fund --loglevel=error "pnpm@$pnpm_version"
"$work/pnpm/node_modules/.bin/pnpm" install --frozen-lockfile --ignore-scripts
"$work/pnpm/node_modules/.bin/pnpm" run build
npm pack --ignore-scripts --pack-destination "$work" >/dev/null

target=$dest$libdir/node_modules/@openmixer/plugin-qualify
mkdir -p "$target" "$dest/usr/bin" "$dest/usr/share/man/man1"
tar -xzf "$work"/openmixer-plugin-qualify-*.tgz -C "$target" --strip-components=1
# the one runtime dependency, @openmixer/omx-contract (the declared rates and quanta), beside it: Node resolves it
# from <libdir>/node_modules, the directory above the package
dep=$dest$libdir/node_modules/@openmixer/omx-contract
mkdir -p "$dep"
cp -rL node_modules/@openmixer/omx-contract/. "$dep"/
install -m 0644 packaging/plugin-qualify.1 packaging/plugin-qualify-sync.1 packaging/plugin-qualify-records-package.1 "$dest/usr/share/man/man1/"
install -D -m 0644 packaging/qualify.conf "$dest/etc/omx/qualify.conf"
for cmd in plugin-qualify plugin-qualify-sync plugin-qualify-records-package; do
  ln -sfn "$libdir/node_modules/@openmixer/plugin-qualify/bin/$cmd.mjs" "$dest/usr/bin/$cmd"
done
