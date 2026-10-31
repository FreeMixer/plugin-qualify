#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * `plugin-qualify-sync`, the entry point. Every decision is in `src/qualify-sync.ts`; this file reads argv and the
 * settings file, runs one sync, prints its summary line and exits. The exit is 0 whenever the run went through,
 * whatever the plugins' verdicts: a refused plugin is a result, not a failure of the service.
 */
import { readFileSync } from "node:fs";

import { SYNC_CONF, parseSyncArgs, parseSyncConf, resolveSyncSettings, runSync, summaryLine, syncHelpText } from "../dist/index.js";

const log = (line) => process.stderr.write(`plugin-qualify-sync: ${line}\n`);

const parsed = parseSyncArgs(process.argv.slice(2));
if (!parsed.ok) {
  log(parsed.error);
  process.stderr.write(`\n${syncHelpText()}`);
  process.exit(2);
}
if (parsed.args.help) {
  process.stdout.write(syncHelpText());
  process.exit(0);
}
const confPath = parsed.args.config ?? SYNC_CONF;
let confText = "";
try {
  confText = readFileSync(confPath, "utf8");
} catch (e) {
  // the defaults hold without a settings file; a named one that cannot be read is an error
  if (parsed.args.config !== undefined || e.code !== "ENOENT") {
    log(`cannot read ${confPath}: ${e.message}`);
    process.exit(2);
  }
}
const conf = parseSyncConf(confText, confPath);
if (!conf.ok) {
  log(conf.error);
  process.exit(2);
}
const resolved = resolveSyncSettings(conf.values, parsed.args, process.env);
if (!resolved.ok) {
  log(resolved.error);
  process.exit(2);
}
const s = resolved.settings;
const grid = s.grid.kind === "cells" ? s.grid.cells.map((c) => `${String(c.rate)}/${String(c.quantum)}`).join(",") : s.grid.kind;
log(
  `CLAP ${s.clapDirs.join(":")}; LV2 ${s.lv2Dirs.join(":")}; host ${s.hostProfile.id}; grid ${grid}` +
    `${s.cellsPerPluginBudget > 0 ? ` (first ${String(s.cellsPerPluginBudget)} cells)` : ""}; ${String(s.budgetS)} s a run; ` +
    `memory ${s.memory === undefined ? "unbounded" : `${String(s.memory.bytes)} bytes`}`,
);
try {
  const summary = await runSync(s, { force: parsed.args.force, wait: !parsed.args.noWait, refreshOnly: parsed.args.refreshPins, rejudge: parsed.args.rejudge, memoryOnly: parsed.args.memoryOnly, adapterOnly: parsed.args.adapterOnly, isolatedOnly: parsed.args.isolatedOnly, log });
  if (summary !== undefined) {
    process.stdout.write(`${summaryLine(summary)}\n`);
    log(`pins in ${s.pinFile}${summary.sent ? `, ${String(summary.sent)} sent to plugin-hostd` : ""}`);
    // every plugin left unmeasured by one reason of the machine: the run failed, and the unit says so (#192)
    if (summary.machineFailure !== undefined) process.exit(1);
  }
} catch (e) {
  log(`the run stopped: ${e.message}`);
  process.exit(2);
}
