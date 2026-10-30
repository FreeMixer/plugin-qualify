// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * An LV2 plugin's record carries the latency and the cost a CLAP plugin's does (plugin-qualify#163): the measurer
 * (`native/lv2-measure.c`) is run on fixture plugins whose delay is known by construction, and its line is read through
 * the probe output, the judge and the record, down to `measurements.grid[]`, where zynthian-ui reads
 * `latency.measuredFrames`. On CI a missing build is a failure; elsewhere the live tests skip, saying how to build.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { JALV_PROFILE, OPENMIXER_CONSOLE_PROFILE } from "./host-profiles.js";
import { unmeasuredTerm } from "./measurement/vocabulary.js";
import { judgeProbeOutput } from "./probe-judge.js";
import { readProbeOutput } from "./probe-output.js";
import { probeOutputOfLv2Line, type Lv2MeasureLine } from "./probe-output-fixtures.js";
import { unmeasuredFigures, writeQualification } from "./qualification-record.js";

const BUILD = join(dirname(fileURLToPath(import.meta.url)), "..", "native", "build");
const MEASURE = join(BUILD, "lv2_measure");
const INTERPOSER = join(BUILD, "rt_interpose.so");
const LV2_FIXTURES = join(BUILD, "fixtures", "lv2");
const LATENCY = (kind: string): string => `urn:plugin-qualify:fixture:lv2-latency-${kind}`;
const GAIN = "urn:plugin-qualify:fixture:lv2-rt-safe";
const SYNTH = "urn:plugin-qualify:fixture:lv2-synth";
const BUILT = [MEASURE, INTERPOSER, join(LV2_FIXTURES, "latency.lv2", "latency.so"), join(LV2_FIXTURES, "rt-safe.lv2", "gain.so"), join(LV2_FIXTURES, "synth.lv2", "synth.so")].every((p) => existsSync(p));

