// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * `lv2-measure` — the standalone utility's logic, with the subprocess spawning left out.
 *
 * Everything that decides WHAT to run lives here and is pure: argument parsing, the probe
 * pipeline, the progress heuristic, the assembly of the finished document. `tools/lv2-measure.mjs`
 * is the shell that runs the steps and touches the filesystem. Split that way because the
 * interesting failures — a rate silently dropped, a pass run in the wrong order, a partial
 * run written as if complete — are all decisions, and decisions can be tested without a
 * 15-minute sweep and 958 real plugins.
 *
 * ## The pass order is load-bearing
 *
 * `CATALOG_PROVENANCE.md` says it and it is easy to get wrong: the declared-latency pass
 * must run before the measured one, because the measured pass sizes its capture window from
 * the declared figure and computes `declaredMismatch` against it. {@link buildPipeline}
 * encodes that order so no operator has to remember it.
 *
 * ## Nothing probes without an explicit go-ahead
 *
 * The pipeline instantiates and runs every LV2 plugin on the machine. That is a CPU-heavy,
 * mildly hazardous thing to start by accident — a plugin can and does crash its host — so it
 * is gated behind `--run` (or `LV2_MEASURE_RUN=1`), exactly as `benchmark.py` gates itself.
 * `--dry-run` prints the plan and probes nothing.
 *
 * ## The hosting pass
 *
 * `stability`, `rtSafety` and `features` are measured by the native measurer (`native/lv2-measure.c`,
 * `lv2_measure`), run once per plugin under the interposer, in its own process so a crash is a
 * reading and never the run's end. Its lines are the hosting sweep's, read by `sweep-jsonl.ts`.
 * The plugins are the scan's, or exactly the `--plugins` named, which needs no scan.
 */

import { join } from "node:path";

import type { MeasurementDocument, MeasurementRun, MeasuredPlugin } from "./format.js";
import { buildMeasurementDocument } from "./format.js";
import { measuredPluginsFromProbeOutput } from "./probe-json.js";
import { buildRun, costMethodFromProbeProvenance, hostFromProbeProvenance } from "./provenance.js";
import type { MeasurementHost, LatencyMethod } from "./format.js";
import { measuredPluginsFromSweep } from "./sweep-jsonl.js";
import { isRecord, nonEmptyString } from "./guards.js";
import { HOSTING_PASS_DIMENSIONS, type MeasurementDimension, PROBED_DIMENSIONS } from "./vocabulary.js";
import { LV2_HOSTING_BLOCK_FRAMES, LV2_HOSTING_LIFECYCLES, LV2_HOSTING_REPEATS } from "../qualify-declarations.js";

/** Name and version this tool stamps into every document it writes. */
export const TOOL_NAME = "lv2-measure";

/**
 * The tool's own version, independent of {@link ../format.MEASUREMENT_FORMAT_VERSION}: the
 * prober can improve without the schema moving, and a consumer comparing two documents
 * needs to know which of the two it was.
 */
export const TOOL_VERSION = "0.1.0";

/** A fully resolved invocation. */
export interface MeasureOptions {
  /** Where the document goes. Absent = stdout. */
  readonly outPath?: string;
  readonly rates: readonly number[];
  readonly dimensions: readonly MeasurementDimension[];
  /** An existing prober scan to reuse instead of scanning. */
  readonly scanPath?: string;
  /** The plugins the hosting pass measures, instead of every plugin the scan finds. */
  readonly plugins?: readonly string[];
  /** Where intermediates are written. */
  readonly workDir: string;
  /** Also sweep latency-bearing controls to find parameter-dependent latency. */
  readonly sweep: boolean;
  /** Core to pin the cost pass to. Absent = let the prober choose. */
  readonly costCpu?: number;
  readonly label?: string;
  /** Directory holding `scan.py` and `benchmark.py`. */
  readonly toolDir: string;
  /** The Python interpreter to run them with. */
  readonly python: string;
  /** The explicit go-ahead to instantiate and run real plugins. */
  readonly run: boolean;
  /** Print the plan and probe nothing. */
  readonly dryRun: boolean;
}

/** One subprocess the pipeline runs, and what it leaves behind. */
export interface PipelineStep {
  /** Stable id: `scan` / `latency-declared` / `latency-measured` / `cost` / `hosting`. */
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Run once per plugin, the plugin's URI before `args` (the hosting pass). */
  readonly perPlugin?: boolean;
  /** Set in the step's environment, over the caller's. */
  readonly env?: Readonly<Record<string, string>>;
  /** The catalog JSON this step writes — the next step's input; the hosting pass's JSONL. */
  readonly produces: string;
  /** The dimension this step measures, when it measures one. */
  readonly dimension?: MeasurementDimension;
}

