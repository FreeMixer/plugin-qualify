// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The prober's free text becoming a controlled vocabulary — the part that decides whether anyone else's measurements can ever be merged with ours.
 *
 * The direction of the mapping matters more than its coverage: an unrecognised failure must
 * land on `probe-error` (a run property) and never on a structural reason, because a
 * structural reason overrides other people's figures.
 */
import { describe, expect, it } from "vitest";

import { measuredPluginFromProbeEntry, measuredPluginsFromProbeOutput, probeReasonCode } from "./probe-json.js";
import { unmeasuredKind } from "./vocabulary.js";

const BOTH = ["latency", "cost"] as const;

describe("mapping the prober's words", () => {
  it("passes the structural reasons through unchanged", () => {
    expect(probeReasonCode("probe error: hosting.worker.nonconforming: LV2_Worker_Interface.work is NULL")).toBe("worker-nonconforming");
    expect(probeReasonCode("cost error: hosting.worker.nonconforming: LV2_Worker_Interface.work_response is NULL")).toBe("worker-nonconforming");
    expect(probeReasonCode("no-audio-in")).toBe("no-audio-in");
    expect(probeReasonCode("no-audio-out")).toBe("no-audio-out");
    expect(probeReasonCode("silent-output")).toBe("silent-output");
  });

  it("classifies the run failures the batch loop actually emits", () => {
    expect(probeReasonCode("worker crashed (broken pipe)")).toBe("probe-crashed");
    expect(probeReasonCode("worker desync")).toBe("probe-crashed");
    expect(probeReasonCode("worker unavailable")).toBe("probe-crashed");
    expect(probeReasonCode("probe timed out")).toBe("probe-timeout");
    expect(probeReasonCode("non-finite output")).toBe("non-finite-output");
    expect(probeReasonCode("not installed")).toBe("not-installed");
  });

  it("sends anything unrecognised to probe-error, NOT to a structural reason", () => {
    expect(probeReasonCode("no steady-state blocks")).toBe("probe-error");
    expect(probeReasonCode("cost error: ValueError")).toBe("probe-error");
    expect(unmeasuredKind(probeReasonCode("something nobody predicted"))).toBe("probe-failed");
  });

  it("keeps the prober's own sentence next to the coarser code", () => {
    const plugin = measuredPluginFromProbeEntry(
      { uri: "urn:a", audioInputs: 2, audioOutputs: 2, cpuCost: { failed: "worker crashed (SIGABRT)" } },
      BOTH,
    );
    expect(plugin?.cost?.unmeasuredReason).toBe("probe-crashed");
    expect(plugin?.cost?.unmeasuredDetail).toBe("worker crashed (SIGABRT)");
  });

  it("does not repeat the code as its own detail", () => {
    const plugin = measuredPluginFromProbeEntry(
      { uri: "urn:a", audioInputs: 0, audioOutputs: 2, cpuCost: { unmeasurable: "no-audio-in" } },
      BOTH,
    );
    expect(plugin?.cost?.unmeasuredReason).toBe("no-audio-in");
    expect(plugin?.cost?.unmeasuredDetail).toBeUndefined();
  });
});

