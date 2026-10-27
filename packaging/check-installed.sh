#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
#
# Check an installed plugin-qualify package qualifies CLAP and LV2 plugins with nothing set: the
# prober, the measurer and the interposer are the package's own, found where it installed them, and
# the scanner is the one its omx-clap-host dependency pulled in.
#
#   packaging/check-installed.sh <rt-safe.clap> <rt-unsafe.clap> <dir holding rt-safe.lv2, rt-unsafe.lv2>
#
# Runs in the distribution's container after the package is installed, with an empty environment
# (no OMX_* setting, no LV2_PATH: the LV2 bundles go in ~/.lv2, where lilv looks). The safe CLAP
# fixture must qualify (exit 0, suitable), the unsafe one must not (exit 1, unsuitable), and the
# installed prober must print the fixture's integrity pin. The installed lv2-measure.mjs must measure
# the LV2 fixtures' hosting dimensions through the installed measurer: no allocation in the safe
# one's run(), some in the unsafe one's, each with its pin. The installed LV2 host probe must run.
set -euo pipefail

usage="usage: check-installed.sh <rt-safe.clap> <rt-unsafe.clap> <lv2-fixture-dir>"
safe=$(readlink -f "${1:?$usage}")
unsafe=$(readlink -f "${2:?$usage}")
lv2=$(readlink -f "${3:?$usage}")
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
# --out holds the qualification record and, beside it, the byte copy of the probe output it judged
records=("$out"/*.qualification.json)
[ -f "${records[0]}" ] || fail "no qualification record was written"
for r in "${records[@]}"; do
  [ -f "${r%.qualification.json}.probe.json" ] || fail "$r has no probe output beside it"
done

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

# the LV2 fixtures, measured by the installed lv2-measure.mjs through the installed lv2_measure
[ -x "$dir/lv2_measure" ] || fail "the package installs no lv2_measure"
mkdir -p "$HOME/.lv2"
cp -r "$lv2/rt-safe.lv2" "$lv2/rt-unsafe.lv2" "$HOME/.lv2/"
measure=$( (dpkg -L plugin-qualify 2>/dev/null || rpm -ql plugin-qualify) | grep '/tools/lv2-measure\.mjs$' || true)
[ -n "$measure" ] || fail "the package installs no lv2-measure.mjs"
(cd "$out" && bare node "$measure" --rates 48000 --dimensions stability,rtSafety,features \
  --plugins urn:plugin-qualify:fixture:lv2-rt-safe,urn:plugin-qualify:fixture:lv2-rt-unsafe --out "$out/lv2.json" --run) ||
  fail "lv2-measure.mjs failed on the LV2 fixtures"
bare node packaging/check-lv2-measurement.mjs "$out/lv2.json" || fail "the LV2 measurement is not the fixtures'"
echo "check-installed: $dir measures LV2 plugins with no setting"

# the LV2 host probe a console runs on the plugin it exports: installed, and it tells a plugin lilv
# cannot find (exit 2) from one that failed a claim (exit 1)
[ -x "$dir/lv2_host_probe" ] || fail "the package installs no lv2_host_probe"
set +e
bare "$dir/lv2_host_probe" "$lv2/rt-safe.lv2" urn:plugin-qualify:fixture:no-such-plugin > "$out/probe.txt" 2>&1
rc=$?
set -e
[ "$rc" -eq 2 ] || fail "lv2_host_probe on a plugin the bundle lacks exited $rc, not 2"
grep -q 'could not find urn:plugin-qualify:fixture:no-such-plugin' "$out/probe.txt" || fail "lv2_host_probe did not name the plugin it could not find"
echo "check-installed: $dir carries the LV2 host probe"

# the sync's units: shipped, the timer and the path unit enabled by the install, and no sweep run inside it
for unit in plugin-qualify-sync.service plugin-qualify-sync.timer plugin-qualify-sync.path; do
  [ -f "/usr/lib/systemd/system/$unit" ] || [ -f "/lib/systemd/system/$unit" ] || fail "the package installs no $unit"
done
[ -L /etc/systemd/system/timers.target.wants/plugin-qualify-sync.timer ] || fail "the install did not enable plugin-qualify-sync.timer"
[ -L /etc/systemd/system/paths.target.wants/plugin-qualify-sync.path ] || fail "the install did not enable plugin-qualify-sync.path"
[ ! -e /var/lib/omx/qualify-sync.json ] || fail "a sweep ran inside the package transaction"
[ -f /etc/omx/qualify.conf ] || fail "the package installs no /etc/omx/qualify.conf"
# the installed sync over the safe fixtures, with nothing set but where it looks and writes
mkdir -p "$out/sync/clap" "$out/sync/lv2"
cp "$safe" "$out/sync/clap/"
cp -r "$lv2/rt-safe.lv2" "$out/sync/lv2/"
bare plugin-qualify-sync --clap-path "$out/sync/clap" --lv2-path "$out/sync/lv2" --lv2-extra "" --pin-file "$out/sync/qualified.pins" \
  --qualification-dir "$out/sync/q" --descriptor-dir "$out/sync/d" --state-file "$out/sync/state.json" --hostd-port 0 > "$out/sync.txt" ||
  fail "plugin-qualify-sync failed"
grep -q '^qualified 2, skipped 0, refused 0, crashed 0, hung 0, unmeasured 0, ' "$out/sync.txt" || fail "plugin-qualify-sync: $(cat "$out/sync.txt")"
[ "$(grep -c ' verdict=in-process$' "$out/sync/qualified.pins")" -eq 2 ] || fail "the sync's pin file does not pin both fixtures in-process"
echo "check-installed: plugin-qualify-sync qualifies a CLAP and an LV2 plugin, and its units are enabled"
