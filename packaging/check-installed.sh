#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
#
# Check an installed plugin-qualify package qualifies CLAP plugins with nothing set: the prober and
# the interposer are the package's own, found where it installed them, and the scanner is the one
# its Recommends pulled in.
#
#   packaging/check-installed.sh <rt-safe.clap> <rt-unsafe.clap>
#
# Runs in the distribution's container after the package is installed, with an empty environment
# (no OMX_* setting). The safe fixture must qualify (exit 0, suitable), the unsafe one must not
# (exit 1, unsuitable), and the installed prober must print the fixture's integrity pin.
set -euo pipefail

safe=$(readlink -f "${1:?usage: check-installed.sh <rt-safe.clap> <rt-unsafe.clap>}")
unsafe=$(readlink -f "${2:?usage: check-installed.sh <rt-safe.clap> <rt-unsafe.clap>}")
bare() { env -i PATH=/usr/bin:/bin HOME="$HOME" "$@"; }
fail() { echo "check-installed: $*" >&2; exit 1; }
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

set +e
bare plugin-qualify --out "$out" "$safe" | tee "$out/safe.txt"
rc=${PIPESTATUS[0]}
set -e
[ "$rc" -eq 0 ] || fail "plugin-qualify $safe exited $rc, not 0"
grep -Eq '^urn:clap:\S+ +suitable ' "$out/safe.txt" || fail "$safe is not suitable"
ls "$out"/*.rt-safety.json >/dev/null || fail "no RT-safety document was written"

set +e
bare plugin-qualify "$unsafe" | tee "$out/unsafe.txt"
rc=${PIPESTATUS[0]}
set -e
[ "$rc" -eq 1 ] || fail "plugin-qualify $unsafe exited $rc, not 1"
grep -Eq '^urn:clap:\S+ +unsuitable ' "$out/unsafe.txt" || fail "$unsafe is not unsuitable"

# the pin a console hands plugin-hostd: the installed prober prints it beside the measurement
tool=$( (dpkg -L plugin-qualify 2>/dev/null || rpm -ql plugin-qualify) | grep '/clap-qualify$' || true)
dir=$(dirname "${tool:-/nowhere/clap-qualify}")
[ -x "$dir/clap-qualify" ] || fail "the package installs no clap-qualify"
bare LD_PRELOAD="$dir/rt_interpose.so" "$dir/clap-qualify" --rates 48000 --blocks 8 "$safe" > "$out/line.json"
grep -q '"integrity"' "$out/line.json" || fail "the prober printed no integrity block"
grep -Eq '"layout":\{"scheme":"omx-layout/1","sha256":"[0-9a-f]{64}"' "$out/line.json" || fail "the prober printed no layout fingerprint"
echo "check-installed: $dir qualifies CLAP plugins with no setting"
