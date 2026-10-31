// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The LV2 measurer taken in from openmixer (`native/lv2-measure.c`), run as built (`make -C native`):
 * its feature options oracle passes, and under the interposer it tells the two LV2 fixtures apart on the
 * count alone, each line carrying the plugin's pin. On CI a missing build is a failure; elsewhere the
 * tests skip, saying how to build.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { HOSTING_CODE } from "./hosting-codes.js";
import { noteSweepReasons } from "./hosting-suitability.js";
import { readNoteSweep } from "./measurement/format.js";

const NATIVE = join(dirname(fileURLToPath(import.meta.url)), "..", "native");
const BUILD = join(NATIVE, "build");
const MEASURE = join(BUILD, "lv2_measure");
const MEASURE_ASAN = join(BUILD, "asan", "lv2_measure");
const ORACLE = join(BUILD, "lv2_measure_options_test");
const PATH_ORACLE = join(BUILD, "lv2_measure_path_test");
const INTERPOSER = join(BUILD, "rt_interpose.so");
// liblilv's own world leak (native/lsan.supp) is not ours; every other leak still fails
const LSAN_SUPPRESSIONS = join(NATIVE, "lsan.supp");
const LV2_FIXTURES = join(BUILD, "fixtures", "lv2");
const SAFE = "urn:plugin-qualify:fixture:lv2-rt-safe";
const UNSAFE = "urn:plugin-qualify:fixture:lv2-rt-unsafe";
const SYNTH = "urn:plugin-qualify:fixture:lv2-synth";
const SYNTH_ALLOC = "urn:plugin-qualify:fixture:lv2-synth-alloc";
const BUILT = [MEASURE, ORACLE, PATH_ORACLE, INTERPOSER, join(LV2_FIXTURES, "rt-safe.lv2", "gain.so"),
  join(LV2_FIXTURES, "spaced.lv2", "manifest.ttl"), join(LV2_FIXTURES, "synth.lv2", "synth.so"), join(LV2_FIXTURES, "synth-alloc.lv2", "synth.so")].every((p) => existsSync(p));

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
  live("the feature options oracle passes", () => {
    const r = spawnSync(ORACLE, [], { cwd: NATIVE, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  live("the LV2 search path oracle passes: a relative segment becomes absolute, nothing else moves", () => {
    const r = spawnSync(PATH_ORACLE, [], { cwd: NATIVE, encoding: "utf8" });
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

  live("plays an instrument through its MIDI input and counts that apart: the allocating synth only once played", () => {
    const safe = measure(SYNTH, "48000", "512", "1", "1");
    const alloc = measure(SYNTH_ALLOC, "48000", "512", "1", "1");
    expect(safe.status).toBe(0);
    expect(alloc.status).toBe(0);
    const sweep = (line: Record<string, unknown>) => (line["rtSafety"] as Record<string, unknown>)["noteSweep"];
    // the control sweep plays no note: both read clean there
    expect(alloc.line["rtSafety"]).toMatchObject({ allocationsInRun: 0, locksInRun: 0, syscallsInRun: 0 });
    expect(sweep(safe.line)).toMatchObject({ applicable: true, dialect: "midi", interposer: true, allocationsInRun: 0, locksInRun: 0, syscallsInRun: 0, nonFinite: false });
    expect(sweep(alloc.line)).toMatchObject({ applicable: true, dialect: "midi", interposer: true });
    const played = readNoteSweep(sweep(alloc.line))!;
    expect(played.allocationsInRun).toBeGreaterThan(0);
    expect(played.noteEvents).toBeGreaterThan(played.blocks!);
    expect(noteSweepReasons(readNoteSweep(sweep(safe.line)), 1).map((r) => r.rating)).toEqual(["suitable"]);
    expect(noteSweepReasons(played, 1)[0]).toMatchObject({ rating: "conditional", code: HOSTING_CODE.rtSafetyNotesViolations });
  });

  live("an effect has no MIDI input: its note sweep is not applicable", () => {
    const { line } = measure(SAFE, "48000", "64", "1", "1");
    expect((line["rtSafety"] as Record<string, unknown>)["noteSweep"]).toEqual({ applicable: false });
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

  live("a binary named by a percent-encoded IRI is pinned by that word and by the file it decodes to (plugin-hostd#239)", () => {
    const pin = measure("--pin", "urn:plugin-qualify:fixture:lv2-spaced");
    expect(pin.status).toBe(0);
    const files = (pin.line["integrity"] as { files: { path: string; sha256: string }[] }).files;
    expect(files.map((f) => f.path)).toEqual(["gain%20plugin.so", "gain.ttl", "manifest.ttl"]);
    expect(files[0]!.sha256).toBe(createHash("sha256").update(readFileSync(join(LV2_FIXTURES, "spaced.lv2", "gain plugin.so"))).digest("hex"));
  });

  // lilv refuses a relative segment ("attempt to map invalid URI") and left the measurer a null world to
  // dereference: a SIGSEGV, exit 139. A segment is resolved against the working directory.
  live("a relative LV2_PATH segment is resolved against the working directory, never a crash", () => {
    const run = (cwd: string, lv2Path: string, ...args: string[]) => {
      const r = spawnSync(MEASURE, args, { cwd, encoding: "utf8", env: { PATH: process.env["PATH"], LV2_PATH: lv2Path, LD_PRELOAD: INTERPOSER } });
      return { status: r.status, signal: r.signal, stderr: r.stderr, line: JSON.parse(r.stdout || "{}") as Record<string, unknown> };
    };
    // one level up from the fixtures, down by a relative name; and the same as a bare relative directory
    for (const [cwd, lv2Path] of [
      [BUILD, join("fixtures", "lv2")],
      [join(BUILD, "fixtures"), "lv2"],
      [join(BUILD, "fixtures", "lv2"), "."],
      [BUILD, `no-such-dir:${join("fixtures", "lv2")}`],
    ] as const) {
      const r = run(cwd, lv2Path, SAFE, "48000", "64", "1", "1");
      expect(r.signal, `LV2_PATH=${lv2Path} from ${cwd}: ${r.stderr}`).toBeNull();
      expect(r.status, `LV2_PATH=${lv2Path} from ${cwd}: ${r.stderr}`).toBe(0);
      expect(r.line["rtSafety"]).toMatchObject({ allocationsInRun: 0 });
    }
    const pin = run(BUILD, join("fixtures", "lv2"), "--pin", SAFE);
    expect([pin.signal, pin.status]).toEqual([null, 0]);
    expect(pin.line).toMatchObject({ uri: SAFE, found: true });
    // a relative path that holds nothing is simply no plugin: exit 3, as for any plugin it cannot find
    const none = run(BUILD, "no-such-dir", SAFE, "48000", "64", "1", "1");
    expect([none.signal, none.status]).toEqual([null, 3]);
    expect(none.line).toEqual({ uri: SAFE, found: false });
  });

  live("a plugin it cannot find exits 3, said as not found", () => {
    const r = measure("urn:plugin-qualify:not-here");
    expect(r.status).toBe(3);
    expect(r.line).toEqual({ uri: "urn:plugin-qualify:not-here", found: false });
  });

  // the AddressSanitizer build is not in `all`: its own target, which CI builds
  it("leaks nothing on any way out: a measurement, a soak, and a plugin that will not instantiate", (ctx) => {
    if (!BUILT || !existsSync(MEASURE_ASAN)) {
      if (process.env["CI"]) throw new Error("native/build is missing: CI builds it with make -C native deps all asan");
      ctx.skip("native/build is missing: make -C native deps all asan");
    }
    // needs-options refuses to instantiate at rate 0, as it would without the sampleRate option
    const NEEDS_OPTIONS = "urn:plugin-qualify:fixture:needs-options";
    const run = (soak: boolean, ...args: string[]) =>
      spawnSync(MEASURE_ASAN, args, {
        encoding: "utf8",
        env: {
          PATH: process.env["PATH"],
          LV2_PATH: LV2_FIXTURES,
          ASAN_OPTIONS: "detect_leaks=1",
          LSAN_OPTIONS: `suppressions=${LSAN_SUPPRESSIONS}`,
          ...(soak ? { OMX_SOAK_SECONDS: "1" } : {}),
        },
      });
    for (const [soak, args, status] of [
      [false, [SAFE, "48000", "64", "1", "1"], 0],
      [true, [SAFE, "48000", "512"], 0],
      [false, [NEEDS_OPTIONS, "0", "64", "1", "1"], 2],
      [true, [NEEDS_OPTIONS, "0", "64"], 2],
      [false, ["urn:plugin-qualify:not-here", "48000", "64", "1", "1"], 3],
    ] as const) {
      const r = run(soak, ...args);
      expect(r.stderr, `${soak ? "soak " : ""}${args.join(" ")}`).not.toMatch(/LeakSanitizer/);
      expect(r.status).toBe(status);
    }
  });
});
