// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * `lv2-measure`'s decisions, tested without running a single plugin.
 *
 * The pass ORDER is the one thing here that cannot be checked by reading the output: a
 * measured-latency pass run before the declared one still produces a plausible file, with a
 * mis-sized capture window and every `declaredMismatch` wrong. So the pipeline is asserted
 * as a sequence, not as a set.
 */
import { describe, expect, it } from "vitest";

import {
  advanceProgress,
  assembleDocument,
  buildPipeline,
  INITIAL_PROGRESS,
  parseMeasureArgs,
  parseProbeProgress,
  TOOL_NAME,
  type MeasureOptions,
} from "./cli.js";
import { FIXTURE_HOST } from "./fixtures.js";

const DEFAULTS = { toolDir: "/opt/lv2-measure/tools", workDir: "/tmp/run" };

function options(overrides: Partial<MeasureOptions> = {}): MeasureOptions {
  return {
    rates: [48000, 96000],
    dimensions: ["latency", "cost"],
    workDir: "/tmp/run",
    sweep: false,
    toolDir: "/opt/tools",
    python: "python3",
    run: true,
    dryRun: false,
    ...overrides,
  };
}

describe("argument parsing", () => {
  it("REQUIRES rates — a measurement with no stated rate is not a measurement", () => {
    const result = parseMeasureArgs([], {}, DEFAULTS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("--rates");
  });

  it("parses, de-duplicates and sorts the rate list", () => {
    const result = parseMeasureArgs(["--rates", "96000,48000,96000"], {}, DEFAULTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.options.rates).toEqual([48000, 96000]);
  });

  it("defaults to both dimensions and accepts a narrower choice", () => {
    const both = parseMeasureArgs(["--rates", "48000"], {}, DEFAULTS);
    expect(both.ok && both.options.dimensions).toEqual(["latency", "cost"]);
    const one = parseMeasureArgs(["--rates", "48000", "--dimensions", "cost"], {}, DEFAULTS);
    expect(one.ok && one.options.dimensions).toEqual(["cost"]);
  });

  it("rejects a dimension it does not know rather than silently ignoring it", () => {
    const result = parseMeasureArgs(["--rates", "48000", "--dimensions", "cost,vibes"], {}, DEFAULTS);
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown flag", () => {
    expect(parseMeasureArgs(["--rates", "48000", "--turbo"], {}, DEFAULTS).ok).toBe(false);
  });

  it("gates probing behind --run or LV2_MEASURE_RUN=1", () => {
    const bare = parseMeasureArgs(["--rates", "48000"], {}, DEFAULTS);
    expect(bare.ok && bare.options.run).toBe(false);
    const flagged = parseMeasureArgs(["--rates", "48000", "--run"], {}, DEFAULTS);
    expect(flagged.ok && flagged.options.run).toBe(true);
    const env = parseMeasureArgs(["--rates", "48000"], { LV2_MEASURE_RUN: "1" }, DEFAULTS);
    expect(env.ok && env.options.run).toBe(true);
  });

  it("carries the operator's label into the run", () => {
    const result = parseMeasureArgs(["--rates", "48000", "--label", "after LSP 1.2.22"], {}, DEFAULTS);
    expect(result.ok && result.options.label).toBe("after LSP 1.2.22");
  });
});

describe("the probe pipeline", () => {
  it("runs the declared-latency pass BEFORE the measured one", () => {
    const pipeline = buildPipeline(options());
    expect(pipeline.steps.map((s) => s.id)).toEqual(["scan", "latency-declared", "latency-measured", "cost"]);
  });

  it("feeds each pass the file the previous one wrote", () => {
    const pipeline = buildPipeline(options());
    for (let i = 1; i < pipeline.steps.length; i += 1) {
      const previous = pipeline.steps[i - 1];
      const step = pipeline.steps[i];
      expect(step?.args).toContain(previous?.produces);
    }
    expect(pipeline.finalCatalog).toBe(pipeline.steps.at(-1)?.produces);
  });

  it("skips the scan when an existing one is supplied", () => {
    const pipeline = buildPipeline(options({ scanPath: "/data/scan.json" }));
    expect(pipeline.steps.map((s) => s.id)).toEqual(["latency-declared", "latency-measured", "cost"]);
    expect(pipeline.steps[0]?.args).toContain("/data/scan.json");
  });

  it("omits the cost pass — and its provenance file — when cost was not asked for", () => {
    const pipeline = buildPipeline(options({ dimensions: ["latency"] }));
    expect(pipeline.steps.map((s) => s.id)).not.toContain("cost");
    expect(pipeline.costProvenance).toBeUndefined();
  });

  it("always asks the cost pass to write its provenance", () => {
    const pipeline = buildPipeline(options({ dimensions: ["cost"] }));
    const cost = pipeline.steps.find((s) => s.id === "cost");
    expect(cost?.args).toContain("--cost-provenance");
    expect(pipeline.costProvenance).toBeDefined();
  });

  it("passes every rate to every measuring pass", () => {
    const pipeline = buildPipeline(options({ rates: [44100, 48000] }));
    for (const step of pipeline.steps.filter((s) => s.dimension !== undefined && s.id !== "latency-declared")) {
      expect(step.args).toContain("44100,48000");
    }
  });

  it("passes --sweep only when asked", () => {
    expect(buildPipeline(options()).steps.some((s) => s.args.includes("--sweep"))).toBe(false);
    expect(buildPipeline(options({ sweep: true })).steps.some((s) => s.args.includes("--sweep"))).toBe(true);
  });

  it("pins the cost pass to a core when one is chosen", () => {
    const pipeline = buildPipeline(options({ costCpu: 7 }));
    const cost = pipeline.steps.find((s) => s.id === "cost");
    expect(cost?.args).toEqual(expect.arrayContaining(["--cost-cpu", "7"]));
  });

  it("gates every prober invocation behind the prober's own --run", () => {
    for (const step of buildPipeline(options()).steps.filter((s) => s.dimension !== undefined)) {
      expect(step.args).toContain("--run");
    }
  });
});

describe("progress parsing", () => {
  it("recognises the phase banner and its plugin count", () => {
    expect(parseProbeProgress("== measuring 958 plugin(s) at 96000 Hz (block 512)")).toEqual({
      kind: "phase",
      plugins: 958,
      rate: 96000,
    });
    expect(parseProbeProgress("== CPU cost of 958 plugin(s) at 48000 Hz")).toEqual({
      kind: "phase",
      plugins: 958,
      rate: 48000,
    });
  });

  it("counts a plugin result whether it succeeded or failed", () => {
    expect(parseProbeProgress("  urn:a: 64 frames (1.333 ms @ 48000 Hz)")).toEqual({ kind: "plugin" });
    expect(parseProbeProgress("  probe timed out: urn:b")).toEqual({ kind: "plugin" });
    expect(parseProbeProgress("  worker crashed on urn:c: broken pipe")).toEqual({ kind: "plugin" });
  });

  it("does NOT count the diagnostics that are not per-plugin", () => {
    expect(parseProbeProgress("  could not pin to cpu 7: EPERM")).toBeUndefined();
    expect(parseProbeProgress("  worker spawn failed: no python")).toBeUndefined();
  });

  it("advances nothing on a line it does not recognise", () => {
    expect(parseProbeProgress("something else entirely")).toBeUndefined();
    expect(parseProbeProgress("")).toBeUndefined();
  });

  it("never reports more plugins done than the phase declared", () => {
    // The prober's own per-phase summary lines are indented exactly like plugin results, so
    // an unclamped counter says "10 of 6" — and a bar that overshoots is a bar nobody trusts.
    const lines = [
      "== CPU cost of 2 plugin(s) at 48000 Hz (block 512, cpu 7)",
      "  urn:a: 3.25 ns/sample median",
      "  urn:b: 25.27 ns/sample median",
      "  48000 Hz: measured 2  unmeasurable 0  failed 0",
      "  at 48000 Hz — cheapest urn:a",
    ];
    let state = INITIAL_PROGRESS;
    for (const line of lines) {
      const event = parseProbeProgress(line);
      if (event !== undefined) state = advanceProgress(state, event);
    }
    expect(state).toEqual({ rate: 48000, done: 2, total: 2 });
  });

  it("resets the count when the next rate's phase begins", () => {
    let state = advanceProgress(INITIAL_PROGRESS, { kind: "phase", plugins: 3, rate: 48000 });
    state = advanceProgress(state, { kind: "plugin" });
    state = advanceProgress(state, { kind: "phase", plugins: 3, rate: 96000 });
    expect(state).toEqual({ rate: 96000, done: 0, total: 3 });
  });

  it("counts nothing before the first phase banner", () => {
    expect(advanceProgress(INITIAL_PROGRESS, { kind: "plugin" })).toEqual(INITIAL_PROGRESS);
  });
});

describe("assembling the document", () => {
  const catalog = [
    {
      uri: "urn:a",
      name: "A",
      audioInputs: 2,
      audioOutputs: 2,
      hasMidiIn: false,
      params: [],
      latency: { perRate: { "48000": { frames: 64, ms: 1.333 } }, scalingClass: "fixed-frame" },
      cpuCost: {
        perRate: {
          "48000": { nsPerSampleMedian: 5, nsPerSampleP95: 6, blocks: 512, blockFrames: 512 },
        },
      },
    },
  ];

  it("prefers the cost pass's own provenance for the host block", () => {
    const document = assembleDocument({
      options: options({ rates: [48000] }),
      catalog,
      costProvenance: {
        host: "nuc",
        cpuModel: "N100",
        governor: "powersave",
        blockFrames: 512,
        warmupBlocks: 64,
        percentile: 95,
        stimulus: "sustained tone",
        realtimePriority: false,
        memoryLocked: false,
      },
      host: FIXTURE_HOST,
      runId: "run-1",
      measuredAt: "2026-08-01T10:00:00+02:00",
      elapsedSeconds: 12,
    });
    expect(document.run.host.hostname).toBe("nuc");
    expect(document.run.host.governor).toBe("powersave");
    expect(document.run.method.cost?.percentile).toBe(95);
    expect(document.run.tool.name).toBe(TOOL_NAME);
    expect(document.run.elapsedSeconds).toBe(12);
  });

  it("falls back to the collected host facts on a latency-only run", () => {
    const document = assembleDocument({
      options: options({ rates: [48000], dimensions: ["latency"] }),
      catalog,
      host: FIXTURE_HOST,
      runId: "run-2",
      measuredAt: "2026-08-01T10:00:00+02:00",
    });
    expect(document.run.host.hostname).toBe("ref-desk");
    expect(document.run.method.cost).toBeUndefined();
    expect(document.run.method.latency?.method).toBe("impulse-onset");
    // No cost figures, so no relative-ranking claim to make.
    expect(document.run.relativeRankingOnly).toBe(false);
    expect(document.plugins[0]?.cost).toBeUndefined();
  });

  it("marks a dimension the run covered but never reached as not-attempted", () => {
    const document = assembleDocument({
      options: options({ rates: [48000] }),
      catalog: [{ uri: "urn:b", audioInputs: 2, audioOutputs: 2, hasMidiIn: false, params: [] }],
      host: FIXTURE_HOST,
      runId: "run-3",
      measuredAt: "2026-08-01T10:00:00+02:00",
    });
    expect(document.plugins[0]?.latency?.unmeasuredReason).toBe("not-attempted");
    expect(document.plugins[0]?.cost?.unmeasuredReason).toBe("not-attempted");
  });
});