/** The full plan: the steps, and where the run's artefacts land. */
export interface Pipeline {
  readonly steps: readonly PipelineStep[];
  /** The catalog JSON carrying every annotation once the last step has run; absent when nothing is scanned. */
  readonly finalCatalog?: string;
  /** The scan the hosting pass takes its plugins from, when `--plugins` does not name them. */
  readonly hostingScan?: string;
  /** Where the cost pass writes its machine provenance, when cost is measured. */
  readonly costProvenance?: string;
}

/**
 * The probe passes an invocation needs, in the only order that produces correct data.
 *
 * A reused `--scan` skips the scan step; everything else follows from the dimensions asked
 * for. The cost pass reads whatever the latency passes produced, so a run measuring both
 * ends with one file carrying both — which is also why `finalCatalog` is a property of the
 * pipeline rather than a fixed name.
 */
export function buildPipeline(options: MeasureOptions, native?: HostingTools): Pipeline {
  const steps: PipelineStep[] = [];
  const benchmark = join(options.toolDir, "benchmark.py");
  const rates = [...options.rates].sort((a, b) => a - b).join(",");
  const probed = options.dimensions.some((d) => (PROBED_DIMENSIONS as readonly string[]).includes(d));
  const hosting = options.dimensions.some((d) => (HOSTING_PASS_DIMENSIONS as readonly string[]).includes(d));
  if (hosting && native === undefined) throw new Error("the hosting pass needs the native measurer and the interposer");

  let current = options.scanPath;
  if (current === undefined && (probed || options.plugins === undefined)) {
    current = join(options.workDir, "scan.json");
    steps.push({
      id: "scan",
      command: options.python,
      args: [join(options.toolDir, "scan.py"), "--out", current],
      produces: current,
    });
  }

  // a prober dimension always has a scan: --plugins is refused beside one
  if (options.dimensions.includes("latency") && current !== undefined) {
    // Declared first: the measured pass sizes its capture window from this figure and
    // computes declaredMismatch against it. Reversing the two silently degrades both.
    const declared = join(options.workDir, "latency-declared.json");
    steps.push({
      id: "latency-declared",
      command: options.python,
      args: [benchmark, "--in", current, "--out", declared, "--run"],
      produces: declared,
      dimension: "latency",
    });
    const measured = join(options.workDir, "latency-measured.json");
    steps.push({
      id: "latency-measured",
      command: options.python,
      args: [
        benchmark,
        "--in",
        declared,
        "--out",
        measured,
        "--measure",
        "--run",
        "--rates",
        rates,
        ...(options.sweep ? ["--sweep"] : []),
      ],
      produces: measured,
      dimension: "latency",
    });
    current = measured;
  }

  let costProvenance: string | undefined;
  if (options.dimensions.includes("cost") && current !== undefined) {
    costProvenance = join(options.workDir, "cost-provenance.json");
    const cost = join(options.workDir, "cost.json");
    steps.push({
      id: "cost",
      command: options.python,
      args: [
        benchmark,
        "--in",
        current,
        "--out",
        cost,
        "--cost",
        "--run",
        "--rates",
        rates,
        "--cost-provenance",
        costProvenance,
        ...(options.costCpu === undefined ? [] : ["--cost-cpu", String(options.costCpu)]),
      ],
      produces: cost,
      dimension: "cost",
    });
    current = cost;
  }

  if (hosting && native !== undefined) {
    steps.push({
      id: "hosting",
      command: native.tool,
      args: [
        String(Math.max(...options.rates)),
        String(LV2_HOSTING_BLOCK_FRAMES),
        String(LV2_HOSTING_LIFECYCLES),
        String(LV2_HOSTING_REPEATS),
      ],
      perPlugin: true,
      env: { LD_PRELOAD: native.interposer, OMX_STIM: "noise" },
      produces: join(options.workDir, "hosting.jsonl"),
    });
  }

  return {
    steps,
    ...(probed && current !== undefined ? { finalCatalog: current } : {}),
    ...(hosting && options.plugins === undefined && current !== undefined ? { hostingScan: current } : {}),
    ...(costProvenance === undefined ? {} : { costProvenance }),
  };
}

/** The native measurer and the interposer it runs under, as located for this run. */
export interface HostingTools {
  readonly tool: string;
  readonly interposer: string;
}

