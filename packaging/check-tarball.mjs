#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
//
// Check a packed tarball against the package.json beside this script's tree.
//
//   node packaging/check-tarball.mjs <openmixer-plugin-qualify-<version>.tgz>
//
// The tarball is named for the package's version and carries dist/index.js, the CLAP scan fixture,
// `main`, `types`, every `bin` and every `exports` target (a `*` target needs at least one file under
// its prefix), and no Python bytecode. Each missing file is named; any failure exits 1.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const tarball = process.argv[2];
if (!tarball) {
  console.error("usage: check-tarball.mjs <tarball>");
  process.exit(2);
}
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const files = new Set(
  execFileSync("tar", ["-tzf", tarball], { encoding: "utf8", maxBuffer: 64 << 20 })
    .split("\n")
    .filter(Boolean)
    .map((f) => f.replace(/^package\//, "")),
);

const failures = [];
const want = `${pkg.name.replace(/^@/, "").replace("/", "-")}-${pkg.version}.tgz`;
if (basename(tarball) !== want) failures.push(`the tarball is ${basename(tarball)}, not ${want}`);

const targets = new Set();
const walk = (t) => {
  if (typeof t === "string") targets.add(t.replace(/^\.\//, ""));
  else if (t && typeof t === "object") Object.values(t).forEach(walk);
};
walk(["dist/index.js", "fixtures/clap-scan/fake.json", pkg.main, pkg.types, pkg.bin, pkg.exports]);

for (const path of targets) {
  if (path.includes("*")) {
    const prefix = path.slice(0, path.indexOf("*"));
    if (![...files].some((f) => f.startsWith(prefix))) failures.push(`nothing under ${prefix}`);
  } else if (!files.has(path)) {
    failures.push(`missing ${path}`);
  }
}
for (const f of files) if (/__pycache__|\.pyc$/.test(f)) failures.push(`carries ${f}`);

if (failures.length) {
  for (const f of failures) console.error(`check-tarball: ${f}`);
  process.exit(1);
}
console.log(`check-tarball: ${basename(tarball)} carries all ${targets.size} targets`);
