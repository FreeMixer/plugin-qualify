#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * `plugin-qualify` — the entry point. Every decision is a
 * pure function in `src/qualify-cli.ts`; this file only reads argv, prints and exits.
 *
 * Every named plugin, CLAP or LV2, is measured by plugin-hostd's probe runner (`plugin-hostd-probe`,
 * named by `OMX_PROBE_RUNNER` when it is not on `PATH`), which keeps the deadline and the limits, and is
 * judged from the probe output it writes: the verdict and the qualification record, per host profile.
 * `--all` finds the CLAP plugins on the standard CLAP search path (`CLAP_PATH`, then `~/.clap`, then
 * `/usr/lib/clap`). `plugin-qualify judge` judges probe outputs already written.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

import {
  ClapScanError,
  EXIT_CODE,
  clapLoader,
  clapPinEntries,
  discoverAllTargets,
  exitCodeFor,
  helpText,
  lv2Loader,
  parseQualifyArgs,
  pinsFile,
  qualificationRecordOf,
  qualifyTargets,
  resolveHostProfiles,
  resolveTargets,
  writeQualification,
  textTable,
} from "../dist/index.js";

/**
 * The pins file, whole or not at all: written beside the target and renamed over it, and left alone when the run took no
 * pin, so a run that measured nothing never empties the file a host is reading.
 */
function writePins(path, file) {
  for (const uri of file.skipped) process.stderr.write(`plugin-qualify: ${uri}: no whole pin was taken, so it has no line in ${path}\n`);
  for (const r of file.refused) process.stderr.write(`plugin-qualify: ${r.problem}; it has no line in ${path}\n`);
  if (file.written.length === 0) {
    process.stderr.write(`plugin-qualify: no pin was taken, ${path} is left as it was\n`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  // the bytes on disk before the name moves, so a crash leaves the old file or the whole new one
  const fd = openSync(`${path}.new`, "w");
  try {
    writeSync(fd, file.text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(`${path}.new`, path);
  process.stderr.write(`plugin-qualify: ${file.written.length} pin${file.written.length === 1 ? "" : "s"} written to ${path}\n`);
}

const parsed = parseQualifyArgs(process.argv.slice(2));
if (!parsed.ok) {
  process.stderr.write(`plugin-qualify: ${parsed.error}\n\n${helpText()}`);
  process.exit(EXIT_CODE.couldNotMeasure);
}
if (parsed.args.help) {
  process.stdout.write(helpText());
  process.exit(EXIT_CODE.allQualified);
}
const profiles = resolveHostProfiles(parsed.args.hostProfiles);
if (!profiles.ok) {
  for (const r of profiles.refused) process.stderr.write(`plugin-qualify: --host-profile ${r.spec}: ${r.problem}\n`);
  process.exit(EXIT_CODE.couldNotMeasure);
}
for (const p of profiles.profiles) process.stderr.write(`plugin-qualify: host profile ${p.id} (${p.isolation})\n`);
let plugins;
try {
  if (parsed.args.all) plugins = discoverAllTargets();
  else {
    const r = resolveTargets(parsed.args.targets, [clapLoader(), lv2Loader]);
    if (!r.ok) {
      process.stderr.write(`plugin-qualify: no plugin found for: ${r.refused.join(", ")}\n`);
      process.exit(EXIT_CODE.couldNotMeasure);
    }
    plugins = r.plugins;
  }
} catch (e) {
  if (!(e instanceof ClapScanError)) throw e;
  process.stderr.write(`plugin-qualify: ${e.message}\n`);
  process.exit(EXIT_CODE.couldNotMeasure);
}
for (const p of plugins) process.stderr.write(`plugin-qualify: target ${p.uri}${p.bundle ? ` (${p.bundle})` : ""}\n`);
if (plugins.length === 0) {
  process.stderr.write("plugin-qualify: no plugin to measure\n");
  process.exit(EXIT_CODE.couldNotMeasure);
}
if (parsed.args.all) {
  process.stderr.write("plugin-qualify: --all qualified the CLAP plugins on the search path (no LV2 bundle is on the LV2 path)\n");
}
const pass = qualifyTargets(plugins, { rates: parsed.args.rates, profiles: profiles.profiles });
for (const f of pass.failures) process.stderr.write(`plugin-qualify: ${f.uri}: ${f.problem}\n`);
if (parsed.args.out !== undefined) {
  for (const run of pass.runs) {
    const w = writeQualification(parsed.args.out, run.bytes, run.judgment);
    process.stderr.write(`plugin-qualify: record ${w.recordPath}\n`);
  }
}
if (parsed.args.pins !== undefined) writePins(parsed.args.pins, pinsFile(clapPinEntries(pass.documents, profiles.profiles[0].id)));
process.stdout.write(
  parsed.args.format === "json"
    ? `${JSON.stringify(pass.runs.map((r) => qualificationRecordOf(r.bytes, r.judgment)), null, 2)}\n`
    : textTable(pass.verdicts),
);
process.exit(exitCodeFor(pass.verdicts));
