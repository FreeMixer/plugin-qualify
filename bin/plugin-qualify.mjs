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
 * `--all` finds the LV2 plugins of the bundles on the LV2 path, then the CLAP plugins on the standard CLAP search path (`CLAP_PATH`, then `~/.clap`, then
 * `/usr/lib/clap`). `plugin-qualify judge` judges probe outputs already written.
 */
import { readFileSync } from "node:fs";

import {
  adjustHelpText,
  adjustRecords,
  adjustTable,
  adjustedPinEntries,
  parseAdjustArgs,
  readRecords,
  rewriteRecord,
  ClapScanError,
  EXIT_CODE,
  clapLoader,
  clapPinEntries,
  defaultQualificationDir,
  judgeExitCode,
  judgeFiles,
  mergeRunsByRecord,
  judgeHelpText,
  parseJudgeArgs,
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
  writeFileWhole,
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
  writeFileWhole(path, file.text);
  process.stderr.write(`plugin-qualify: ${file.written.length} pin${file.written.length === 1 ? "" : "s"} written to ${path}\n`);
}

if (process.argv[2] === "judge") {
  const j = parseJudgeArgs(process.argv.slice(3));
  if (!j.ok) {
    process.stderr.write(`plugin-qualify judge: ${j.error}\n\n${judgeHelpText()}`);
    process.exit(EXIT_CODE.couldNotMeasure);
  }
  if (j.args.help) {
    process.stdout.write(judgeHelpText());
    process.exit(EXIT_CODE.allQualified);
  }
  const hosts = resolveHostProfiles(j.args.hostProfiles);
  if (!hosts.ok) {
    for (const r of hosts.refused) process.stderr.write(`plugin-qualify judge: --host-profile ${r.spec}: ${r.problem}\n`);
    process.exit(EXIT_CODE.couldNotMeasure);
  }
  const dir = j.args.qualificationDir ?? defaultQualificationDir(process.env);
  const result = judgeFiles(j.args.files, { profiles: hosts.profiles, dir });
  for (const f of result.failures) process.stderr.write(`plugin-qualify judge: ${f.file}: ${f.problem}\n`);
  for (const r of result.records) process.stderr.write(`plugin-qualify judge: record ${r.recordPath}\n`);
  process.stdout.write(
    j.args.format === "json"
      ? `${JSON.stringify(result.records.map((r) => JSON.parse(readFileSync(r.recordPath, "utf8"))), null, 2)}\n`
      : textTable(result.verdicts),
  );
  process.exit(judgeExitCode(result));
}

if (process.argv[2] === "adjust") {
  const a = parseAdjustArgs(process.argv.slice(3));
  if (!a.ok) {
    process.stderr.write(`plugin-qualify adjust: ${a.error}\n\n${adjustHelpText()}`);
    process.exit(EXIT_CODE.couldNotMeasure);
  }
  if (a.args.help) {
    process.stdout.write(adjustHelpText());
    process.exit(EXIT_CODE.allQualified);
  }
  const hosts = resolveHostProfiles(a.args.hostProfiles);
  if (!hosts.ok) {
    for (const r of hosts.refused) process.stderr.write(`plugin-qualify adjust: --host-profile ${r.spec}: ${r.problem}\n`);
    process.exit(EXIT_CODE.couldNotMeasure);
  }
  let text;
  try {
    text = readFileSync(a.args.history, "utf8");
  } catch (e) {
    process.stderr.write(`plugin-qualify adjust: --history ${a.args.history}: cannot read: ${e.message}\n`);
    process.exit(EXIT_CODE.couldNotMeasure);
  }
  const dir = a.args.qualificationDir ?? defaultQualificationDir(process.env);
  const read = readRecords(dir);
  for (const f of read.failures) process.stderr.write(`plugin-qualify adjust: ${f.file}: ${f.problem}\n`);
  if (read.records.length === 0) {
    process.stderr.write(`plugin-qualify adjust: no qualification record in ${dir}\n`);
    process.exit(EXIT_CODE.couldNotMeasure);
  }
  const now = a.args.now ?? Math.floor(Date.now() / 1000);
  const done = adjustRecords(read.records, text, { profiles: hosts.profiles, file: a.args.history, now, ...(a.args.hostClass === undefined ? {} : { hostClass: a.args.hostClass }) });
  if (!done.ok) {
    process.stderr.write(`plugin-qualify adjust: ${done.problem}\n`);
    process.exit(EXIT_CODE.couldNotMeasure);
  }
  if (a.args.pins !== undefined && done.hostClasses.length !== 1) {
    process.stderr.write(
      `plugin-qualify adjust: --pins writes one adjusted verdict per plugin, and ${a.args.history} holds ${String(done.hostClasses.length)} host classes (${done.hostClasses.join(", ")}); name one with --host-class\n`,
    );
    process.exit(EXIT_CODE.couldNotMeasure);
  }
  for (const i of done.ignored) process.stderr.write(`plugin-qualify adjust: ${a.args.history}:${String(i.line)}: not read: ${i.problem}\n`);
  for (const r of done.records) {
    rewriteRecord(r.path, r.record);
    process.stderr.write(`plugin-qualify adjust: record ${r.path}\n`);
  }
  if (a.args.pins !== undefined) writePins(a.args.pins, pinsFile(adjustedPinEntries(done.records, done.hostClasses[0], hosts.profiles[0].id)));
  process.stdout.write(a.args.format === "json" ? `${JSON.stringify(done.records.map((r) => r.record), null, 2)}\n` : adjustTable(done.records));
  process.exit(EXIT_CODE.allQualified);
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
  const lv2 = plugins.filter((p) => p.format === "lv2").length;
  process.stderr.write(`plugin-qualify: --all qualifies ${String(lv2)} LV2 and ${String(plugins.length - lv2)} CLAP plugins on the search paths\n`);
}
const pass = qualifyTargets(plugins, { rates: parsed.args.rates, profiles: profiles.profiles });
for (const f of pass.failures) process.stderr.write(`plugin-qualify: ${f.uri}: ${f.problem}\n`);
if (parsed.args.out !== undefined) {
  for (const run of mergeRunsByRecord(pass.runs)) {
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
