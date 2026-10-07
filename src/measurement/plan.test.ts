// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * "Measure the rates this installation can actually use" — and refuse when nobody has said
 * what those are.
 *
 * The failure this file exists to prevent is the quiet one: a console that only ever runs
 * 44.1 kHz being handed 48 kHz figures because 48 000 is what everybody defaults to. There
 * is no default rate in `plan.ts` and these tests are what keeps it that way.
 */
import { describe, expect, it } from "vitest";

import { fixtureDocument, fixturePlugin } from "./fixtures.js";
import {
  estimateRunSeconds,
  isRunnablePlan,
  measurementPlan,
  planWorkUnits,
  rateCoverage,
  ratesForInstallation,
} from "./plan.js";

describe("resolving the rates to measure", () => {
  it("uses the device's supported list when the operator asks for nothing", () => {
    expect(ratesForInstallation({ liveRate: 96000, supportedRates: [44100, 48000, 96000] })).toEqual({
      rates: [44100, 48000, 96000],
      dropped: [],
    });
  });

  it("always includes the live rate, even when the operator did not ask for it", () => {
    const plan = ratesForInstallation({
      liveRate: 96000,
      supportedRates: [48000, 96000],
      requestedRates: [48000],
    });
    expect(plan.rates).toEqual([48000, 96000]);
  });

  it("DROPS a requested rate the hardware does not offer, and reports it", () => {
    const plan = ratesForInstallation({
      liveRate: 48000,
      supportedRates: [44100, 48000],
      requestedRates: [48000, 192000],
    });
    expect(plan.rates).toEqual([48000]);
    expect(plan.dropped).toEqual([192000]);
  });

  it("trusts a live rate the probe never listed — the device is contradicting the list", () => {
    const plan = ratesForInstallation({ liveRate: 88200, supportedRates: [48000] });
    expect(plan.rates).toEqual([48000, 88200]);
  });

  it("REFUSES when nothing is known, rather than picking a common number", () => {
    const plan = ratesForInstallation({});
    expect(plan.rates).toEqual([]);
    expect(plan.problem).toBe("no-rates-known");
  });

  it("refuses when every requested rate is unusable here", () => {
    const plan = ratesForInstallation({ supportedRates: [44100], requestedRates: [192000] });
    expect(plan).toEqual({ rates: [], dropped: [192000], problem: "no-rates-known" });
  });
});

describe("the plan", () => {
  const rates = ratesForInstallation({ liveRate: 96000, supportedRates: [48000, 96000] });

  it("carries the dropped rates through so a UI can explain the shortfall", () => {
    const dropped = ratesForInstallation({ supportedRates: [48000], requestedRates: [48000, 192000] });
    expect(measurementPlan(dropped, ["latency"]).droppedRates).toEqual([192000]);
  });

  it("is not runnable with no dimensions", () => {
    const plan = measurementPlan(rates, []);
    expect(plan.problem).toBe("no-dimensions");
    expect(isRunnablePlan(plan)).toBe(false);
  });

  it("is not runnable with no rates", () => {
    const plan = measurementPlan(ratesForInstallation({}), ["cost"]);
    expect(isRunnablePlan(plan)).toBe(false);
  });

  it("is runnable with both, and counts its work", () => {
    const plan = measurementPlan(rates, ["latency", "cost"], 958);
    expect(isRunnablePlan(plan)).toBe(true);
    expect(planWorkUnits(plan)).toBe(958 * 2 * 2);
  });

  it("has unknown work until a scan has counted the plugins", () => {
    expect(planWorkUnits(measurementPlan(rates, ["cost"]))).toBeUndefined();
  });

  it("ignores a dimension name it does not know", () => {
    const plan = measurementPlan(rates, ["latency"]);
    expect(plan.dimensions).toEqual(["latency"]);
  });
});

describe("estimating how long a run takes", () => {
  const rates = ratesForInstallation({ supportedRates: [48000, 96000] });
  const plan = measurementPlan(rates, ["latency", "cost"], 100);

  it("scales a reference run's MEASURED duration by the work asked for", () => {
    // Reference: 1 plugin x 2 rates x 2 dimensions took 4 s. The plan is 100x the plugins.
    const reference = fixtureDocument([fixturePlugin("urn:a")], { elapsedSeconds: 4 });
    const estimate = estimateRunSeconds(plan, reference);
    expect(estimate?.seconds).toBe(400);
    expect(estimate?.basis).toMatchObject({ host: "ref-desk", seconds: 4 });
  });

  it("returns UNKNOWN with no reference run — there is no constant to fall back on", () => {
    expect(estimateRunSeconds(plan, undefined)).toBeUndefined();
  });

  it("returns UNKNOWN when the reference never recorded its own duration", () => {
    const reference = fixtureDocument([fixturePlugin("urn:a")], { elapsedSeconds: undefined });
    expect(estimateRunSeconds(plan, reference)).toBeUndefined();
  });

  it("returns UNKNOWN when the plan does not know its plugin count", () => {
    const reference = fixtureDocument([fixturePlugin("urn:a")], { elapsedSeconds: 4 });
    expect(estimateRunSeconds(measurementPlan(rates, ["cost"]), reference)).toBeUndefined();
  });

  it("names the host it extrapolated from, so the operator can judge the guess", () => {
    const reference = fixtureDocument([fixturePlugin("urn:a")], { elapsedSeconds: 4 });
    expect(estimateRunSeconds(plan, reference)?.basis.host).toBe("ref-desk");
  });
});

describe("rate coverage after a rate change", () => {
  it("reports the rate the rig moved to as MISSING, not interpolated", () => {
    const run = fixtureDocument([], { rates: [48000] }).run;
    expect(rateCoverage(run, [48000, 96000])).toEqual({
      covered: [48000],
      missing: [96000],
      extra: [],
    });
  });

  it("reports rates measured but no longer used", () => {
    const run = fixtureDocument([], { rates: [44100, 48000, 192000] }).run;
    expect(rateCoverage(run, [48000])).toEqual({ covered: [48000], missing: [], extra: [44100, 192000] });
  });

  it("treats an absent run as covering nothing", () => {
    expect(rateCoverage(undefined, [48000])).toEqual({ covered: [], missing: [48000], extra: [] });
  });
});
