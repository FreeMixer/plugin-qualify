#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * A stand-in for plugin-hostd's `plugin-hostd-probe run`, for the live tests of the command line: it
 * starts the real CLAP prober with the runner's arguments and writes the probe output that carries the
 * prober's line (`probeOutputOfLine`). plugin-hostd's runner is not installed where the suite runs, and
 * this is its stage-1 translation in the small, so a verdict the command line prints through it is the
 * verdict of a real measurement read through the real reader. Not part of the package.
 */
import { spawnSync } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";

import { probeOutputOfLine } from "../dist/probe-output-fixtures.js";

const argv = process.argv.slice(2);
if (argv[0] !== "run") {
  process.stderr.write("usage: plugin-hostd-probe run [options] <plugin.clap> [<clap id>]\n");
  process.exit(2);
}
const opts = {};
let i = 1;
for (; i < argv.length && argv[i].startsWith("--"); i += 2) opts[argv[i]] = argv[i + 1];
const [file, id] = argv.slice(i);
if (file === undefined || opts["--out"] === undefined || opts["--child"] === undefined) {
  process.stderr.write("a plugin file, --child and --out are needed\n");
  process.exit(2);
}
const args = [
  "--rates", opts["--rates"] ?? "48000",
  "--block", opts["--quantum"] ?? "512",
  "--blocks", opts["--blocks"] ?? "512",
  ...(opts["--offer"] === undefined ? [] : ["--offer", opts["--offer"]]),
  file,
  ...(id === undefined ? [] : [id]),
];
const r = spawnSync(opts["--child"], args, { encoding: "utf8", maxBuffer: 64 << 20 });
if (r.status !== 0) {
  process.stderr.write(`the child exited ${r.status}: ${r.stderr}`);
  process.exit(r.status === 3 ? 3 : 2);
}
const line = JSON.parse(r.stdout.split("\n").find((l) => l.trim() !== ""));
const doc = probeOutputOfLine(line);
for (const point of doc.grid) point.memory = { afterInstantiateKb: 600, afterActivateKb: 1200, atRestKb: 1200, secondInstanceKb: 600 };
writeFileSync(`${opts["--out"]}.new`, JSON.stringify(doc));
renameSync(`${opts["--out"]}.new`, opts["--out"]);
