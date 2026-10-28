#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
#
# The after-install scan, end to end on a clean image (#168): build this checkout's package, install it, install a
# plugin package, and see the plugin's qualification record, descriptor and pin appear with no manual step; upgrade
# the plugin package with a changed bundle and see them change; remove it and see them go.
#
#   podman run --rm -v "$PWD":/src:ro,Z docker.io/library/debian:trixie bash /src/tools/install-roundtrip.sh /src
#   podman run --rm -v "$PWD":/src:ro,Z docker.io/library/fedora:44     bash /src/tools/install-roundtrip.sh /src
#
# Runs as root inside a throwaway container; rootless podman has no systemd, which is the "direct run" branch of
# packaging/trigger-scan.sh (the image-build and chroot case). The scan is never started by hand: every record, descriptor and
# pin below is what the package manager's trigger left. The units under a running systemd (the service start branch)
# are not exercised here. Network is needed: the OpenMixer channel (OPENMIXER_URL) and npm.
#
# Exit 0 when every check holds; each failed check is printed, the run goes on, and the exit is 1.
set -uo pipefail

src=$(readlink -f "${1:?usage: install-roundtrip.sh <checkout>}")
url=${OPENMIXER_URL:-https://www.openmixer.org}
state=/var/lib/omx
uri_a=urn:plugin-qualify:fixture:lv2-rt-safe
uri_b=urn:plugin-qualify:fixture:lv2-rt-safe-lib64
fails=0
work=$(mktemp -d /tmp/roundtrip.XXXXXX)

say() { printf '\n== %s\n' "$*"; }
check() { # check <what> <command...>
  local what=$1; shift
  if "$@" >/dev/null 2>&1; then echo "ok    $what"; else echo "FAIL  $what"; fails=$((fails + 1)); fi
}
absent() { ! "$@"; }
has_file_with() { grep -rqF -- "$2" "$1" 2>/dev/null; } # has_file_with <dir> <text>
pins() { cat "$state/qualified.pins" 2>/dev/null; }
pin_of() { pins | grep -F -- "$1" | head -1; }
show() {
  echo "-- records:";     ls "$state/qualification" 2>/dev/null | sed 's/^/   /'
  echo "-- descriptors:"; (cd "$state/descriptors" 2>/dev/null && find . -type f | sort | sed 's/^/   /')
  echo "-- pins:";        pins | sed 's/^/   /'
}

if command -v dnf >/dev/null; then fmt=rpm; else fmt=deb; fi

# --- the clean image: the channel, the build tools ------------------------------------------------------------------
say "prepare ($fmt)"
if [ $fmt = rpm ]; then
  grep -qx 'retries=10' /etc/dnf/dnf.conf || echo 'retries=10' >> /etc/dnf/dnf.conf
  dnf install -y --setopt=install_weak_deps=False "$url/rpm/openmixer-release.noarch.rpm" >/dev/null &&
    dnf install -y --setopt=install_weak_deps=False rpm-build dnf-plugins-core gcc make lv2-devel clap-devel tar gzip >/dev/null || exit 2
else
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y --no-install-recommends ca-certificates curl >/dev/null || exit 2
  curl -fsSL --retry 5 -o "$work/release.deb" "$url/deb/openmixer-release.deb" && chmod 755 "$work" &&
    apt-get install -y --no-install-recommends "$work/release.deb" >/dev/null && apt-get update -qq || exit 2
  apt-get install -y --no-install-recommends devscripts equivs fakeroot build-essential lv2-dev clap-headers >/dev/null || exit 2
fi

# --- this checkout's package ------------------------------------------------------------------------------------------
say "build plugin-qualify"
tree=$work/tree
mkdir -p "$tree" && (cd "$src" && tar --exclude=./node_modules --exclude=./.git --exclude=./native/build --exclude=./native/deps --exclude=./dist -cf - .) | tar -xf - -C "$tree"
if [ $fmt = rpm ]; then
  ver=$(rpmspec -q --qf '%{version}\n' "$tree/packaging/plugin-qualify.spec" | head -1)
  dnf builddep -y "$tree/packaging/plugin-qualify.spec" >/dev/null || exit 2
  mkdir -p "$work/rpmbuild/SOURCES" && cp -r "$tree" "$work/plugin-qualify-$ver" &&
    tar -czf "$work/rpmbuild/SOURCES/plugin-qualify-$ver.tar.gz" -C "$work" "plugin-qualify-$ver"
  rpmbuild -bb --define "_topdir $work/rpmbuild" "$tree/packaging/plugin-qualify.spec" >"$work/build.log" 2>&1 || { tail -30 "$work/build.log"; exit 2; }
  pkg=$(ls "$work"/rpmbuild/RPMS/*/plugin-qualify-[0-9]*.rpm)
else
  (cd "$tree" && mk-build-deps -i -r -t 'apt-get -y --no-install-recommends' debian/control >/dev/null 2>&1 &&
    dpkg-buildpackage -us -uc -b >"$work/build.log" 2>&1) || { tail -30 "$work/build.log"; exit 2; }
  pkg=$(ls "$work"/plugin-qualify_*.deb)
fi
echo "built $pkg"

say "install plugin-qualify"
# the package manager's defaults, recommends included: the descriptor writer needs python3-lilv, which the deb recommends
if [ $fmt = rpm ]; then dnf install -y "$pkg" >/dev/null || exit 2; else apt-get install -y "$pkg" >/dev/null || exit 2; fi
echo "-- after the install, with no plugin: state file $( [ -e $state/qualify-sync.json ] && echo present || echo absent )"
check "the trigger script ships" test -x "$( (dpkg -L plugin-qualify 2>/dev/null || rpm -ql plugin-qualify) | grep '/trigger-scan$')"
check "installing with no plugin leaves no record" absent test -e "$state/qualification/$uri_a"

# --- a plugin package: the repo's own LV2 fixture, packed as a distribution package would ------------------------------
say "build the plugin package"
fx=$work/fx
make -C "$src/native" BUILD="$fx" "$fx/fixtures/lv2/rt-safe.lv2/gain.so" >/dev/null 2>&1 || { echo "the fixture bundle does not build"; exit 2; }
bundle() { # bundle <root> <libdir> <version-marker>: the bundles of one plugin package version
  local root=$1 lib=$2 mark=$3 b=$root$2/rt-safe.lv2
  mkdir -p "$b" && cp "$fx"/fixtures/lv2/rt-safe.lv2/* "$b/"
  [ -z "$mark" ] || echo "# $mark" >> "$b/gain.ttl" # a changed bundle: the plugin's file set hashes differently
  if [ $fmt = rpm ]; then # the second plugin of the Fedora package lives in /usr/lib64/lv2, under a uri of its own
    local b2=$root/usr/lib64/lv2/rt-safe-lib64.lv2
    mkdir -p "$b2" && cp "$fx"/fixtures/lv2/rt-safe.lv2/* "$b2/" && sed -i "s/lv2-rt-safe/lv2-rt-safe-lib64/g" "$b2"/*.ttl
    [ -z "$mark" ] || echo "# $mark" >> "$b2/gain.ttl"
  fi
}
mkplugin() { # mkplugin <version> <marker>: ./fakeplug-<version>.<fmt>
  local v=$1 m=$2 root=$work/pkg-$1
  rm -rf "$root"; bundle "$root" /usr/lib/lv2 "$m"
  if [ $fmt = deb ]; then
    mkdir -p "$root/DEBIAN"
    printf 'Package: fakeplug\nVersion: %s\nArchitecture: %s\nMaintainer: nobody <nobody@example.org>\nDescription: a fake LV2 plugin package\n' "$v" "$(dpkg --print-architecture)" > "$root/DEBIAN/control"
    dpkg-deb --root-owner-group --build "$root" "$work/fakeplug-$v.deb" >/dev/null
  else
    cat > "$work/fake-$v.spec" <<SPEC
Name: fakeplug
Version: $v
Release: 1
Summary: a fake LV2 plugin package
License: GPL-3.0-or-later
AutoReqProv: no
%global debug_package %{nil}
%description
a fake LV2 plugin package
%install
cp -a $root/. %{buildroot}/
%files
/usr/lib/lv2/rt-safe.lv2
/usr/lib64/lv2/rt-safe-lib64.lv2
SPEC
    rpmbuild -bb --define "_topdir $work/rpmbuild" "$work/fake-$v.spec" >"$work/fake.log" 2>&1 && cp "$work"/rpmbuild/RPMS/*/fakeplug-$v-1.*.rpm "$work/fakeplug-$v.rpm"
  fi
  [ -f "$work/fakeplug-$v.$fmt" ] || { echo "no fake package $v"; tail -20 "$work/fake.log" 2>/dev/null; exit 2; }
}
mkplugin 1.0 ""
mkplugin 2.0 "version 2"
# what the package manager's own trigger printed is the scan's log: the lines that say what it did are shown
scan_log() { sed 's/^>>> //' "$work/out" | grep -E '^(qualified |urn:|clap:|LV2 descriptors|plugin-qualify|.*: gone|.*: removed)' | sed 's/^/   scan: /'; }
install_pkg() { if [ $fmt = rpm ]; then dnf install -y "$1" >"$work/out" 2>"$work/err"; else apt-get install -y "$1" >"$work/out" 2>"$work/err"; fi; local rc=$?; scan_log; return $rc; }
remove_pkg() { if [ $fmt = rpm ]; then dnf remove -y "$1" >"$work/out" 2>"$work/err"; else apt-get remove -y "$1" >"$work/out" 2>"$work/err"; fi; local rc=$?; scan_log; return $rc; }

# --- install --------------------------------------------------------------------------------------------------------------
say "install the plugin package: nothing is run by hand"
install_pkg "$work/fakeplug-1.0.$fmt" || { cat "$work/err"; exit 2; }
show
check "a qualification record names the plugin" has_file_with "$state/qualification" "$uri_a"
check "a descriptor names the plugin" has_file_with "$state/descriptors" "$uri_a"
check "the pin file pins the plugin" grep -qF "$uri_a" "$state/qualified.pins"
if [ $fmt = rpm ]; then
  check "the /usr/lib64/lv2 plugin has a record" has_file_with "$state/qualification" "$uri_b"
  check "the /usr/lib64/lv2 plugin has a descriptor" has_file_with "$state/descriptors" "$uri_b"
  check "the /usr/lib64/lv2 plugin is pinned" grep -qF "$uri_b" "$state/qualified.pins"
fi
pin1=$(pin_of "$uri_a")
rec1=$(cat "$state/qualification"/* 2>/dev/null | sha256sum)

# --- upgrade --------------------------------------------------------------------------------------------------------------
say "upgrade the plugin package with a changed bundle"
install_pkg "$work/fakeplug-2.0.$fmt" || { cat "$work/err"; exit 2; }
show
pin2=$(pin_of "$uri_a")
check "the pin changed with the bundle" test -n "$pin2" -a "$pin1" != "$pin2"
check "the record changed with the bundle" test "$rec1" != "$(cat "$state/qualification"/* 2>/dev/null | sha256sum)"
check "the descriptor is still there" has_file_with "$state/descriptors" "$uri_a"

# --- removal --------------------------------------------------------------------------------------------------------------
say "remove the plugin package"
remove_pkg fakeplug || { cat "$work/err"; exit 2; }
show
check "the pin is gone" absent grep -qF "$uri_a" "$state/qualified.pins"
check "the record is gone" absent has_file_with "$state/qualification" "$uri_a"
check "the descriptor is gone" absent has_file_with "$state/descriptors" "$uri_a"
if [ $fmt = rpm ]; then
  check "the /usr/lib64/lv2 plugin's pin is gone" absent grep -qF "$uri_b" "$state/qualified.pins"
  check "the /usr/lib64/lv2 plugin's record is gone" absent has_file_with "$state/qualification" "$uri_b"
  check "the /usr/lib64/lv2 plugin's descriptor is gone" absent has_file_with "$state/descriptors" "$uri_b"
fi

echo
[ "$fails" -eq 0 ] && echo "install-roundtrip: every check holds ($fmt)" || echo "install-roundtrip: $fails check(s) failed ($fmt)"
rm -rf "$work"
[ "$fails" -eq 0 ]
