#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
#
# The headers the prober builds against, each at a release tag: the CLAP SDK and plugin-hostd (its pin.h).
# For the LV2 measurer's parity test, the omx-contract C header openmixer's copy of it (parity/openmixer)
# reads its rates from, at the version openmixer pinned.
#
#   fetch-deps.sh <dir> <clap-tag> <plugin-hostd-tag> <omx-contract-version>
set -eu

usage="usage: fetch-deps.sh <dir> <clap-tag> <plugin-hostd-tag> <omx-contract-version>"
dir=${1:?$usage}
clap_ref=${2:?$usage}
hostd_ref=${3:?$usage}
contract_version=${4:?$usage}

fetch() { # <url> <tag> <into>
  rm -rf "$3"
  git init -q "$3"
  git -C "$3" fetch -q --depth 1 "$1" "refs/tags/$2"
  git -C "$3" checkout -q FETCH_HEAD
}

mkdir -p "$dir"
fetch https://github.com/free-audio/clap "$clap_ref" "$dir/clap"
fetch https://github.com/FreeMixer/plugin-hostd "$hostd_ref" "$dir/plugin-hostd"

rm -rf "$dir/omx-contract"
mkdir -p "$dir/omx-contract"
curl -fsSL --retry 5 "https://registry.npmjs.org/@openmixer/omx-contract/-/omx-contract-$contract_version.tgz" |
  tar -xz -C "$dir/omx-contract" --strip-components=1 package/include
