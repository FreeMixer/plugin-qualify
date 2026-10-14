# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
Name: plugin-qualify
Version: 0.8.0
Release: 1%{?dist}
License: GPL-3.0-or-later
Summary: Find out whether an audio plugin is safe to run in a live mixing console
URL: https://github.com/FreeMixer/plugin-qualify

Source0: %{url}/archive/v%{version}/%{name}-%{version}.tar.gz

BuildRequires: nodejs >= 18
BuildRequires: npm
# the CLAP prober, the LV2 measurer and their interposer: the CLAP headers and lilv from Fedora,
# pin.h from plugin-hostd-devel, the declared sample rates from omx-contract-devel, the LV2 host
# features from omx-clap-lv2-devel (a static archive: nothing of it is needed at run time)
BuildRequires: gcc
BuildRequires: make
BuildRequires: pkgconfig
BuildRequires: pkgconfig(clap)
BuildRequires: pkgconfig(lilv-0)
BuildRequires: pkgconfig(lv2)
BuildRequires: pkgconfig(plugin-hostd) >= 0.1.4
BuildRequires: pkgconfig(omx-contract) >= 2.10.1
BuildRequires: pkgconfig(omx-clap-lv2) >= 0.8.0
BuildRequires: pkgconfig(omxdsp) >= 0.18.0

Requires: nodejs >= 18
Requires: python3
Requires: python3-lilv
Recommends: mod-host
# omx-clap-scan, which lists the plugins in a .clap before each is qualified
Recommends: omx-clap-host

# The JavaScript and Python are scripts run by their interpreters, never compiled modules.
%global __requires_exclude_from ^%{_prefix}/lib/node_modules/.*$
# the interposer is preloaded by path, never linked: it provides no library to other packages
%global __provides_exclude_from ^%{_libexecdir}/%{name}/.*$

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
%make_build -C native

%install
packaging/build.sh %{buildroot} %{_prefix}/lib
%make_install -C native LIBEXECDIR=%{_libexecdir}/%{name}

%files
%license LICENSE
%doc README.md
%{_bindir}/plugin-qualify
%{_mandir}/man1/plugin-qualify.1*
%{_prefix}/lib/node_modules/@openmixer/
%{_libexecdir}/%{name}/

%changelog
* Tue Oct 13 2026 Pau Aliagas <linuxnow@gmail.com> - 0.8.0-1
- With no setting, the native tools are looked for in the checkout's own
  native/build first, then where the package installs them, so make -C native
  in a checkout is never shadowed by an older installed prober.
- A prober or the measurer and the interposer it runs under come from one
  place, the first that holds either; a place holding only one of them is
  refused instead of pairing it with the other from elsewhere.

* Tue Oct 13 2026 Pau Aliagas <linuxnow@gmail.com> - 0.7.0-1
- clap-qualify pins a symlinked .clap under the name it was handed, the name
  the console adds and plugin-hostd checks, with the target's bytes.
- A CLAP plugin with more parameters than the host accepts (2048,
  omx-clap-core's cap) reads unpinnable instead of getting a pin the host
  refuses at add.
- A parameter layout that cannot be read says why: a get_info failure, or
  memory running out while reading or hashing the layout.

* Tue Oct 13 2026 Pau Aliagas <linuxnow@gmail.com> - 0.6.0-1
- The package carries the LV2 measurer taken in from openmixer, lv2_measure,
  in /usr/libexec/plugin-qualify beside the CLAP prober. It prints what
  openmixer's copy prints, the plugin's integrity pin included, plus what
  its host now does.
- The measuring host is faithful: it runs a plugin's worker between blocks,
  sends patch:Set to patch:writable parameters, bounds the soak's control
  sweep (OMX_SWEEP_DB, OMX_SWEEP_RATIO), keeps a plugin's stdout out of its
  record, and says what it did in a "host" object.
- benchmark.py runs the plugin's worker between blocks instead of dropping
  its jobs; the cost record carries the worker's counts.
- extractJsonRecord, soakTimeoutSeconds and the soak sweep declarations are
  exported.
- A soak failure measured at the console's rate rates the plugin unsuitable
  at that rate (hosting.stability.soak-failed-at-rate). A rate the supervisor
  cut short reads timedOut, never died.
- The cost gate refuses a reading missing a field it judges
  (hosting.cost.fields-missing); COST_FIELDS, coreFraction and
  classifierCostFromDocument are exported.
- lv2-measure.mjs measures the hosting dimensions (stability, rtSafety,
  features) through it, one process per plugin under the interposer;
  --plugins names the plugins without a scan.
- The command looks for the measurer by its setting (OMX_LV2_MEASURE), then
  where the package installs it, then in the checkout's native/build.

* Tue Oct 13 2026 Pau Aliagas <linuxnow@gmail.com> - 0.5.1-1
- The package carries the CLAP prober and its interposer, in
  /usr/libexec/plugin-qualify, so an installed plugin-qualify qualifies CLAP
  plugins and prints their integrity pin with nothing set. The package is now
  built per architecture.
- The command looks for the prober by its setting, then where the package
  installs it, then in the checkout's native/build.
- omx-clap-host, which brings omx-clap-scan, is recommended.

* Mon Oct 12 2026 Pau Aliagas <linuxnow@gmail.com> - 0.5.0-1
- The CLAP prober and the measurement interchange (v1.3) carry each plugin's
  integrity pin: the SHA-256 of the files the host loads and the omx-layout/1
  fingerprint, computed through plugin-hostd 0.1.4's pin.h.
* Mon Oct 12 2026 Pau Aliagas <linuxnow@gmail.com> - 0.4.1-1
- The npm release builds the native tools before it tests, so this version
  reaches npm; 0.4.0 carries the same code and was never published there.

* Mon Oct 12 2026 Pau Aliagas <linuxnow@gmail.com> - 0.4.0-1
- Each refusal the CLAP host core can answer with now carries a one-line
  description (CLAP_CORE_REFUSAL_DESCRIPTIONS), so a console can show what a
  refused plugin did wrong in plain words.

* Mon Oct 12 2026 Pau Aliagas <linuxnow@gmail.com> - 0.3.0-1
- plugin-qualify now checks CLAP plugins directly. It loads each .clap file
  without a display, runs it at every sample rate and sweeps every parameter
  while watching for anything unsafe on the audio thread, then writes a
  verdict for that exact binary and console. A plugin that has changed since
  it was checked is never trusted on the old verdict.
- The verdict follows the extensions the chosen host profile really offers:
  asking for a profile with no CLAP support now reads as unknown instead of
  borrowing the OpenMixer console's answer.
- The CLAP scan keeps parameter value names, the plugin's modules and its
  remote-control pages, so a console can show named choices and the plugin's
  own control pages.

* Sun Oct 11 2026 Pau Aliagas <linuxnow@gmail.com> - 0.2.1-1
- The GitHub release carries the npm tarball openmixer-plugin-qualify-0.2.1.tgz,
  dist/ built in.

* Sun Oct 11 2026 Pau Aliagas <linuxnow@gmail.com> - 0.2.0-1
- New hosting code `hosting.output.non-finite`: the refusal the
  libomx-clap-core CLAP host gives a plugin whose output goes non-finite.
- `CLAP_CORE_REFUSALS` lists the refusals libomx-clap-core returns from
  open, activate and the timed open, each by the hosting code it answers
  with.
- `ScalingNoteCode` types the words `latency.scalingNote` may carry, and a
  test keeps `benchmark.py`'s scaling notes equal to the declared list.
- The CLAP host extensions list is documented as the mirror of the header
  libomx-clap-core's host object offers.

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
