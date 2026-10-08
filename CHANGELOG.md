# Changelog

## 0.1.1 - 2026-10-08

- plugin-qualify installs from the FreeMixer package channel: `dnf install plugin-qualify` on
  Fedora, `apt install plugin-qualify` on Debian bookworm and trixie (Raspberry Pi OS included).
- The npm package is now `@openmixer/plugin-qualify`, published to npm with provenance. The
  `@freemixer/plugin-qualify` name was never published; install the new one with
  `npm install @openmixer/plugin-qualify`.
- The package no longer carries Python bytecode caches.

## 0.1.0 - 2026-10-07

- First release as a package of its own.
- The scan, the offline latency and cost measurement and the mod-host hosting sweep.
- The fail-closed hosting verdict, judged against a host profile (`openmixer-console`, `jalv`,
  `mod-host`, or your own file).
- The `lv2-plugin-measurements` document and its reader, and the `plugin-qualify` command.
- The package builds itself when installed from git and ships its fixtures.
