#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
//
// Check the document an installed lv2-measure.mjs wrote for the two LV2 fixtures (check-installed.sh).
//
//   node packaging/check-lv2-measurement.mjs <document.json>
//
// The interposer counted inside run(): nothing for the RT-safe fixture, something for the RT-unsafe
// one. Both survived every lifecycle and carry their pin (the layout fingerprint). Each failure is
// named; any exits 1.
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: check-lv2-measurement.mjs <document.json>");
  process.exit(2);
}
const doc = JSON.parse(readFileSync(path, "utf8"));
const failures = [];
const at = (uri) => doc.plugins?.find((p) => p.uri === uri);

for (const [uri, allocates] of [
  ["urn:plugin-qualify:fixture:lv2-rt-safe", false],
  ["urn:plugin-qualify:fixture:lv2-rt-unsafe", true],
]) {
  const p = at(uri);
  if (p === undefined) {
    failures.push(`${uri} was not measured`);
    continue;
  }
  const rt = p.rtSafety ?? {};
  if (rt.interposer !== true) failures.push(`${uri}: measured without the interposer`);
  const n = rt.allocationsInRun;
  if (allocates ? !(n > 0) : n !== 0) failures.push(`${uri}: ${n} allocations in run()`);
  if (p.stability?.lifecycle?.failed !== 0) failures.push(`${uri}: a lifecycle failed`);
  if (!/^[0-9a-f]{64}$/.test(p.integrity?.layout?.sha256 ?? "")) failures.push(`${uri}: no layout fingerprint`);
  console.log(`check-lv2-measurement: ${uri}: ${n} allocations in run()`);
}

for (const f of failures) console.error(`check-lv2-measurement: ${f}`);
process.exit(failures.length > 0 ? 1 : 0);
