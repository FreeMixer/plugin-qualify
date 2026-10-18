// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
import { describe, expect, it } from "vitest";

import { costPointKey, gridCostReadings, type CostGridPoint } from "./cost-fields.js";
import { DEFAULT_HOSTING_POLICY, HOSTING_CODE, OPENMIXER_CONSOLE_PROFILE, hostingCostReasons } from "./hosting-suitability.js";

const OK = "probe.ok";
const point = (rate: number, quantum: number, p95: number, median = p95 / 2, p = 95, outcome = OK): CostGridPoint => ({
  rate,
  quantum,
  outcome,
  cost: { median, percentile: { p, value: p95 } },
});

const reasonsAt = (cpuCost: Parameters<typeof hostingCostReasons>[0]["cpuCost"], rate: number, quantum: number | undefined) =>
  hostingCostReasons({ cpuCost }, { rate, ...(quantum === undefined ? {} : { quantum }), profile: OPENMIXER_CONSOLE_PROFILE }, DEFAULT_HOSTING_POLICY);

describe("gridCostReadings", () => {
  it("derives the core fraction from the measured primitive, per rate and quantum", () => {
    const r = gridCostReadings([point(96000, 128, 600), point(96000, 512, 300, 250)], OK);
    expect(Object.keys(r).sort()).toEqual([costPointKey(96000, 128), costPointKey(96000, 512)].sort());
    expect(r["96000/128"]).toEqual({ nsPerSampleMedian: 300, nsPerSampleP95: 600, coreFractionP95: (600 * 96000) / 1e9 });
    expect(r["96000/512"]?.nsPerSampleMedian).toBe(250);
  });

  it("leaves out a point that failed, one with no cost, and one taken at another percentile", () => {
    const r = gridCostReadings(
      [point(96000, 128, 600, 300, 95, "probe.crashed"), { rate: 96000, quantum: 256, outcome: OK }, point(96000, 512, 300, 150, 99)],
      OK,
    );
    expect(r).toEqual({});
  });
});

describe("hostingCostReasons: cost at rate AND quantum", () => {
  const grid = gridCostReadings([point(96000, 128, 600), point(96000, 1024, 300)], OK);

  it("gives two different reasons for two quanta of different cost", () => {
    const small = reasonsAt({ perRateQuantum: grid }, 96000, 128);
    const large = reasonsAt({ perRateQuantum: grid }, 96000, 1024);
    expect(small.map((r) => [r.code, r.rating])).toEqual([[HOSTING_CODE.costAboveCeiling, "unsuitable"]]);
    expect(small[0]?.params).toEqual({ coreFractionP95: (600 * 96000) / 1e9, ceiling: 0.05 });
    expect(large.map((r) => [r.code, r.rating])).toEqual([[HOSTING_CODE.costWithinCeiling, "suitable"]]);
    expect(large[0]?.params).toEqual({ coreFractionP95: (300 * 96000) / 1e9, ceiling: 0.05 });
  });

  it("reads a pair the grid lacks as unmeasured at that rate and quantum, naming both", () => {
    const r = reasonsAt({ perRateQuantum: grid }, 96000, 256);
    expect(r.map((x) => [x.code, x.rating, x.params])).toEqual([[HOSTING_CODE.costUnmeasured, "unknown", { rate: 96000, quantum: 256 }]]);
  });

  it("does not fall back to the per-rate figure when a grid is there, even for a pair it lacks", () => {
    const perRate = { "96000": { coreFractionP95: 0.001, nsPerSampleMedian: 5, nsPerSampleP95: 10 } };
    const r = reasonsAt({ perRate, perRateQuantum: grid }, 96000, 256);
    expect(r[0]?.code).toBe(HOSTING_CODE.costUnmeasured);
  });

  it("reads a grid with no quantum asked as unmeasured, quantum 0", () => {
    const r = reasonsAt({ perRateQuantum: grid }, 96000, undefined);
    expect(r[0]).toMatchObject({ code: HOSTING_CODE.costUnmeasured, params: { rate: 96000, quantum: 0 } });
  });

  it("reads only the per-rate figure for a document of the old format, whatever the quantum", () => {
    const perRate = { "96000": { coreFractionP95: 0.001, nsPerSampleMedian: 5, nsPerSampleP95: 10 } };
    for (const q of [128, 1024, undefined]) {
      expect(reasonsAt({ perRate }, 96000, q)[0]?.code).toBe(HOSTING_CODE.costWithinCeiling);
    }
  });

  it("keeps the spiky tail reason per point", () => {
    const spiky = gridCostReadings([point(96000, 128, 100, 10), point(96000, 1024, 100, 90)], OK);
    expect(reasonsAt({ perRateQuantum: spiky }, 96000, 128).map((r) => r.code)).toContain(HOSTING_CODE.costSpiky);
    expect(reasonsAt({ perRateQuantum: spiky }, 96000, 1024).map((r) => r.code)).not.toContain(HOSTING_CODE.costSpiky);
  });
});
