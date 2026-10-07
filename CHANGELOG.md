# Changelog

## 0.1.0 — 2026-10-07

First release from this repository. The code is the `packages/plugin-qualify` package of the
openmixer console, unchanged in behaviour:

- the scan, the offline latency and cost measurement (`tools/lv2-measure.mjs`, `scan.py`,
  `benchmark.py`) and the mod-host hosting sweep;
- the fail-closed hosting verdict, judged against a host profile (`openmixer-console`, `jalv`,
  `mod-host`, or your own file);
- the `lv2-plugin-measurements` document and its reader;
- the `plugin-qualify` command.

The package now builds itself when installed from git, ships its fixtures, and is tested here on
every pull request.
