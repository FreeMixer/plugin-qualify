// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The LV2 measurer moved from openmixer unchanged in behaviour: this build (`native/build/lv2_measure`)
 * and openmixer's copy at the commit it was taken from (`native/parity/openmixer`, each file held to its
 * git blob id there; built with the same flags into `native/build/parity/lv2_measure` once
 * `make -C native deps` has fetched the omx-contract header it reads) print the same bytes and exit
 * the same on the fixture
 * bundles, in every mode: a measurement at its defaults and at a rate, block and count, the noise
 * stimulus, the pin alone, a plugin it cannot find, and the soak. The soak's three RSS figures are the
 * process's, not the code's — they move between two runs of one binary — so they are masked.
 *
 * Since the measuring host was made faithful (`lv2-host-faithfulness.test.ts`) ours prints three things
 * openmixer's copy does not, and they alone are taken out of our line before the comparison: the
 * `host` object (what the host did: options, worker, patch:Set, the sweep bounds), the
 * `featureOptions` the host's features were built under (omx-clap-core's provider, at the measurer's
 * defaults here) and the soak's `maxRmsDbfs`. The soak's sweep is bounded now; the soak case lifts the bound (OMX_SWEEP_DB and
 * OMX_SWEEP_RATIO far beyond any range) so both sweep the whole range and the levels compare.
 * On CI a missing build is a failure; elsewhere the test skips, saying how to build.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const NATIVE = join(dirname(fileURLToPath(import.meta.url)), "..", "native");
const BUILD = join(NATIVE, "build");
const SNAPSHOT = join(NATIVE, "parity", "openmixer");
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
/** What only ours prints: the host's facts, the feature options, and the soak's loudest window. */
const FEATURE_OPTIONS = /,"featureOptions":\{"features":\[[^\]]*\],"strict":(?:true|false),"block":\{[^{}]*\},"log":\{[^{}]*\}\}/;
const OURS_ONLY = (stdout: string): string =>
  stdout.replace(/,"host":\{[^{}]*\}/, "").replace(FEATURE_OPTIONS, "").replace(/,"maxRmsDbfs":-?[\d.]+/, "");
const UNBOUNDED = { OMX_SWEEP_DB: "1e9", OMX_SWEEP_RATIO: "1e9" };

const CASES: readonly Case[] = [SAFE, UNSAFE].flatMap((uri): Case[] => [
  { name: `${uri} at the defaults`, args: [uri] },
  { name: `${uri} at 96 kHz, 128 frames, 5 lifecycles, 2 repeats`, args: [uri, "96000", "128", "5", "2"] },
  { name: `${uri} under noise`, args: [uri, "48000", "256", "3", "3"], env: { OMX_STIM: "noise", OMX_PROBE_BLOCKS: "30" } },
  { name: `${uri}, the pin alone`, args: ["--pin", uri] },
  { name: `${uri} soaked for a second`, args: [uri, "48000", "512"], env: { OMX_SOAK_SECONDS: "1", ...UNBOUNDED }, mask: (s) => s.replace(RSS, '"$1":N') },
]).concat([{ name: "a plugin it cannot find", args: ["urn:plugin-qualify:not-here"] }]);

function run(tool: string, c: Case): { status: number | null; stdout: string } {
  const r = spawnSync(tool, [...c.args], {
    encoding: "utf8",
    env: { PATH: process.env["PATH"], LV2_PATH: LV2_FIXTURES, LD_PRELOAD: INTERPOSER, ...c.env },
  });
  return { status: r.status, stdout: c.mask === undefined ? r.stdout : c.mask(r.stdout) };
}

describe("openmixer's copy is kept as it was there", () => {
  it("every file is the blob BLOBS records, and BLOBS records every file", () => {
    const blob = (path: string): string => {
      const body = readFileSync(path);
      return createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
    };
    const recorded = readFileSync(join(SNAPSHOT, "BLOBS"), "utf8")
      .split("\n")
      .filter((l) => /^[0-9a-f]{40} {2}\S+$/.test(l))
      .map((l) => [l.slice(42), l.slice(0, 40)] as const);
    expect(recorded.map(([f]) => f).sort()).toEqual(readdirSync(SNAPSHOT).filter((f) => f !== "BLOBS").sort());
    for (const [file, id] of recorded) expect(blob(join(SNAPSHOT, file)), file).toBe(id);
  });
});

describe("lv2-measure prints what openmixer's copy prints, byte for byte", () => {
  for (const c of CASES) {
    it(c.name, (ctx) => {
      if (!BUILT) {
        if (process.env["CI"]) throw new Error("native/build/parity is missing: CI builds it with make -C native deps all");
        ctx.skip("native/build/parity is missing: make -C native deps all");
      }
      const ours = { ...run(OURS, c) };
      ours.stdout = OURS_ONLY(ours.stdout);
      const theirs = run(THEIRS, c);
      expect(ours.stdout).toMatch(/^\{"uri":/);
      expect(ours.stdout).toBe(theirs.stdout);
      expect(ours.status).toBe(theirs.status);
    });
  }
});
