#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
#
# The headers the prober builds against, each at a release tag: the CLAP SDK and plugin-hostd (its pin.h).
#
#   fetch-deps.sh <dir> <clap-tag> <plugin-hostd-tag>
set -eu

dir=${1:?usage: fetch-deps.sh <dir> <clap-tag> <plugin-hostd-tag>}
clap_ref=${2:?}
hostd_ref=${3:?}

fetch() { # <url> <tag> <into>
  rm -rf "$3"
  git init -q "$3"
  git -C "$3" fetch -q --depth 1 "$1" "refs/tags/$2"
  git -C "$3" checkout -q FETCH_HEAD
}

mkdir -p "$dir"
fetch https://github.com/free-audio/clap "$clap_ref" "$dir/clap"
fetch https://github.com/FreeMixer/plugin-hostd "$hostd_ref" "$dir/plugin-hostd"
