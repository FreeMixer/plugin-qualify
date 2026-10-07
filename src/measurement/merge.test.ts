// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The precedence rule of issue #342, defended case by case.
 *
 * "Local measurements win" is one sentence with four edges, and every one of them is a way
 * for an installation to end up with figures that are worse than the ones it shipped with:
 *
 * - a PARTIAL local run must override only what it covered;
 * - a local run that CRASHED on a plugin must not delete the shipped figure for it;
 * - a local run that found nothing to measure MUST override, because that is a plugin fact;
 * - a local run covering fewer rates must leave the uncovered rates MISSING, not backfilled
 *   from another machine's measurement wearing a local label.
 */
import { describe, expect, it } from "vitest";

import { fixtureDocument, fixturePlugin, fixtureProbeFailure, fixtureUnmeasurable } from "./fixtures.js";
import { mergeMeasurements } from "./merge.js";

const COMP = "http://lsp-plug.in/plugins/lv2/compressor_mono";
const EQ = "http://lsp-plug.in/plugins/lv2/para_equalizer_x16_stereo";
const METER = "urn:x42:meter";

const shipped = fixtureDocument([fixturePlugin(COMP), fixturePlugin(EQ), fixturePlugin(METER)], {
  id: "shipped-ref",
  host: {
    hostname: "ref-desk",
    realtimePriority: false,
    memoryLocked: false,
  },
});

/** A local run on a slower box: the compressor measured, everything else untouched. */
function localRun(plugins: Parameters<typeof fixtureDocument>[0]) {
  return fixtureDocument(plugins, {
    id: "local-nuc",
    measuredAt: "2026-08-01T10:00:00+02:00",
    host: { hostname: "nuc", realtimePriority: false, memoryLocked: false },
  });
}

describe("with no local run at all", () => {
  it("is entirely shipped, and says so", () => {
    const merged = mergeMeasurements(shipped, undefined);
    expect(merged.size).toBe(3);
    expect(merged.sourceOf(COMP, "latency")).toBe("shipped");
    expect(merged.sourceOf(COMP, "cost")).toBe("shipped");
    expect(merged.summary().bySource.cost).toEqual({ local: 0, shipped: 3 });
  });

  it("resolves nothing when there is no shipped catalogue either", () => {
    const merged = mergeMeasurements(undefined, undefined);
    expect(merged.size).toBe(0);
    expect(merged.summary().plugins).toBe(0);
  });
});

describe("a partial local run", () => {
  const merged = mergeMeasurements(shipped, localRun([fixturePlugin(COMP)]));

  it("overrides the plugins it covered", () => {
    expect(merged.sourceOf(COMP, "latency")).toBe("local");
    expect(merged.sourceOf(COMP, "cost")).toBe("local");
    expect(merged.get(COMP)?.cost?.host).toBe("nuc");
  });

  it("leaves the rest on the shipped defaults", () => {
    expect(merged.sourceOf(EQ, "cost")).toBe("shipped");
    expect(merged.sourceOf(METER, "cost")).toBe("shipped");
    expect(merged.get(EQ)?.cost?.host).toBe("ref-desk");
  });

  it("counts both sides so a Setup screen can render the split", () => {
    expect(merged.summary().bySource.cost).toEqual({ local: 1, shipped: 2 });
    expect(merged.summary().bySource.latency).toEqual({ local: 1, shipped: 2 });
    // Neither document covers a hosting dimension, so all three plugins are unresolved there —
    // counted, not hidden, and not confused with the two dimensions both runs measured.
    expect(merged.summary().unresolved).toEqual({ latency: 0, cost: 0, stability: 3, rtSafety: 3, features: 3 });
  });
});

describe("a local probe that FAILED", () => {
  const merged = mergeMeasurements(shipped, localRun([fixtureProbeFailure(METER)]));

  it("keeps the shipped figure — a crash here says nothing about the plugin", () => {
    expect(merged.sourceOf(METER, "cost")).toBe("shipped");
    expect(merged.get(METER)?.cost?.value.perRate["96000"]).toBeDefined();
  });

  it("still reports that this machine could not reproduce it", () => {
    expect(merged.get(METER)?.localProbeFailed).toEqual({
      latency: "probe-crashed",
      cost: "probe-crashed",
    });
    expect(merged.summary().localProbeFailures).toEqual({
      latency: 1,
      cost: 1,
      stability: 0,
      rtSafety: 0,
      features: 0,
    });
  });
});

