// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * README.md and docs/design/probe-isolation-and-cost-grid.md both name a measurement format
 * version in prose, apart from format.ts. #112: README said format 1.2 while format.ts had
 * moved to 1.5, and the design note's "format.ts 1.4 adds perRateQuantum" named a minor 1.4
 * had shipped for something else (CostAtRate.voices). This file ties both back to format.ts
 * so a version bump that forgets the docs goes red here.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MEASUREMENT_FORMAT_MINOR, MEASUREMENT_FORMAT_VERSION } from "./format.js";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(join(PKG, rel), "utf8");

/** The version README.md's JSON-document section says `--out` writes. */
function readmeFormatVersion(text: string): string | undefined {
  return text.match(/`lv2-plugin-measurements`, format (\d+\.\d+),/)?.[1];
}

/** The minor the probe-isolation design note reserves for a `perRateQuantum` field not yet built. */
function designNoteReservedMinor(text: string): number | undefined {
  const m = text.match(/`format\.ts` \d+\.(\d+) adds `perRateQuantum`/);
  return m ? Number(m[1]) : undefined;
}

describe("the measurement format version documented in prose is format.ts's", () => {
  const readme = read("README.md");
  const designNote = read("docs/design/probe-isolation-and-cost-grid.md");

  it("README.md names a format version — positive control", () => {
    expect(readmeFormatVersion(readme)).toBeDefined();
  });

  it("README.md names format.ts's current version", () => {
    expect(readmeFormatVersion(readme)).toBe(MEASUREMENT_FORMAT_VERSION);
  });

  it("a README naming an old version is seen — sabotage control", () => {
    const stale = readme.replace(`format ${MEASUREMENT_FORMAT_VERSION},`, "format 1.2,");
    expect(readmeFormatVersion(stale)).not.toBe(MEASUREMENT_FORMAT_VERSION);
  });

  it("the probe-isolation design note reserves a minor for perRateQuantum — positive control", () => {
    expect(designNoteReservedMinor(designNote)).toBeDefined();
  });

  it("the design note's reserved minor is the next one free, not one format.ts already shipped", () => {
    const reserved = designNoteReservedMinor(designNote)!;
    expect(reserved).toBeGreaterThan(MEASUREMENT_FORMAT_MINOR);
  });

  it("a format.ts bump that swallows the design note's reserved minor is seen — sabotage control", () => {
    const reserved = designNoteReservedMinor(designNote)!;
    const bumpedCurrentMinor = reserved; // format.ts ships the reserved minor for something else
    expect(reserved).not.toBeGreaterThan(bumpedCurrentMinor);
  });
});
