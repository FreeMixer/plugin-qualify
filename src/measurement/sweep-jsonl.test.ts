// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The hosting sweep's three passes → the format's three hosting dimensions, and those
 * dimensions through the merge: a TRANSLATION with no rule in it, and the same per-plugin,
 * per-DIMENSION precedence `latency` and `cost` obey.
 */
import { describe, expect, it } from "vitest";
import { buildMeasurementDocument, readMeasurementDocument, serialiseMeasurementDocument } from "./format.js";
import { mergeMeasurements } from "./merge.js";
import { buildRun } from "./provenance.js";
import { measuredPluginsFromSweep, parseJsonl } from "./sweep-jsonl.js";

const QUICK = {
  uri: "urn:swept",
  instantiated: true,
  rate: 192000,
  block: 512,
  audioInputs: 1,
  audioOutputs: 1,
  cvPorts: 0,
  controlInputs: 3,
  requiredFeatures: ["http://lv2plug.in/ns/ext/urid#map"],
  optionalFeatures: [],
  lifecycle: { cycles: 30, instantiated: 30, failed: 0 },
  threads: { before: 1, afterFirstInstantiate: 1, afterAllFreed: 1, leaked: 0 },
  rtSafety: {
    interposer: true,
    blocks: 512,
    repeats: 3,
    swept: true,
    sweepApplicable: true,
    allocationsInRun: 0,
    allocationsMin: 0,
    variable: false,
    locksInRun: 0,
    syscallsInRun: 0,
  },
  exit: 0,
};
const DEEP = { ...QUICK, lifecycle: { cycles: 1000, instantiated: 1000, failed: 0 } };
const SOAK = {
  uri: "urn:swept",
  perRate: {
    "96000": { instantiated: true, seconds: 10800, rate: 96000, block: 512, windows: 10828, nonFiniteWindows: 0, silentWindows: 0, firstRmsDbfs: -30, lastRmsDbfs: -31 },
    "192000": { died: true },
  },
};

describe("the sweep's passes become one plugin's three blocks — translated, never judged", () => {
  const [plugin] = measuredPluginsFromSweep({ measurements: [QUICK], lifecycle: [DEEP], soak: [SOAK] });

  it("the deep lifecycle pass supersedes the quick one", () => {
    expect(plugin?.stability?.lifecycle).toEqual({ cycles: 1000, instantiated: 1000, failed: 0 });
  });

  it("the soak lands per rate, raw — a dead rate is written as dead and judged by nobody here", () => {
    expect(plugin?.stability?.soak?.sweptParams).toBe(true);
    expect(plugin?.stability?.soak?.perRate["192000"]).toEqual({ died: true });
    expect(plugin?.stability?.soak?.perRate["96000"]).toMatchObject({ seconds: 10800, blockFrames: 512, lastRmsDbfs: -31 });
  });

  it("the interposer's counts carry the pair they were taken at", () => {
    expect(plugin?.rtSafety).toMatchObject({ rate: 192000, blockFrames: 512, allocationsInRun: 0, swept: true });
  });

  it("the features are the instance's, with its CV-port count", () => {
    expect(plugin?.features).toEqual({ required: ["http://lv2plug.in/ns/ext/urid#map"], optional: [], cvPorts: 0 });
  });

  it("a signal exit is written as the signal; anything else is not a crash this reader can name", () => {
    const [segv] = measuredPluginsFromSweep({ measurements: [{ ...QUICK, crashed: true, exit: 139 }] });
    expect(segv?.stability?.crashes).toEqual([{ signal: "SIGSEGV" }]);
    const [timeout] = measuredPluginsFromSweep({ measurements: [{ ...QUICK, crashed: true, exit: 124 }] });
    expect(timeout?.stability?.crashes).toEqual([]);
  });

  it("a plugin the tool never instantiated has no topology, so no entry — nothing is invented", () => {
    const out = measuredPluginsFromSweep({ measurements: [{ uri: "urn:gone", exit: 139, crashed: true }, QUICK] });
    expect(out.map((p) => p.uri)).toEqual(["urn:swept"]);
  });

  it("parseJsonl keeps object lines and skips a plugin's banner", () => {
    expect(parseJsonl('using block size: 0\n{"uri":"a"}\n\n{"uri":"b"}\n')).toEqual([{ uri: "a" }, { uri: "b" }]);
  });
});

const HOST = { hostname: "ref-desk", realtimePriority: false, memoryLocked: false };

function doc(id: string, plugins: ReturnType<typeof measuredPluginsFromSweep>) {
  return buildMeasurementDocument(
    buildRun({
      id,
      measuredAt: "2026-09-07T04:29:53+02:00",
      dimensions: ["stability", "rtSafety", "features"],
      rates: [96000, 192000],
      tool: { name: "lv2-measure", version: "test" },
      host: HOST,
    }),
    plugins,
  );
}

describe("the hosting dimensions through the format and the merge", () => {
  const swept = measuredPluginsFromSweep({ measurements: [QUICK], lifecycle: [DEEP], soak: [SOAK] });

  it("a v1.1 document round-trips its three blocks through the reader", () => {
    const written = doc("shipped", swept);
    expect(written.formatVersion).toBe("1.2");
    const read = readMeasurementDocument(JSON.parse(serialiseMeasurementDocument(written)));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.document.plugins[0]?.stability).toEqual(swept[0]?.stability);
    expect(read.document.plugins[0]?.rtSafety).toEqual(swept[0]?.rtSafety);
    expect(read.document.plugins[0]?.features).toEqual(swept[0]?.features);
  });

  it("the shipped run resolves each hosting dimension, with its source named", () => {
    const merged = mergeMeasurements(doc("shipped", swept), undefined);
    expect(merged.sourceOf("urn:swept", "stability")).toBe("shipped");
    expect(merged.sourceOf("urn:swept", "rtSafety")).toBe("shipped");
    expect(merged.sourceOf("urn:swept", "features")).toBe("shipped");
    expect(merged.get("urn:swept")?.stability?.rates).toEqual([96000, 192000]);
    expect(merged.summary().bySource.stability).toEqual({ local: 0, shipped: 1 });
  });

  it("a local run replaces a WHOLE dimension and leaves the others shipped", () => {
    const local = measuredPluginsFromSweep({
      measurements: [{ ...QUICK, rtSafety: { ...QUICK.rtSafety, allocationsInRun: 7 } }],
    });
    // The local run covers rt-safety only: the dimensions it never asked stay shipped.
    const onlyRt = local.map(({ stability: _s, features: _f, ...rest }) => rest);
    const merged = mergeMeasurements(doc("shipped", swept), doc("local", onlyRt));
    expect(merged.sourceOf("urn:swept", "rtSafety")).toBe("local");
    expect(merged.get("urn:swept")?.rtSafety?.value.allocationsInRun).toBe(7);
    expect(merged.sourceOf("urn:swept", "stability")).toBe("shipped");
    expect(merged.get("urn:swept")?.stability?.value.lifecycle?.instantiated).toBe(1000);
  });

  it("a local probe that FAILED does not delete the shipped stability figure", () => {
    const failed = [{ uri: "urn:swept", topology: { audioInputs: 1, audioOutputs: 1 }, stability: { unmeasuredReason: "probe-crashed" } }];
    const merged = mergeMeasurements(doc("shipped", swept), doc("local", failed));
    expect(merged.sourceOf("urn:swept", "stability")).toBe("shipped");
    expect(merged.get("urn:swept")?.localProbeFailed).toEqual({ stability: "probe-crashed" });
  });
});
