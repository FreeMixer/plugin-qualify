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
# with the `plugin-qualify` command linked into <destdir>/usr/bin and its manual page beside it.
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
install -m 0644 packaging/plugin-qualify.1 "$dest/usr/share/man/man1/"
ln -sfn "$libdir/node_modules/@openmixer/plugin-qualify/bin/plugin-qualify.mjs" "$dest/usr/bin/plugin-qualify"
