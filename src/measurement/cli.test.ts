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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  advanceProgress,
  assembleDocument,
  buildPipeline,
  hostingLine,
  INITIAL_PROGRESS,
  LV2_BLOCK_DECLARATIONS,
  LV2_FEATURE_KINDS,
  LV2_LOG_MODES,
  parseMeasureArgs,
  parseProbeProgress,
  TOOL_NAME,
  urisFromScan,
  type MeasureOptions,
} from "./cli.js";
import { LV2_HOSTING_BLOCK_FRAMES, LV2_HOSTING_LIFECYCLES, LV2_HOSTING_REPEATS } from "../qualify-declarations.js";
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

  it("gives the cost pass the probe count an instrument is held at, and only when asked", () => {
    const cost = buildPipeline(options({ probeNotes: 32 })).steps.find((s) => s.id === "cost");
    expect(cost?.args).toEqual(expect.arrayContaining(["--probe-notes", "32"]));
    expect(buildPipeline(options()).steps.find((s) => s.id === "cost")?.args).not.toContain("--probe-notes");
    const parsed = parseMeasureArgs(["--rates", "96000", "--probe-notes", "32"], {}, DEFAULTS);
    expect(parsed.ok && parsed.options.probeNotes).toBe(32);
    for (const bad of ["0", "129", "2.5", "many"]) {
      expect(parseMeasureArgs(["--rates", "96000", "--probe-notes", bad], {}, DEFAULTS).ok).toBe(false);
    }
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

describe("the hosting pass (the native lv2_measure)", () => {
  const NATIVE = { tool: "/x/lv2_measure", interposer: "/x/rt_interpose.so" };
  const HOSTING = ["stability", "rtSafety", "features"] as const;

  it("takes the hosting dimensions and --plugins, refusing --plugins beside a prober dimension", () => {
    const r = parseMeasureArgs(["--rates", "48000", "--dimensions", "rtSafety,features", "--plugins", "urn:a, urn:b,urn:a"], {}, DEFAULTS);
    expect(r.ok && r.options.dimensions).toEqual(["rtSafety", "features"]);
    expect(r.ok && r.options.plugins).toEqual(["urn:a", "urn:b"]);
    expect(parseMeasureArgs(["--rates", "48000", "--plugins", "urn:a"], {}, DEFAULTS).ok).toBe(false);
    expect(parseMeasureArgs(["--rates", "48000", "--dimensions", "rtSafety", "--plugins", ","], {}, DEFAULTS).ok).toBe(false);
  });

  it("runs the measurer once per plugin under the interposer, at the highest rate asked", () => {
    const { steps } = buildPipeline(options({ dimensions: [...HOSTING], plugins: ["urn:a"] }), NATIVE);
    expect(steps).toEqual([
      {
        id: "hosting",
        command: NATIVE.tool,
        args: ["96000", String(LV2_HOSTING_BLOCK_FRAMES), String(LV2_HOSTING_LIFECYCLES), String(LV2_HOSTING_REPEATS)],
        perPlugin: true,
        env: { LD_PRELOAD: NATIVE.interposer, OMX_STIM: "noise" },
        produces: "/tmp/run/hosting.jsonl",
      },
    ]);
  });

  it("scans for its plugins when none are named, and runs after the prober's passes", () => {
    const alone = buildPipeline(options({ dimensions: ["stability"] }), NATIVE);
    expect(alone.steps.map((s) => s.id)).toEqual(["scan", "hosting"]);
    expect(alone.hostingScan).toBe("/tmp/run/scan.json");
    expect(alone.finalCatalog).toBeUndefined();
    const all = buildPipeline(options({ dimensions: ["latency", "cost", ...HOSTING] }), NATIVE);
    expect(all.steps.map((s) => s.id)).toEqual(["scan", "latency-declared", "latency-measured", "cost", "hosting"]);
    expect(all.finalCatalog).toBe("/tmp/run/cost.json");
  });

  it("passes the feature-option flags to every run, after the positionals, in the order given", () => {
    const argv = ["--rates", "48000", "--dimensions", "rtSafety", "--plugins", "urn:a"];
    const flags = ["--features", "map,unmap,options,bounded,log", "--strict", "--block-declares", "", "--block-max", "1024", "--log", "capture", "--log-capture-bytes", "8192"];
    const r = parseMeasureArgs([...argv, ...flags], {}, DEFAULTS);
    expect(r.ok && r.options.featureFlags).toEqual(flags);
    if (!r.ok) return;
    const [step] = buildPipeline(r.options, NATIVE).steps;
    expect(step?.args).toEqual(["48000", String(LV2_HOSTING_BLOCK_FRAMES), String(LV2_HOSTING_LIFECYCLES), String(LV2_HOSTING_REPEATS), ...flags]);
    const plain = parseMeasureArgs(argv, {}, DEFAULTS);
    expect(plain.ok && plain.options.featureFlags).toBeUndefined();
  });

  it("refuses a feature-option value the measurer would refuse, and the flags without the hosting pass", () => {
    const argv = ["--rates", "48000", "--dimensions", "rtSafety", "--plugins", "urn:a"];
    for (const bad of [["--features", "map,midi"], ["--block-declares", "variable"], ["--block-min", "-1"], ["--block-max", "1k"], ["--log", "loud"], ["--log-capture-bytes", "1"], ["--log"]]) {
      expect(parseMeasureArgs([...argv, ...bad], {}, DEFAULTS).ok, bad.join(" ")).toBe(false);
    }
    const r = parseMeasureArgs(["--rates", "48000", "--strict"], {}, DEFAULTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("hosting pass");
  });

  it("names the feature options' words as the measurer does (one list, two readers)", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "native", "lv2-measure-options.c"), "utf8");
    const named = (re: RegExp): string[] => [...(re.exec(src)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(named(/LV2_MEASURE_FEATURE_NAMES\[[^\]]*\] = \{([^}]*)\}/)).toEqual([...LV2_FEATURE_KINDS]);
    expect(named(/LV2_MEASURE_DECLARATION_NAMES\[[^\]]*\] = \{([^}]*)\}/)).toEqual([...LV2_BLOCK_DECLARATIONS]);
    expect(named(/LOG_MODE_NAMES\[\] = \{([^}]*)\}/)).toEqual([...LV2_LOG_MODES]);
  });

  it("refuses to plan the pass without the native tools", () => {
    expect(() => buildPipeline(options({ dimensions: ["rtSafety"], plugins: ["urn:a"] }))).toThrow(/native measurer/);
  });

  it("lists a scan's plugins once each, skipping what has no URI", () => {
    expect(urisFromScan([{ uri: "urn:a" }, { uri: "" }, {}, { uri: "urn:b" }, { uri: "urn:a" }])).toEqual(["urn:a", "urn:b"]);
    expect(urisFromScan({ uri: "urn:a" })).toEqual([]);
  });

  it("keeps the last JSON line of a run with its exit, and writes a death as the sweep did", () => {
    expect(hostingLine("urn:a", { status: 0, stdout: 'using block size: 0\n{"uri":"urn:a","found":true}\n' })).toEqual({ uri: "urn:a", found: true, exit: 0 });
    expect(hostingLine("urn:a", { status: 3, stdout: '{"uri":"urn:a","found":false}\n' })).toEqual({ uri: "urn:a", found: false, exit: 3 });
    expect(hostingLine("urn:a", { status: null, signalNumber: 11, stdout: "" })).toEqual({ uri: "urn:a", exit: 139, crashed: true });
    expect(hostingLine("urn:a", { status: null, timedOut: true, stdout: "" })).toEqual({ uri: "urn:a", exit: 124, crashed: true });
    expect(hostingLine("urn:a", { status: 0, stdout: "{not json\n" })).toEqual({ uri: "urn:a", exit: 0, parseError: true });
  });

  it("repairs a line a plugin printed its own banner into, with extractJsonRecord (plugin-qualify#35)", () => {
    const torn = '{"uri":"urn:a","found":true,using block size: 0\nconvolver disabled\n"rate":48000}\n';
    expect(hostingLine("urn:a", { status: 0, stdout: torn })).toEqual({ uri: "urn:a", found: true, rate: 48000, exit: 0 });
  });

  const line = {
    uri: "urn:a",
    found: true,
    instantiated: true,
    rate: 96000,
    block: 512,
    audioInputs: 2,
    audioOutputs: 2,
    controlInputs: 1,
    version: "1.0",
    integrity: { version: "1.0", files: [{ path: "a.so", sha256: "a".repeat(64) }], layout: { scheme: "omx-layout/1", sha256: "b".repeat(64) } },
    requiredFeatures: [],
    optionalFeatures: [],
    cvPorts: 0,
    lifecycle: { cycles: 30, instantiated: 30, failed: 0 },
    threads: { before: 1, afterFirstInstantiate: 1, afterAllFreed: 1, leaked: 0 },
    rtSafety: { interposer: true, blocks: 512, repeats: 3, swept: true, sweepApplicable: true, allocationsInRun: 0, allocationsMin: 0, variable: false, locksInRun: 0, syscallsInRun: 0 },
    exit: 0,
  };

  it("folds the pass into the prober's plugin, keeping only the dimensions asked and the pin", () => {
    const document = assembleDocument({
      options: options({ rates: [48000], dimensions: ["latency", "rtSafety"] }),
      catalog: [{ uri: "urn:a", audioInputs: 2, audioOutputs: 2, hasMidiIn: false, params: [], latency: { perRate: { "48000": { frames: 0, ms: 0 } } } }],
      hosting: [line, { uri: "urn:gone", exit: 139, crashed: true }],
      host: FIXTURE_HOST,
      runId: "run-4",
      measuredAt: "2026-08-01T10:00:00+02:00",
    });
    expect(document.run.dimensions).toEqual(["latency", "rtSafety"]);
    expect(document.plugins.map((p) => p.uri)).toEqual(["urn:a"]);
    const [a] = document.plugins;
    expect(a?.latency?.perRate?.["48000"]?.frames).toBe(0);
    expect(a?.rtSafety).toMatchObject({ rate: 96000, interposer: true, allocationsInRun: 0 });
    expect(a?.stability).toBeUndefined();
    expect(a?.features).toBeUndefined();
    expect(a?.integrity).toEqual(line.integrity);
  });

  it("writes a plugin only the pass measured with the topology the measurer read", () => {
    const document = assembleDocument({
      options: options({ rates: [96000], dimensions: [...HOSTING], plugins: ["urn:a"] }),
      hosting: [line],
      host: FIXTURE_HOST,
      runId: "run-5",
      measuredAt: "2026-08-01T10:00:00+02:00",
    });
    expect(document.plugins).toHaveLength(1);
    expect(document.plugins[0]).toMatchObject({
      uri: "urn:a",
      version: "1.0",
      topology: { audioInputs: 2, audioOutputs: 2, controlInputs: 1 },
      stability: { lifecycle: { cycles: 30, instantiated: 30, failed: 0 }, crashes: [] },
      features: { required: [], cvPorts: 0 },
    });
  });
});
