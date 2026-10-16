#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
#
# The headers the prober builds against, each at a release tag: the CLAP SDK and plugin-hostd (its pin.h).
# The omx-contract C header the LV2 measurer reads its rates from, at the version the packages require,
# for a build with no omx-contract-devel installed.
# omx-clap-core's LV2 feature provider, the static libomx-clap-lv2 and its header, at the version the
# packages require, built against the fetched CLAP headers and installed into <dir>/omx-clap-lv2, for a
# build with no omx-clap-lv2-devel installed.
#
#   fetch-deps.sh <dir> <clap-tag> <plugin-hostd-tag> <omx-contract-version> <omx-clap-core-version> <omx-dsp-version>
set -eu

usage="usage: fetch-deps.sh <dir> <clap-tag> <plugin-hostd-tag> <omx-contract-version> <omx-clap-core-version> <omx-dsp-version>"
dir=${1:?$usage}
clap_ref=${2:?$usage}
hostd_ref=${3:?$usage}
contract_version=${4:?$usage}
clap_core_version=${5:?$usage}
dsp_version=${6:?$usage}

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

fetch https://github.com/FreeMixer/omx-clap-core "v$clap_core_version" "$dir/omx-clap-core"
fetch https://github.com/FreeMixer/omx-dsp "v$dsp_version" "$dir/omx-dsp"
abs=$(cd "$dir" && pwd)
# the provider's hosted stage reads omx-dsp and omx-contract headers
lv2_cflags="$(pkg-config --cflags lv2 lilv-0 2>/dev/null) -I$abs/omx-dsp/include -I$abs/omx-contract/include"
make -s -C "$dir/omx-clap-core" lv2 CLAP_CFLAGS="-I$abs/clap/include" LV2_CFLAGS="$lv2_cflags"
rm -rf "$dir/omx-clap-lv2"
make -s -C "$dir/omx-clap-core" install-lv2 CLAP_CFLAGS="-I$abs/clap/include" LV2_CFLAGS="$lv2_cflags" PREFIX="$abs/omx-clap-lv2" \
  LIBDIR="$abs/omx-clap-lv2/lib"
