#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * `plugin-qualify` — the entry point (spec 2026-09-25-plugin-qualify.md §5). Every decision is a
 * pure function in `src/qualify-cli.ts`; this file only reads argv, prints and exits.
 *
 * NOT YET WIRED (refused with exit 2, never a silent partial run): driving the offline pass
 * (`tools/lv2-measure.mjs`) for a named subset and the mod-host hosting sweep from this entry
 * point. Until then a run that would measure refuses and says which step is missing.
 */
import { ClapScanError, EXIT_CODE, clapLoader, helpText, lv2Loader, parseQualifyArgs, resolveHostProfiles, resolveTargets } from "../dist/index.js";

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
}
process.stderr.write(
  "plugin-qualify: measuring from this entry point is not wired yet " +
    "(offline pass: tools/lv2-measure.mjs; hosting sweep: mod-host) — refusing rather than rating on less\n",
);
process.exit(EXIT_CODE.couldNotMeasure);