describe("converting a prober descriptor", () => {
  const entry = {
    uri: "http://lsp-plug.in/plugins/lv2/comp",
    name: "LSP Compressor",
    lv2Class: "Compressor Plugin",
    bundlePath: "/usr/lib64/lv2/lsp.lv2/",
    audioInputs: 2,
    audioOutputs: 1,
    hasMidiIn: false,
    params: [{ kind: "control" }, { kind: "control" }, { kind: "patch" }],
    latency: {
      portSymbol: "out_latency",
      reportedFrames: 0,
      declaredMismatch: true,
      scalingClass: "fixed-frame",
      stimulus: "sustained",
      perRate: { "48000": { frames: 480, ms: 10 }, "96000": { frames: 0, ms: 0 } },
      unreliableRates: [{ rate: 96000, frames: 0, reason: "impossible-zero" }],
    },
    cpuCost: {
      perRate: {
        "48000": {
          nsPerSampleMedian: 6.9,
          nsPerSampleP95: 7.2,
          nsPerSampleMin: 6.4,
          nsPerSampleMax: 41.1,
          coreFractionMedian: 0.00033,
          coreFractionP95: 0.00035,
          instancesPerCoreP95: 2896,
          blocks: 512,
          warmupBlocks: 64,
          blockFrames: 512,
          warmupNsPerSampleMedian: 12.0,
        },
      },
    },
  };

  const plugin = measuredPluginFromProbeEntry(entry, BOTH);

  it("carries identity, topology and bundle", () => {
    expect(plugin).toMatchObject({
      uri: entry.uri,
      name: "LSP Compressor",
      bundle: "/usr/lib64/lv2/lsp.lv2/",
      lv2Class: "Compressor Plugin",
      topology: { audioInputs: 2, audioOutputs: 1, midiInputs: 0, controlInputs: 2 },
    });
  });

  it("moves an excluded reading's reason ONTO the reading it disqualifies", () => {
    expect(plugin?.latency?.perRate["96000"]?.excludedReason).toBe("impossible-zero");
    expect(plugin?.latency?.perRate["48000"]?.excludedReason).toBeUndefined();
  });

  it("keeps the declared figure next to the measurement, never instead of it", () => {
    expect(plugin?.latency?.declaredPortSymbol).toBe("out_latency");
    expect(plugin?.latency?.declaredFrames).toBe(0);
    expect(plugin?.latency?.declaredMismatch).toBe(true);
    expect(plugin?.latency?.perRate["48000"]?.frames).toBe(480);
  });

  it("drops the DERIVED cost figures and keeps the measured primitive", () => {
    const reading = plugin?.cost?.perRate["48000"];
    expect(reading?.nsPerSampleMedian).toBe(6.9);
    expect(reading?.nsPerSamplePercentile).toBe(7.2);
    expect(reading).not.toHaveProperty("coreFractionP95");
    expect(reading).not.toHaveProperty("instancesPerCoreP95");
  });

  it("never carries both a figure and a reason", () => {
    expect(plugin?.latency?.unmeasuredReason).toBeUndefined();
    expect(plugin?.cost?.unmeasuredReason).toBeUndefined();
  });

  it("omits a dimension the run did not cover, rather than calling it unmeasurable", () => {
    const latencyOnly = measuredPluginFromProbeEntry(entry, ["latency"]);
    expect(latencyOnly?.cost).toBeUndefined();
    expect(latencyOnly?.latency).toBeDefined();
  });

  it("rejects an entry with no URI or no port counts", () => {
    expect(measuredPluginFromProbeEntry({ audioInputs: 2, audioOutputs: 2 }, BOTH)).toBeUndefined();
    expect(measuredPluginFromProbeEntry({ uri: "urn:a" }, BOTH)).toBeUndefined();
  });

  it("reads a whole prober array, skipping what it cannot read", () => {
    expect(measuredPluginsFromProbeOutput([entry, { uri: "urn:broken" }, null], BOTH)).toHaveLength(1);
    expect(measuredPluginsFromProbeOutput("not an array", BOTH)).toEqual([]);
  });
});

describe("the worker refusal's code is one string in both languages", () => {
  it("tools/benchmark.py WORKER_NONCONFORMING is HOSTING_CODE.workerNonconforming", async () => {
    const { readFileSync } = await import("node:fs");
    const { HOSTING_CODE } = await import("../hosting-codes.js");
    const py = readFileSync(new URL("../../tools/benchmark.py", import.meta.url), "utf8");
    expect(/^WORKER_NONCONFORMING = "([^"]+)"/m.exec(py)?.[1]).toBe(HOSTING_CODE.workerNonconforming);
  });
});

describe("an instrument's cost, timed with notes held (format 1.4)", () => {
  const timed = { nsPerSampleMedian: 40, nsPerSampleP95: 44, blocks: 512, blockFrames: 512 };

  it("carries the notes held, per rate, beside the figure", () => {
    const plugin = measuredPluginFromProbeEntry(
      { uri: "urn:synth", audioInputs: 0, audioOutputs: 2, hasMidiIn: true,
        cpuCost: { perRate: { "96000": { ...timed, voices: { held: 32, basis: "probe" } } } } },
      BOTH,
    );
    expect(plugin?.cost?.perRate["96000"]?.voices).toEqual({ held: 32, basis: "probe" });
    expect(plugin?.cost?.perRate["96000"]?.nsPerSamplePercentile).toBe(44);
  });

  it("drops a held count it cannot vouch for, and keeps an effect's figure without one", () => {
    const read = (voices: unknown) =>
      measuredPluginFromProbeEntry({ uri: "urn:x", audioInputs: 0, audioOutputs: 2, cpuCost: { perRate: { "48000": { ...timed, voices } } } }, BOTH)
        ?.cost?.perRate["48000"]?.voices;
    expect(read({ held: 32, basis: "guess" })).toBeUndefined();
    expect(read({ held: 0, basis: "probe" })).toBeUndefined();
    expect(read({ held: 2.5, basis: "probe" })).toBeUndefined();
    expect(read(undefined)).toBeUndefined();
    expect(read({ held: 8, basis: "declared", capacity: 8 })).toEqual({ held: 8, basis: "declared", capacity: 8 });
  });

  it("an instrument measured with no count to hold is not attempted, never a plugin with nothing to measure", () => {
    const plugin = measuredPluginFromProbeEntry(
      { uri: "urn:synth", audioInputs: 0, audioOutputs: 2, cpuCost: { unmeasurable: "voices-unknown" } },
      BOTH,
    );
    expect(plugin?.cost?.unmeasuredReason).toBe("voices-unknown");
    expect(unmeasuredKind("voices-unknown")).toBe("not-attempted");
  });
});