describe("a local run that found NOTHING TO MEASURE", () => {
  const merged = mergeMeasurements(shipped, localRun([fixtureUnmeasurable(METER, "no-audio-out")]));

  it("overrides, because a missing audio port is a property of the plugin", () => {
    expect(merged.sourceOf(METER, "cost")).toBe("local");
    expect(merged.get(METER)?.cost?.value.perRate).toEqual({});
    expect(merged.get(METER)?.cost?.value.unmeasuredReason).toBe("no-audio-out");
  });

  it("is not counted as a local probe failure", () => {
    expect(merged.get(METER)?.localProbeFailed).toBeUndefined();
  });
});

describe("an unrecognised local reason", () => {
  it("does NOT override — a word we cannot interpret must not delete a measurement", () => {
    const merged = mergeMeasurements(
      shipped,
      localRun([fixtureUnmeasurable(METER, "reason-from-someone-elses-prober")]),
    );
    expect(merged.sourceOf(METER, "cost")).toBe("shipped");
    expect(merged.get(METER)?.localProbeFailed?.cost).toBe("reason-from-someone-elses-prober");
  });
});

describe("rate coverage", () => {
  const narrow = fixturePlugin(COMP, {
    cost: {
      perRate: {
        "48000": { nsPerSampleMedian: 9, nsPerSamplePercentile: 11, blocks: 512, blockFrames: 512 },
      },
    },
  });
  const merged = mergeMeasurements(shipped, localRun([narrow]));

  it("reports the rates the winning figure does not cover", () => {
    expect(merged.sourceOf(COMP, "cost")).toBe("local");
    expect(merged.missingRates(COMP, "cost", [48000, 96000])).toEqual([96000]);
  });

  it("does NOT backfill the uncovered rate from the shipped run", () => {
    // The whole reason the merge is per dimension: a 48 kHz figure from the NUC beside a
    // 96 kHz figure from the reference laptop would make the rate ratio an artefact of the
    // hardware difference, and the rate ratio is what per-rate data exists to express.
    const resolved = merged.get(COMP)?.cost;
    expect(Object.keys(resolved?.value.perRate ?? {})).toEqual(["48000"]);
    expect(resolved?.host).toBe("nuc");
  });

  it("lists the plugins a new rate is missing from", () => {
    expect(merged.pluginsMissingRates("cost", [48000, 96000])).toEqual([COMP]);
    expect(merged.pluginsMissingRates("cost", [48000])).toEqual([]);
  });

  it("does not call a plugin with nothing to measure 'missing a rate'", () => {
    const withReason = mergeMeasurements(shipped, localRun([fixtureUnmeasurable(METER, "no-audio-out")]));
    expect(withReason.pluginsMissingRates("cost", [48000, 96000])).not.toContain(METER);
  });
});

describe("a plugin installed here but absent from the shipped catalogue", () => {
  const merged = mergeMeasurements(shipped, localRun([fixturePlugin("urn:local:only")]));

  it("is measured rather than ignored, and flagged as local-only", () => {
    expect(merged.get("urn:local:only")?.localOnly).toBe(true);
    expect(merged.sourceOf("urn:local:only", "cost")).toBe("local");
    expect(merged.summary().localOnly).toBe(1);
  });
});

describe("naming the source of a figure", () => {
  const merged = mergeMeasurements(shipped, localRun([fixturePlugin(COMP)]));

  it("carries the run id, host and date so a UI never has to guess", () => {
    expect(merged.get(COMP)?.cost).toMatchObject({
      source: "local",
      runId: "local-nuc",
      host: "nuc",
      measuredAt: "2026-08-01T10:00:00+02:00",
    });
    expect(merged.runFor("shipped")?.host.hostname).toBe("ref-desk");
    expect(merged.runFor("local")?.host.hostname).toBe("nuc");
  });

  it("lists the URIs behind each source", () => {
    expect(merged.urisFrom("local", "cost")).toEqual([COMP]);
    expect(merged.urisFrom("shipped", "cost").sort()).toEqual([EQ, METER].sort());
  });
});