const scratch = mkdtempSync(join(tmpdir(), "lv2-latency-cost-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function live(name: string, body: () => void): void {
  it(name, (ctx) => {
    if (!BUILT) {
      if (process.env["CI"]) throw new Error("native/build is missing: CI builds it with make -C native deps all");
      ctx.skip("native/build is missing: make -C native deps all");
    }
    body();
  });
}

function measure(uri: string, rate: number, env: Record<string, string> = {}): Lv2MeasureLine {
  const r = spawnSync(MEASURE, [uri, String(rate), "512", "1", "1"], {
    encoding: "utf8",
    env: { PATH: process.env["PATH"], LV2_PATH: LV2_FIXTURES, LD_PRELOAD: INTERPOSER, ...env },
  });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Lv2MeasureLine;
}

const latencyAt = (line: Lv2MeasureLine, rate: number): Record<string, unknown> => line["latency"][String(rate)];
const RATES = [44100, 48000, 88200, 96000, 176400, 192000];

describe("lv2-measure, live: the latency of fixtures whose delay is known", () => {
  live("a plugin that reports its latency: declared from the port, measured by the impulse, at every rate", () => {
    for (const rate of RATES) {
      // the fixture delays 10 ms and reports the same figure on its lv2:designation lv2:latency port
      const frames = Math.round(rate * 0.01);
      expect(latencyAt(measure(LATENCY("declared"), rate), rate), `${rate} Hz`).toEqual({ declaredFrames: frames, declaredFrom: "port", measuredFrames: frames });
    }
  });

  live("a plugin with no latency port is measured, never read as 0: declared 0 from none, measured by the impulse", () => {
    for (const rate of [44100, 96000]) {
      expect(latencyAt(measure(LATENCY("undeclared"), rate), rate)).toEqual({ declaredFrames: 0, declaredFrom: "none", measuredFrames: 883 });
    }
  });

  live("a plugin that reports the wrong figure (on the older lv2:reportsLatency port) is measured as it is: both are kept", () => {
    expect(latencyAt(measure(LATENCY("misdeclared"), 48000), 48000)).toEqual({ declaredFrames: 128, declaredFrom: "port", measuredFrames: 883 });
  });

  live("a plugin with no delay measures 0, which is a measurement", () => {
    expect(latencyAt(measure(GAIN, 48000), 48000)).toEqual({ declaredFrames: 0, declaredFrom: "none", measuredFrames: 0 });
  });

  live("an instrument is played a note: its onset is measured from the note", () => {
    for (const rate of [44100, 48000, 192000]) {
      // the fixture's sine starts at phase 0, so its first frame is silent and its second is the onset
      expect(latencyAt(measure(SYNTH, rate), rate)).toEqual({ declaredFrames: 0, declaredFrom: "none", measuredFrames: 1, from: "note" });
    }
  });

  live("a plugin whose output stays silent has no measured figure, and says why by a code of the unmeasured vocabulary", () => {
    const at = latencyAt(measure(LATENCY("mute"), 48000), 48000);
    expect(at).not.toHaveProperty("measuredFrames");
    expect(at["declaredFrames"]).toBe(0);
    expect(at["unmeasuredReason"]).toBe("silent-output");
    expect(unmeasuredTerm(at["unmeasuredReason"] as string)).toMatchObject({ code: "silent-output" });
    expect(String(at["unmeasuredDetail"]).length).toBeGreaterThan(0);
  });
});

describe("lv2-measure, live: the cost", () => {
  live("is nanoseconds per sample over the blocks after the warm-up, in the CLAP prober's shape", () => {
    const cost = measure(GAIN, 48000)["cost"];
    expect(cost).toMatchObject({ stimulus: "noise", blockFrames: 512, warmupBlocks: 64, percentile: 95 });
    const at = cost.perRate["48000"];
    expect(at.blocks).toBe(512);
    expect(at.nsPerSampleMedian).toBeGreaterThan(0);
    expect(at.nsPerSampleMin).toBeLessThanOrEqual(at.nsPerSampleMedian);
    expect(at.nsPerSampleMedian).toBeLessThanOrEqual(at.nsPerSampleP95);
    expect(at.nsPerSampleP95).toBeLessThanOrEqual(at.nsPerSampleMax);
  });

  live("an instrument with no probe count holds no note and is not timed, saying so", () => {
    const at = measure(SYNTH, 48000)["cost"].perRate["48000"];
    expect(at).not.toHaveProperty("nsPerSampleMedian");
    expect(at["unmeasuredReason"]).toBe("voices-unknown");
    expect(unmeasuredTerm(at["unmeasuredReason"])).toMatchObject({ code: "voices-unknown" });
  });

  live("an instrument is timed holding the notes it is given, and the cost follows them", () => {
    const one = measure(SYNTH, 48000, { OMX_PROBE_NOTES: "1" })["cost"].perRate["48000"];
    const many = measure(SYNTH, 48000, { OMX_PROBE_NOTES: "32" })["cost"].perRate["48000"];
    expect(one.voices).toEqual({ held: 1, basis: "probe" });
    expect(many.voices).toEqual({ held: 32, basis: "probe" });
    // a sine per held key per sample: thirty-two keys cost several times one
    expect(many.nsPerSampleMedian).toBeGreaterThan(2 * one.nsPerSampleMedian);
  });
});

describe("the record of an LV2 plugin", () => {
  const recordOf = (line: Lv2MeasureLine) => {
    const text = JSON.stringify(probeOutputOfLv2Line(line));
    const read = readProbeOutput(text);
    if (!read.ok) throw new Error(read.problem);
    const judgment = judgeProbeOutput(read.output, [OPENMIXER_CONSOLE_PROFILE, JALV_PROFILE]);
    return writeQualification(join(scratch, String(Math.random()).slice(2)), Buffer.from(text), judgment).record;
  };

  live("holds latency and cost in measurements.grid[], under the field names a CLAP record has", () => {
    const record = recordOf(measure(LATENCY("declared"), 48000));
    expect(record.plugin).toMatchObject({ format: "lv2", id: LATENCY("declared") });
    const point = record.measurements.grid[0]!;
    expect(Object.keys(point).sort()).toEqual(["cost", "latency", "noteSweep", "outcome", "quantum", "rate", "rtSafety"]);
    expect([point.rate, point.quantum]).toEqual([48000, 512]);
    expect(point.latency).toEqual({ declaredFrames: 480, measuredFrames: 480 });
    expect(point.cost).toMatchObject({ blocks: 512, warmupBlocks: 64, percentile: { p: 95 } });
    expect(point.cost!.median).toBeGreaterThan(0);
    expect(record.measurements.unmeasured).toBeUndefined();
  });

  live("a plugin whose latency cannot be measured has no measured figure in its grid: its declared figure, the reason and a named code stand in its place", () => {
    const record = recordOf(measure(LATENCY("mute"), 48000));
    // the plugin loaded, so its declared figure is recorded beside the reason (#201)
    expect(record.measurements.grid[0]!.latency).toEqual({ declaredFrames: 0, unmeasuredReason: "silent-output", code: "hosting.latency.unmeasured" });
    expect(record.measurements.grid[0]!.cost).toBeDefined();
    expect(record.measurements.unmeasured).toEqual([
      { dimension: "latency", rate: 48000, quantum: 512, code: "hosting.latency.unmeasured", detail: expect.stringMatching(/^silent-output: /) },
    ]);
    // the run still ended well: the plugin is judged on what was measured, not turned unknown for a figure it cannot give
    expect(record.probe.outcome).toBe("probe.ok");
    expect(record.verdicts.every((v) => v.measured)).toBe(true);
  });

  live("an instrument's cost carries the notes it held", () => {
    const point = recordOf(measure(SYNTH, 48000, { OMX_PROBE_NOTES: "8" })).measurements.grid[0]!;
    expect(point.latency).toEqual({ declaredFrames: 0, measuredFrames: 1 });
    expect(point.cost!.voices).toEqual({ held: 8, basis: "probe" });
  });

  it("names every figure the run could not take, from the steps that say so", () => {
    const line: Lv2MeasureLine = {
      uri: "urn:example:x",
      rate: 48000,
      block: 512,
      latency: { "48000": { declaredFrames: 0, declaredFrom: "none", unmeasuredReason: "no-audio-in", unmeasuredDetail: "no audio input" } },
      cost: { percentile: 95, warmupBlocks: 64, perRate: { "48000": { unmeasuredReason: "voices-unknown", unmeasuredDetail: "no notes" } } },
      rtSafety: { interposer: false },
    };
    const read = readProbeOutput(JSON.stringify(probeOutputOfLv2Line(line)));
    if (!read.ok) throw new Error(read.problem);
    expect(unmeasuredFigures(read.output)).toEqual([
      { dimension: "latency", rate: 48000, quantum: 512, code: "hosting.latency.unmeasured", detail: "no-audio-in: no audio input" },
      { dimension: "cost", rate: 48000, quantum: 512, code: "hosting.cost.unmeasured-at-rate-and-quantum", detail: "voices-unknown: no notes" },
    ]);
  });
});