/** The plugin URIs of a scan (a flat array of descriptors), in its order, each once. */
export function urisFromScan(scan: unknown): string[] {
  if (!Array.isArray(scan)) return [];
  const uris = scan.flatMap((entry) => {
    const uri = isRecord(entry) ? nonEmptyString(entry.uri) : undefined;
    return uri === undefined ? [] : [uri];
  });
  return [...new Set(uris)];
}

/** How one run of the native measurer ended. `signal` is a death, `timedOut` the run killed for its time. */
export interface HostingRunResult {
  readonly status: number | null;
  readonly signalNumber?: number;
  readonly timedOut?: boolean;
  readonly stdout: string;
}

/**
 * One plugin's run of the native measurer as the hosting sweep's JSONL line: the LAST line of its
 * stdout that is a JSON object (a plugin may print its own banner first), with the exit status
 * beside it, a death written as 128 + its signal and a timeout as 124. A run that printed no line
 * is `crashed`, its exit kept: what that exit means is the reader's (`sweep-jsonl.ts`) to say.
 */
export function hostingLine(uri: string, run: HostingRunResult): Record<string, unknown> {
  const exit = run.timedOut === true ? 124 : run.signalNumber !== undefined ? 128 + run.signalNumber : (run.status ?? 1);
  const last = run.stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .pop();
  if (last !== undefined) {
    try {
      const row: unknown = JSON.parse(last);
      if (isRecord(row)) return { ...row, exit };
    } catch {
      return { uri, exit, parseError: true };
    }
  }
  return { uri, exit, crashed: true };
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/** A parsed command line, or the reason it could not be parsed. */
export type ArgParseResult =
  | { readonly ok: true; readonly options: MeasureOptions }
  | { readonly ok: false; readonly error: string };

function parseRates(text: string): number[] | undefined {
  const rates = text
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((rate) => Number.isFinite(rate) && rate > 0);
  return rates.length > 0 ? [...new Set(rates)].sort((a, b) => a - b) : undefined;
}

/** What `--dimensions` takes: the prober's, and the hosting pass's. */
export const MEASURED_DIMENSIONS: readonly MeasurementDimension[] = [...PROBED_DIMENSIONS, ...HOSTING_PASS_DIMENSIONS];

function parseDimensions(text: string): MeasurementDimension[] | undefined {
  const wanted = text.split(",").map((part) => part.trim());
  const dimensions = MEASURED_DIMENSIONS.filter((d) => wanted.includes(d));
  return dimensions.length === wanted.filter((w) => w.length > 0).length && dimensions.length > 0
    ? [...dimensions]
    : undefined;
}

/**
 * Parse `lv2-measure`'s command line.
 *
 * There is no default rate list and there never will be. A tool that measures 48 kHz because
 * the operator forgot to say produces a document whose figures are about a rate nobody asked
 * for, and the whole point of a per-rate format is that such a document is a lie by omission.
 */
export function parseMeasureArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
  defaults: { readonly toolDir: string; readonly workDir: string },
): ArgParseResult {
  let outPath: string | undefined;
  let rates: readonly number[] | undefined;
  let dimensions: readonly MeasurementDimension[] = PROBED_DIMENSIONS;
  let scanPath: string | undefined;
  let plugins: readonly string[] | undefined;
  let workDir = defaults.workDir;
  let sweep = false;
  let costCpu: number | undefined;
  let label: string | undefined;
  let toolDir = defaults.toolDir;
  let python = env.PYTHON ?? "python3";
  let run = env.LV2_MEASURE_RUN === "1";
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = (): string | undefined => {
      i += 1;
      return argv[i];
    };
    switch (flag) {
      case "--out": {
        const value = next();
        if (value === undefined) return { ok: false, error: "--out needs a path" };
        outPath = value;
        break;
      }
      case "--rates": {
        const value = next();
        const parsed = value === undefined ? undefined : parseRates(value);
        if (parsed === undefined) return { ok: false, error: "--rates needs a comma-separated list of Hz" };
        rates = parsed;
        break;
      }
      case "--dimensions": {
        const value = next();
        const parsed = value === undefined ? undefined : parseDimensions(value);
        if (parsed === undefined) {
          return { ok: false, error: `--dimensions accepts ${MEASURED_DIMENSIONS.join(",")}` };
        }
        dimensions = parsed;
        break;
      }
      case "--scan": {
        const value = next();
        if (value === undefined) return { ok: false, error: "--scan needs a path" };
        scanPath = value;
        break;
      }
      case "--plugins": {
        const value = next();
        const uris = value === undefined ? [] : [...new Set(value.split(",").map((u) => u.trim()).filter((u) => u !== ""))];
        if (uris.length === 0) return { ok: false, error: "--plugins needs a comma-separated list of plugin URIs" };
        plugins = uris;
        break;
      }
      case "--work-dir": {
        const value = next();
        if (value === undefined) return { ok: false, error: "--work-dir needs a path" };
        workDir = value;
        break;
      }
      case "--tool-dir": {
        const value = next();
        if (value === undefined) return { ok: false, error: "--tool-dir needs a path" };
        toolDir = value;
        break;
      }
      case "--python": {
        const value = next();
        if (value === undefined) return { ok: false, error: "--python needs an interpreter" };
        python = value;
        break;
      }
      case "--cost-cpu": {
        const value = next();
        const cpu = value === undefined ? Number.NaN : Number(value);
        if (!Number.isInteger(cpu) || cpu < 0) return { ok: false, error: "--cost-cpu needs a core number" };
        costCpu = cpu;
        break;
      }
      case "--label": {
        const value = next();
        if (value === undefined) return { ok: false, error: "--label needs text" };
        label = value;
        break;
      }
      case "--sweep":
        sweep = true;
        break;
      case "--run":
        run = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      default:
        return { ok: false, error: `unknown argument: ${String(flag)}` };
    }
  }

  if (rates === undefined) {
    return {
      ok: false,
      error: "--rates is required: a measurement with no stated rate is not a measurement",
    };
  }
  if (plugins !== undefined && dimensions.some((d) => (PROBED_DIMENSIONS as readonly string[]).includes(d))) {
    return {
      ok: false,
      error: `--plugins names the hosting pass's plugins; ${PROBED_DIMENSIONS.join(" and ")} measure every plugin the scan finds`,
    };
  }
  return {
    ok: true,
    options: {
      rates,
      dimensions,
      workDir,
      sweep,
      toolDir,
      python,
      run,
      dryRun,
      ...(outPath === undefined ? {} : { outPath }),
      ...(scanPath === undefined ? {} : { scanPath }),
      ...(plugins === undefined ? {} : { plugins }),
      ...(costCpu === undefined ? {} : { costCpu }),
      ...(label === undefined ? {} : { label }),
    },
  };
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/** One thing the prober's stderr said, as far as a progress bar is concerned. */
export type ProbeProgress =
  | { readonly kind: "phase"; readonly plugins: number; readonly rate: number }
  | { readonly kind: "plugin" };

