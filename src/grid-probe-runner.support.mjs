#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * A stand-in for plugin-hostd's `plugin-hostd-probe run` that records how it was invoked, for the grid's tests (#193).
 * Each call appends one JSON line to $GRID_PROBE_LOG: the plugin, the rates, the quantum, the blocks, the data limit and
 * whether the memory bound's exit was asked for. It then writes a probe output the way the real runner does: a CLAP
 * file measured at every rate it is given, an LV2 plugin at the highest of them alone, each at the quantum given.
 *
 * $GRID_PROBE_HOG_BYTES_PER_HZ makes the plugin need that many bytes for every hertz of the rate, as a sampler's library
 * grows with the rate. A run whose need passes its --data-bytes allocates past the bound: the child ends as the
 * interposer ends it under the bound (exit 121, no line), or killed by SIGKILL when no bound's exit was asked for.
 * Not part of the package.
 */
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
if (argv[0] !== "run") process.exit(2);
const opts = {};
let i = 1;
for (; i < argv.length && argv[i].startsWith("--"); i += 2) opts[argv[i]] = argv[i + 1];
const [plugin, clapId] = argv.slice(i);
const lv2 = plugin.startsWith("lv2:");
const rates = opts["--rates"].split(",").map(Number);
const quantum = Number(opts["--quantum"]);
const dataBytes = opts["--data-bytes"] === undefined ? undefined : Number(opts["--data-bytes"]);
const boundExit = process.env.OMX_RT_OOM_EXIT !== undefined;
const measured = lv2 ? [Math.max(...rates)] : rates;
appendFileSync(
  process.env.GRID_PROBE_LOG,
  `${JSON.stringify({ plugin, rates, quantum, blocks: opts["--blocks"] === undefined ? undefined : Number(opts["--blocks"]), dataBytes, boundExit })}\n`,
);

const doc = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "probe-output", "success-msi.json"), "utf8"));
doc.plugin = lv2 ? { format: "lv2", id: plugin.slice("lv2:".length), version: "1" } : { ...doc.plugin, id: clapId };
const template = doc.grid[0];
delete template.cost.samples;
const perHz = Number(process.env.GRID_PROBE_HOG_BYTES_PER_HZ ?? "0");
const need = perHz * Math.max(...measured);
doc.run.id = `${doc.run.id}-${String(quantum)}-${measured.join("-")}`;
if (dataBytes !== undefined && need > dataBytes) {
  // the child asked for more than its data limit: under the bound's exit it ends 121 with no line, else the kernel kills it
  doc.run.outcome = boundExit ? "probe.error" : "probe.crashed";
  doc.run.complete = false;
  doc.steps = [
    { step: "hash", outcome: "probe.ok", elapsedMs: 1 },
    boundExit ? { step: "lifecycle", outcome: "probe.error", elapsedMs: 3, exitStatus: 121 } : { step: "lifecycle", outcome: "probe.crashed", elapsedMs: 3, signal: "SIGKILL" },
  ];
  doc.grid = [];
} else {
  doc.grid = measured.map((rate) => ({ ...structuredClone(template), rate, quantum }));
  doc.steps = doc.steps.filter((s) => s.rate === undefined).concat(measured.map((rate) => ({ step: "cost", rate, quantum, outcome: "probe.ok", elapsedMs: 1 })));
}
writeFileSync(`${opts["--out"]}.new`, JSON.stringify(doc));
renameSync(`${opts["--out"]}.new`, opts["--out"]);
process.exit(doc.run.outcome === "probe.ok" ? 0 : 1);
