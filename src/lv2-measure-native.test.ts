// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The LV2 measurer taken in from openmixer (`native/lv2-measure.c`), run as built (`make -C native`):
 * its features oracle passes, and under the interposer it tells the two LV2 fixtures apart on the
 * count alone, each line carrying the plugin's pin. On CI a missing build is a failure; elsewhere the
 * tests skip, saying how to build.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const NATIVE = join(dirname(fileURLToPath(import.meta.url)), "..", "native");
const BUILD = join(NATIVE, "build");
const MEASURE = join(BUILD, "lv2_measure");
const ORACLE = join(BUILD, "lv2_measure_features_test");
const INTERPOSER = join(BUILD, "rt_interpose.so");
const LV2_FIXTURES = join(BUILD, "fixtures", "lv2");
const SAFE = "urn:plugin-qualify:fixture:lv2-rt-safe";
const UNSAFE = "urn:plugin-qualify:fixture:lv2-rt-unsafe";
const BUILT = [MEASURE, ORACLE, INTERPOSER, join(LV2_FIXTURES, "rt-safe.lv2", "gain.so")].every((p) => existsSync(p));

function live(name: string, body: () => void): void {
  it(name, (ctx) => {
    if (!BUILT) {
      if (process.env["CI"]) throw new Error("native/build is missing: CI builds it with make -C native deps all");
      ctx.skip("native/build is missing: make -C native deps all");
    }
    body();
  });
}

function measure(...args: string[]): { status: number | null; line: Record<string, unknown> } {
  const r = spawnSync(MEASURE, args, {
    encoding: "utf8",
    env: { PATH: process.env["PATH"], LV2_PATH: LV2_FIXTURES, LD_PRELOAD: INTERPOSER },
  });
  return { status: r.status, line: JSON.parse(r.stdout) as Record<string, unknown> };
}

describe("lv2-measure, live — the LV2 fixtures", () => {
  live("the features oracle passes", () => {
    const r = spawnSync(ORACLE, [], { cwd: NATIVE, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  live("counts no allocation in the safe fixture's run(), and every block's in the unsafe one's", () => {
    const safe = measure(SAFE, "48000", "64", "3", "2");
    const unsafe = measure(UNSAFE, "48000", "64", "3", "2");
    expect(safe.status).toBe(0);
    expect(unsafe.status).toBe(0);
    expect(safe.line["rtSafety"]).toMatchObject({ interposer: true, swept: true, allocationsInRun: 0, locksInRun: 0, syscallsInRun: 0 });
    expect(unsafe.line["rtSafety"]).toMatchObject({ interposer: true, swept: true, allocationsInRun: 1024 });
  });

  live("prints the plugin's pin beside the measurement, and alone with --pin", () => {
    const { line } = measure(SAFE, "48000", "64", "1", "1");
    expect(line["integrity"]).toMatchObject({
      version: "1.0",
      files: [{ path: "gain.so" }, { path: "gain.ttl" }, { path: "manifest.ttl" }],
      layout: { scheme: "omx-layout/1" },
    });
    const pin = measure("--pin", SAFE);
    expect(pin.status).toBe(0);
    expect(pin.line["integrity"]).toEqual(line["integrity"]);
  });

  live("a plugin it cannot find exits 3, said as not found", () => {
    const r = measure("urn:plugin-qualify:not-here");
    expect(r.status).toBe(3);
    expect(r.line).toEqual({ uri: "urn:plugin-qualify:not-here", found: false });
  });
});