/**
 * Interpret one line of the prober's stderr.
 *
 * A HEURISTIC over a human-readable log, and worth being honest about: it recognises the
 * phase banner (`== measuring N plugin(s) at R Hz`) and counts the indented one-line-per-
 * plugin results that follow, successes and failures alike. It does not parse the figures —
 * those come from the JSON, which is authoritative. A line it does not recognise advances
 * nothing, so an unparsed log stalls the progress bar rather than corrupting the data.
 */
export function parseProbeProgress(line: string): ProbeProgress | undefined {
  const phase = /^== (?:measuring|CPU cost of) (\d+) plugin\(s\) at (\d+) Hz/.exec(line);
  if (phase !== null) {
    const plugins = Number(phase[1]);
    const rate = Number(phase[2]);
    if (Number.isFinite(plugins) && Number.isFinite(rate)) return { kind: "phase", plugins, rate };
    return undefined;
  }
  // Indented result lines are one per plugin. The two diagnostics that are NOT per-plugin
  // are excluded by name rather than by shape, because their shape is identical.
  if (/^ {2}\S/.test(line) && !/^ {2}(?:could not pin|worker spawn failed)/.test(line)) {
    return { kind: "plugin" };
  }
  return undefined;
}

/** How far through the current phase the prober is. */
export interface ProgressState {
  /** The rate the current phase is measuring at. 0 before the first banner. */
  readonly rate: number;
  readonly done: number;
  readonly total: number;
}

/** Nothing has been reported yet. */
export const INITIAL_PROGRESS: ProgressState = { rate: 0, done: 0, total: 0 };

/**
 * Fold one parsed progress event into the running state.
 *
 * The clamp is the point. Each phase ends with its own indented summary lines, which look
 * exactly like plugin results to a line-shape heuristic — so a naive counter reports 10 of 6
 * plugins done, and a progress bar that overshoots teaches an operator to distrust it. Once
 * the phase's own stated total is reached, further plugin lines advance nothing.
 */
