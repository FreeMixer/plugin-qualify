#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * `plugin-qualify-records-package`, the entry point: the Debian package of a device's qualification records. Every
 * decision is in `src/records-package.ts`; this file reads argv, builds the package, names what stayed out on stderr
 * and the package on the last line of stdout.
 */
import { buildRecordsPackage, parseRecordsPackageArgs, recordsPackageHelp } from "../dist/index.js";

const log = (line) => process.stderr.write(`plugin-qualify-records-package: ${line}\n`);

const parsed = parseRecordsPackageArgs(process.argv.slice(2));
if (!parsed.ok) {
  log(parsed.error);
  process.stderr.write(`\n${recordsPackageHelp()}`);
  process.exit(2);
}
if ("help" in parsed) {
  process.stdout.write(recordsPackageHelp());
  process.exit(0);
}
let built;
try {
  built = buildRecordsPackage(parsed.args);
} catch (e) {
  log(e.message);
  process.exit(2);
}
for (const l of built.left) log(`${l.name}: ${l.why}; left out`);
process.stdout.write(`${built.path}: ${String(built.records)} records, ${String(built.files)} files\n`);
