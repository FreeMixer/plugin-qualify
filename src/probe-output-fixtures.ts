// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The probe-output documents the tests build on, read from `fixtures/probe-output/`: plugin-hostd's
 * three example documents (a success on the reference rig, a crash, a refusal for memory). Kept
 * out of the test files so every test reads the same documents; a `.test.ts` imported for a helper
 * runs its whole suite in each importer.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readProbeOutput, type ProbeOutput } from "./probe-output.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "probe-output");

export function fixtureText(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.json`), "utf8");
}

/** A fixture as a mutable JSON value, for the tests that break one field of it. */
export function fixtureJson(name: string): Record<string, any> {
  return JSON.parse(fixtureText(name));
}

/** A fixture through the reader; throws when the reader refuses it. */
export function readFixture(name: string): ProbeOutput {
  const r = readProbeOutput(fixtureText(name));
  if (!r.ok) throw new Error(`${name}: ${r.code}: ${r.problem}`);
  return r.output;
}
