// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Documents the tests build on.
 *
 * Kept in `src/` rather than a test file so every test in this directory shares ONE idea of
 * what a well-formed document looks like — a fixture copied between test files is how two
 * tests end up asserting against two different formats, both of which pass.
 */

import type { MeasuredPlugin, MeasurementDocument, MeasurementHost, MeasurementRun } from "./format.js";
import { buildMeasurementDocument } from "./format.js";
import type { MeasurementDimension } from "./vocabulary.js";

/** A host with every optional field populated — the maximal shape a round trip must survive. */
export const FIXTURE_HOST: MeasurementHost = {
  hostname: "ref-desk",
  kernel: "7.1.5-200.fc44.x86_64",
  os: "Linux",
  cpuModel: "Intel(R) Core(TM) Ultra 9 275HX",
  cpuCount: 24,
  pinnedCpu: 7,
  pinnedCpuKind: "performance",
  pinnedCpuMaxKHz: 5300000,
  governor: "performance",
  turboEnabled: true,
  realtimePriority: false,
  memoryLocked: false,
  toolchain: { python: "3.14.6" },
};

/** A run record with both method blocks present. */
export function fixtureRun(overrides: Partial<MeasurementRun> = {}): MeasurementRun {
  return {
    id: "run-ref-2026-07-28",
    measuredAt: "2026-07-28T18:03:03+02:00",
    dimensions: ["latency", "cost"],
    rates: [48000, 96000],
    tool: { name: "lv2-measure", version: "0.1.0" },
    host: FIXTURE_HOST,
    method: {
      latency: {
        method: "impulse-onset",
        blockFrames: 512,
        stimulus: "unit impulse, escalating to a sustained tone",
        paramSweep: true,
      },
      cost: {
        method: "block-time-percentile",
        blockFrames: 512,
        warmupBlocks: 64,
        minTimedBlocks: 64,
        maxTimedBlocks: 512,
        targetSecondsPerPlugin: 0.25,
        percentile: 95,
        stimulus: "sustained 1000 Hz sine at 0.5 full-scale on every audio input",
        controls: "lv2:default on every control input",
        timingFloorNsPerBlock: 32.5,
      },
    },
    elapsedSeconds: 900,
    label: "reference sweep",
    relativeRankingOnly: true,
    note: "A RELATIVE ranking measured on one machine, not a guarantee on any other.",
    ...overrides,
  };
}

/** A fully measured plugin: readings at both rates, on both dimensions. */
export function fixturePlugin(uri: string, overrides: Partial<MeasuredPlugin> = {}): MeasuredPlugin {
  return {
    uri,
    name: "LSP Compressor Mono",
    version: "1.22",
    bundle: "/usr/lib64/lv2/lsp-plugins.lv2/",
    lv2Class: "Compressor Plugin",
    topology: { audioInputs: 2, audioOutputs: 1, midiInputs: 0, controlInputs: 40 },
    latency: {
      perRate: {
        "48000": { frames: 0, ms: 0 },
        "96000": { frames: 0, ms: 0 },
      },
      scalingClass: "zero",
      declaredPortSymbol: "out_latency",
      declaredFrames: 0,
    },
    cost: {
      perRate: {
        "48000": {
          nsPerSampleMedian: 6.9,
          nsPerSamplePercentile: 7.2,
          nsPerSampleMin: 6.4,
          nsPerSampleMax: 41.1,
          blocks: 512,
          blockFrames: 512,
          warmupNsPerSampleMedian: 12.3,
        },
        "96000": {
          nsPerSampleMedian: 6.95,
          nsPerSamplePercentile: 7.4,
          blocks: 512,
          blockFrames: 512,
        },
      },
    },
    ...overrides,
  };
}

/** A plugin with nothing to measure — an analyser, no audio output. */
export function fixtureUnmeasurable(uri: string, code = "no-audio-out"): MeasuredPlugin {
  return {
    uri,
    name: "x42 Phase Wheel",
    topology: { audioInputs: 2, audioOutputs: 0 },
    latency: { perRate: {}, unmeasuredReason: code },
    cost: { perRate: {}, unmeasuredReason: code },
  };
}

/** A plugin this run crashed on — a fact about the run, not the plugin. */
export function fixtureProbeFailure(uri: string): MeasuredPlugin {
  return {
    uri,
    name: "x42 Meter",
    topology: { audioInputs: 2, audioOutputs: 2 },
    latency: { perRate: {}, unmeasuredReason: "probe-crashed", unmeasuredDetail: "worker crashed (SIGABRT)" },
    cost: { perRate: {}, unmeasuredReason: "probe-crashed", unmeasuredDetail: "worker crashed (SIGABRT)" },
  };
}

/** A complete document. */
export function fixtureDocument(
  plugins: readonly MeasuredPlugin[] = [fixturePlugin("http://lsp-plug.in/plugins/lv2/compressor_mono")],
  run: Partial<MeasurementRun> = {},
): MeasurementDocument {
  return buildMeasurementDocument(fixtureRun(run), plugins);
}

/** Both dimensions, for tests that need the list without importing the vocabulary. */
export const BOTH_DIMENSIONS: readonly MeasurementDimension[] = ["latency", "cost"];
