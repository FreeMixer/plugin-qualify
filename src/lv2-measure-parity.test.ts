// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The LV2 measurer moved from openmixer unchanged in behaviour: this build (`native/build/lv2_measure`)
 * and openmixer's copy at the commit it was taken from (`native/build/parity/lv2_measure`, built with
 * the same flags from `make -C native deps`) print the same bytes and exit the same on the fixture
 * bundles, in every mode: a measurement at its defaults and at a rate, block and count, the noise
 * stimulus, the pin alone, a plugin it cannot find, and the soak. The soak's three RSS figures are the
 * process's, not the code's — they move between two runs of one binary — so they alone are masked.
 * On CI a missing build is a failure; elsewhere the test skips, saying how to build.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BUILD = join(dirname(fileURLToPath(import.meta.url)), "..", "native", "build");
const OURS = join(BUILD, "lv2_measure");
const THEIRS = join(BUILD, "parity", "lv2_measure");
const INTERPOSER = join(BUILD, "rt_interpose.so");
const LV2_FIXTURES = join(BUILD, "fixtures", "lv2");
const SAFE = "urn:plugin-qualify:fixture:lv2-rt-safe";
const UNSAFE = "urn:plugin-qualify:fixture:lv2-rt-unsafe";
const BUILT = [OURS, THEIRS, INTERPOSER, join(LV2_FIXTURES, "rt-unsafe.lv2", "gain.so")].every((p) => existsSync(p));

interface Case {
  readonly name: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly mask?: (stdout: string) => string;
}

const RSS = /"(rssStartKb|rssMaxKb|rssGrowthKb)":-?\d+/g;

const CASES: readonly Case[] = [SAFE, UNSAFE].flatMap((uri): Case[] => [
  { name: `${uri} at the defaults`, args: [uri] },
  { name: `${uri} at 96 kHz, 128 frames, 5 lifecycles, 2 repeats`, args: [uri, "96000", "128", "5", "2"] },
  { name: `${uri} under noise`, args: [uri, "48000", "256", "3", "3"], env: { OMX_STIM: "noise", OMX_PROBE_BLOCKS: "30" } },
  { name: `${uri}, the pin alone`, args: ["--pin", uri] },
  { name: `${uri} soaked for a second`, args: [uri, "48000", "512"], env: { OMX_SOAK_SECONDS: "1" }, mask: (s) => s.replace(RSS, '"$1":N') },
]).concat([{ name: "a plugin it cannot find", args: ["urn:plugin-qualify:not-here"] }]);

function run(tool: string, c: Case): { status: number | null; stdout: string } {
  const r = spawnSync(tool, [...c.args], {
    encoding: "utf8",
    env: { PATH: process.env["PATH"], LV2_PATH: LV2_FIXTURES, LD_PRELOAD: INTERPOSER, ...c.env },
  });
  return { status: r.status, stdout: c.mask === undefined ? r.stdout : c.mask(r.stdout) };
}

describe("lv2-measure prints what openmixer's copy prints, byte for byte", () => {
  for (const c of CASES) {
    it(c.name, (ctx) => {
      if (!BUILT) {
        if (process.env["CI"]) throw new Error("native/build/parity is missing: CI builds it with make -C native deps all");
        ctx.skip("native/build/parity is missing: make -C native deps all");
      }
      const ours = run(OURS, c);
      const theirs = run(THEIRS, c);
      expect(ours.stdout).toMatch(/^\{"uri":/);
      expect(ours.stdout).toBe(theirs.stdout);
      expect(ours.status).toBe(theirs.status);
    });
  }
});
