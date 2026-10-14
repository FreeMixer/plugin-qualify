#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * `plugin-qualify` — the entry point (spec 2026-09-25-plugin-qualify.md §5). Every decision is a
 * pure function in `src/qualify-cli.ts`; this file only reads argv, prints and exits.
 *
 * CLAP targets are qualified here: the prober (`native/clap-qualify`) runs each under the interposer
 * and every plugin gets its RT-safety verdict document, per binary hash and console.
 *
 * NOT YET WIRED for LV2 (refused with exit 2, never a silent partial run): driving the offline pass
 * (`tools/lv2-measure.mjs`) for a named subset and the mod-host hosting sweep from this entry
 * point. Until then a run that would measure an LV2 refuses and says which step is missing.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  ClapScanError,
  EXIT_CODE,
  clapLoader,
  clapPinEntries,
  exitCodeFor,
  helpText,
  lv2Loader,
  parseQualifyArgs,
  pinsFile,
  qualifyClapTargets,
  resolveHostProfiles,
  resolveTargets,
  rtSafetyDocumentName,
  textTable,
} from "../dist/index.js";

/**
 * The pins file, whole or not at all: written beside the target and renamed over it, and left alone when the run took no
 * pin, so a run that measured nothing never empties the file a host is reading.
 */
function writePins(path, file) {
  for (const uri of file.skipped) process.stderr.write(`plugin-qualify: ${uri}: no whole pin was taken, so it has no line in ${path}\n`);
  if (file.written.length === 0) {
    process.stderr.write(`plugin-qualify: no pin was taken, ${path} is left as it was\n`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.new`, file.text);
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
if (!parsed.args.all) {
  let r;
  try {
    r = resolveTargets(parsed.args.targets, [clapLoader(), lv2Loader]);
  } catch (e) {
    if (!(e instanceof ClapScanError)) throw e;
    process.stderr.write(`plugin-qualify: ${e.message}\n`);
    process.exit(EXIT_CODE.couldNotMeasure);
  }
  if (!r.ok) {
    process.stderr.write(`plugin-qualify: no plugin found for: ${r.refused.join(", ")}\n`);
    process.exit(EXIT_CODE.couldNotMeasure);
  }
  for (const p of r.plugins) process.stderr.write(`plugin-qualify: target ${p.uri}${p.bundle ? ` (${p.bundle})` : ""}\n`);
  if (r.plugins.every((p) => p.format === "clap")) {
    const pass = qualifyClapTargets(r.plugins, { rates: parsed.args.rates, profiles: profiles.profiles });
    for (const f of pass.failures) process.stderr.write(`plugin-qualify: ${f.uri}: ${f.problem}\n`);
    if (parsed.args.out !== undefined) {
      mkdirSync(parsed.args.out, { recursive: true });
      for (const doc of pass.documents) writeFileSync(join(parsed.args.out, rtSafetyDocumentName(doc)), `${JSON.stringify(doc, null, 2)}\n`);
    }
    if (parsed.args.pins !== undefined) writePins(parsed.args.pins, pinsFile(clapPinEntries(pass.documents, profiles.profiles[0].id)));
    process.stdout.write(parsed.args.format === "json" ? `${JSON.stringify(pass.documents, null, 2)}\n` : textTable(pass.verdicts));
    process.exit(exitCodeFor(pass.verdicts));
  }
}
if (parsed.args.pins !== undefined) process.stderr.write(`plugin-qualify: --pins ${parsed.args.pins}: nothing to pin, this run measures no plugin yet\n`);
process.stderr.write(
  "plugin-qualify: measuring from this entry point is not wired yet " +
    "(offline pass: tools/lv2-measure.mjs; hosting sweep: mod-host) — refusing rather than rating on less\n",
);
process.exit(EXIT_CODE.couldNotMeasure);