export function advanceProgress(state: ProgressState, event: ProbeProgress): ProgressState {
  if (event.kind === "phase") return { rate: event.rate, done: 0, total: event.plugins };
  if (state.total === 0 || state.done >= state.total) return state;
  return { ...state, done: state.done + 1 };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** Everything {@link assembleDocument} needs beyond the probe output. */
export interface AssemblyInput {
  readonly options: MeasureOptions;
  /** The final catalog JSON, already parsed. Absent when the run measured no prober dimension. */
  readonly catalog?: unknown;
  /** The hosting pass's lines ({@link hostingLine}), one per plugin. Absent when it did not run. */
  readonly hosting?: readonly unknown[];
  /** The cost pass's provenance JSON, already parsed. Absent on a latency-only run. */
  readonly costProvenance?: unknown;
  /** Host facts, for a run whose provenance the cost pass did not write. */
  readonly host: MeasurementHost;
  readonly runId: string;
  readonly measuredAt: string;
  readonly elapsedSeconds?: number;
}

/** The latency method a `--measure` pass at this block size represents. */
export function latencyMethodFor(options: MeasureOptions, blockFrames: number): LatencyMethod {
  return {
    method: "impulse-onset",
    blockFrames,
    stimulus:
      "unit impulse, escalating to a sustained tone and then to an opened gate for plugins " +
      "that pass nothing at rest; the escalation used is recorded on each reading",
    paramSweep: options.sweep,
  };
}

/** The block size the latency pass uses when nothing overrides it — `benchmark.py`'s own. */
export const DEFAULT_LATENCY_BLOCK_FRAMES = 512;

/**
 * Fold a finished run into a document.
 *
 * The cost pass's own provenance wins for the host block when it exists: it was written by
 * the process that did the timing, pinned to the core it timed on, and it knows things a
 * post-hoc reader cannot (which core, at what governor, at that moment). Only when there is
 * no cost pass do the caller's collected facts stand in.
 */
export function assembleDocument(input: AssemblyInput): MeasurementDocument {
  const probed = input.options.dimensions.filter((d) => (PROBED_DIMENSIONS as readonly string[]).includes(d));
  const plugins: MeasuredPlugin[] =
    probed.length > 0 && input.catalog !== undefined ? measuredPluginsFromProbeOutput(input.catalog, probed) : [];
  if (input.hosting !== undefined) mergeHosting(plugins, measuredPluginsFromSweep({ measurements: input.hosting }), input.options.dimensions);
  const costMethod = costMethodFromProbeProvenance(input.costProvenance);
  const host = hostFromProbeProvenance(input.costProvenance) ?? input.host;
  const run: MeasurementRun = buildRun({
    id: input.runId,
    measuredAt: input.measuredAt,
    dimensions: input.options.dimensions,
    rates: input.options.rates,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    host,
    ...(input.options.dimensions.includes("latency")
      ? { latencyMethod: latencyMethodFor(input.options, costMethod?.blockFrames ?? DEFAULT_LATENCY_BLOCK_FRAMES) }
      : {}),
    ...(costMethod === undefined ? {} : { costMethod }),
    ...(input.elapsedSeconds === undefined ? {} : { elapsedSeconds: input.elapsedSeconds }),
    ...(input.options.label === undefined ? {} : { label: input.options.label }),
  });
  return buildMeasurementDocument(run, plugins);
}

/**
 * The hosting pass's plugins folded into the prober's, by URI: each keeps the hosting dimensions the
 * run asked for and the pin, and a plugin only the hosting pass measured joins with its own topology.
 */
function mergeHosting(plugins: MeasuredPlugin[], hosted: readonly MeasuredPlugin[], dimensions: readonly MeasurementDimension[]): void {
  for (const h of hosted) {
    const blocks = {
      ...(dimensions.includes("stability") && h.stability !== undefined ? { stability: h.stability } : {}),
      ...(dimensions.includes("rtSafety") && h.rtSafety !== undefined ? { rtSafety: h.rtSafety } : {}),
      ...(dimensions.includes("features") && h.features !== undefined ? { features: h.features } : {}),
      ...(h.integrity === undefined ? {} : { integrity: h.integrity }),
    };
    const at = plugins.findIndex((p) => p.uri === h.uri);
    if (at < 0) {
      plugins.push({ uri: h.uri, ...(h.version === undefined ? {} : { version: h.version }), topology: h.topology, ...blocks });
    } else {
      const p = plugins[at]!;
      plugins[at] = { ...p, ...(p.version === undefined && h.version !== undefined ? { version: h.version } : {}), ...blocks };
    }
  }
}
