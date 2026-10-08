# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
Name: plugin-qualify
Version: 0.1.1
Release: 1%{?dist}
License: GPL-3.0-or-later
Summary: Find out whether an audio plugin is safe to run in a live mixing console
URL: https://github.com/FreeMixer/plugin-qualify
BuildArch: noarch

Source0: %{url}/archive/v%{version}/%{name}-%{version}.tar.gz

BuildRequires: nodejs >= 22
BuildRequires: npm

Requires: nodejs >= 22
Requires: python3
Requires: python3-lilv
Recommends: mod-host

# Plain JavaScript and Python: no machine code, so no debug packages.
%global debug_package %{nil}
# Nothing here is a compiled module; the tools are scripts run by their interpreters.
%global __requires_exclude_from ^%{_prefix}/lib/node_modules/.*$

%description
A plugin that glitches on stage is worse than one you never installed.
plugin-qualify takes an LV2 or CLAP plugin and tells you whether it can be
trusted inside a real-time audio engine: it scans the plugin, measures its
latency and CPU cost at the sample rates and buffer sizes you play at, runs it
under a real host with memory checking, and gives one plain verdict. Anything
it could not measure is never a pass. Use it to vet a plugin before a gig, to
curate a plugin collection, or to judge the same plugin against the rules of
different hosts.

%prep
%autosetup

%build

%install
packaging/build.sh %{buildroot} %{_prefix}/lib

%files
%license LICENSE
%doc README.md
%{_bindir}/plugin-qualify
%{_mandir}/man1/plugin-qualify.1*
%{_prefix}/lib/node_modules/@openmixer/

%changelog
* Thu Oct 08 2026 Pau Aliagas <linuxnow@gmail.com> - 0.1.1-1
- plugin-qualify installs from the FreeMixer package channel: `dnf install
  plugin-qualify` on Fedora, `apt install plugin-qualify` on Debian bookworm
  and trixie (Raspberry Pi OS included).
- The npm package is now `@openmixer/plugin-qualify`, published to npm with
  provenance. The `@freemixer/plugin-qualify` name was never published;
  install the new one with `npm install @openmixer/plugin-qualify`.
- The package no longer carries Python bytecode caches.

* Wed Oct 07 2026 Pau Aliagas <linuxnow@gmail.com> - 0.1.0-1
- First release as a package of its own.
- The scan, the offline latency and cost measurement and the mod-host hosting
  sweep.
- The fail-closed hosting verdict, judged against a host profile
  (`openmixer-console`, `jalv`, `mod-host`, or your own file).
- The `lv2-plugin-measurements` document and its reader, and the
  `plugin-qualify` command.
- The package builds itself when installed from git and ships its fixtures.
