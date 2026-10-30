// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The distributed records the tests stand on: a `.clap` file of plain bytes, and the record and probe output of it
 * that a measuring device would have written. The record is the real writer's, over plugin-hostd's success fixture
 * with its binary set to the file's own path and SHA-256, judged by the real judge for `omx-clap-host`. The `.clap`
 * is never loaded: a record that applies is the whole point, and one that does not falls to the sweep.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { shippedHostProfile } from "./host-profiles.js";
import { judgeProbeOutput } from "./probe-judge.js";
import { fixtureJson } from "./probe-output-fixtures.js";
import { readProbeOutput } from "./probe-output.js";
import { QUICK_NOT_MEASURED } from "./qualify-sync.js";
import { writeQualification } from "./qualification-record.js";

export const FIXTURE_CLAP_ID = "org.example.plate";
export const FIXTURE_HOST = "omx-clap-host";

const sha = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/** A `.clap` of plain bytes at `path`; returns its SHA-256. */
export function writeFakeClap(path: string, bytes = "not a plugin, only bytes to hash\n"): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
  return sha(bytes);
}

/**
 * The record and probe output of the `.clap` at `clapPath`, as a device's sync writes them, into `dir`. Returns the
 * record's path and the probe copy's.
 */
export function writeFixtureRecord(dir: string, clapPath: string): { recordPath: string; probePath: string } {
  const digest = sha(readFileSync(clapPath));
  const doc = fixtureJson("success-msi");
  doc["binary"] = { ...doc["binary"], path: clapPath, sha256: digest, files: [{ path: basename(clapPath), sha256: digest }] };
  const bytes = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
  const read = readProbeOutput(bytes.toString("utf8"));
  if (!read.ok) throw new Error(`the fixture probe output does not read: ${read.code}: ${read.problem}`);
  const judgment = judgeProbeOutput(read.output, [shippedHostProfile(FIXTURE_HOST)!]);
  const { recordPath, probePath } = writeQualification(dir, bytes, judgment, QUICK_NOT_MEASURED);
  return { recordPath, probePath };
}

/** The provenance a package of the set carries. */
export function fixtureProvenance(hostClass: string, set: string): Record<string, unknown> {
  return {
    schema: "plugin-qualify.distributed-provenance/1",
    set,
    hostClass,
    package: { name: `omx-qualification-${hostClass}-${set}`, version: "2026.10.29" },
    date: "2026-10-29",
    image: "a test image",
    packages: { "plugin-qualify": "0.16.1" },
  };
}

/** A distributed set as a package installs it: `<root>/<class>/<set>/`, its provenance and the record of the `.clap`. */
export function writeFixtureSet(root: string, hostClass: string, set: string, clapPath: string): { dir: string; recordPath: string; probePath: string } {
  const dir = join(root, hostClass, set);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "provenance.json"), `${JSON.stringify(fixtureProvenance(hostClass, set), null, 2)}\n`);
  return { dir, ...writeFixtureRecord(dir, clapPath) };
}
