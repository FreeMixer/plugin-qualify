// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The hosting sweep's JSONL → the interchange format's three hosting dimensions.
 *
 * `lv2-measure` (the C lilv host, `packages/pipewire-native/tools/lv2-measure.c`) under
 * `rt-interpose.c` writes one JSON line per plugin, and the sweep ran it in THREE passes a
 * reader has to put back together:
 *
 * - the QUICK pass (`all-measurements.jsonl`): every plugin, 30 lifecycles, the interposer's
 *   counts, the required features, the threads;
 * - the DEEP lifecycle pass (`lifecycle-1000.jsonl`): the candidates again at 1000 lifecycles —
 *   where present it SUPERSEDES the quick pass's lifecycle and threads, and a crash in it is a
 *   crash the quick pass could not have seen;
 * - the SOAK (`soak*.jsonl`): a show-length render per rate with every control swept slowly
 *   across its range (`lv2-measure.c`'s soak mode), one line per plugin.
 *
 * Like `probe-json.ts`, this is a TRANSLATION and never a judgement. An exit status of 139 is
 * written as the signal it is (128 + SIGSEGV); whether that crash is the plugin's fault, whether a
 * soak held, whether a count is a measurement at all — those are the consumer's rules, and a
 * reader that decided them would be a second classifier ahead of the real one.
 */

import type {
  CrashReading,
  FeaturesMeasurement,
  MeasuredPlugin,
  RtSafetyMeasurement,
  SoakReading,
  StabilityMeasurement,
} from "./format.js";
import { readLifecycle, readSoakAtRate, readThreads } from "./format.js";
import { booleanValue, finiteNumber, isRecord, mapArray, nonEmptyString, optional, positiveNumber } from "./guards.js";

/** The sweep's three passes, each a list of parsed JSONL lines. Only `measurements` is required. */
export interface SweepPasses {
  readonly measurements: readonly unknown[];
  readonly lifecycle?: readonly unknown[];
  readonly soak?: readonly unknown[];
}

/** A process exit status that IS a signal death, as the signal's name. Anything else is not a
 *  crash this reader can name — a timeout (124) or an early refusal is the run failing, not the
 *  plugin dying, and it is not written as a crash. */
const SIGNAL_EXITS: Readonly<Record<number, string>> = {
  134: "SIGABRT",
  135: "SIGBUS",
  139: "SIGSEGV",
};

function crashOf(row: Record<string, unknown>): CrashReading | undefined {
  if (row.crashed !== true) return undefined;
  const exit = finiteNumber(row.exit);
  const signal = exit === undefined ? undefined : SIGNAL_EXITS[exit];
  return signal === undefined ? undefined : { signal };
}

/** One soak line's per-rate map. The tool writes `block` and a redundant `rate` inside each
 *  reading; the rate is the key, and `block` is the format's `blockFrames`. */
function soakOf(row: unknown): SoakReading | undefined {
  if (!isRecord(row) || !isRecord(row.perRate)) return undefined;
  const perRate: Record<string, NonNullable<ReturnType<typeof readSoakAtRate>>> = {};
  for (const [key, reading] of Object.entries(row.perRate)) {
    const rate = positiveNumber(Number(key));
    if (rate === undefined || !Number.isInteger(rate) || !isRecord(reading)) continue;
    const parsed = readSoakAtRate({ ...reading, blockFrames: reading.block });
    if (parsed !== undefined) perRate[String(rate)] = parsed;
  }
  // lv2-measure's soak mode sweeps every control across its range for the whole render.
  return { sweptParams: true, perRate };
}

function stabilityOf(
  quick: Record<string, unknown>,
  deep: Record<string, unknown> | undefined,
  soakRow: unknown,
): StabilityMeasurement {
  const lifecycle = readLifecycle(deep?.lifecycle) ?? readLifecycle(quick.lifecycle);
  if (lifecycle === undefined) return { unmeasuredReason: "probe-error", unmeasuredDetail: "no lifecycle in the sweep line" };
  const threads = readThreads(deep?.threads) ?? readThreads(quick.threads);
  const crashes = [crashOf(quick), deep === undefined ? undefined : crashOf(deep)].filter(
    (c): c is CrashReading => c !== undefined,
  );
  const soak = soakRow === undefined ? undefined : soakOf(soakRow);
  return {
    lifecycle,
    ...optional("threads", threads),
    crashes,
    ...optional("soak", soak),
  };
}

function rtSafetyOf(row: Record<string, unknown>): RtSafetyMeasurement {
  const rt = row.rtSafety;
  if (!isRecord(rt)) return { unmeasuredReason: "probe-error", unmeasuredDetail: "no interposer block in the sweep line" };
  return {
    ...optional("rate", positiveNumber(row.rate)),
    ...optional("blockFrames", positiveNumber(row.block)),
    ...optional("blocks", finiteNumber(rt.blocks)),
    ...optional("repeats", finiteNumber(rt.repeats)),
    ...optional("interposer", booleanValue(rt.interposer)),
    ...optional("swept", booleanValue(rt.swept)),
    ...optional("sweepApplicable", booleanValue(rt.sweepApplicable)),
    ...optional("allocationsInRun", finiteNumber(rt.allocationsInRun)),
    ...optional("allocationsMin", finiteNumber(rt.allocationsMin)),
    ...optional("locksInRun", finiteNumber(rt.locksInRun)),
    ...optional("syscallsInRun", finiteNumber(rt.syscallsInRun)),
    ...optional("variable", booleanValue(rt.variable)),
  };
}

function featuresOf(row: Record<string, unknown>): FeaturesMeasurement {
  const required = mapArray(row.requiredFeatures, nonEmptyString);
  if (required === undefined) return { unmeasuredReason: "probe-error", unmeasuredDetail: "no feature list in the sweep line" };
  return {
    required,
    ...optional("optional", mapArray(row.optionalFeatures, nonEmptyString)),
    ...optional("cvPorts", finiteNumber(row.cvPorts)),
  };
}

function byUri(rows: readonly unknown[] | undefined): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const row of rows ?? []) {
    if (!isRecord(row)) continue;
    const uri = nonEmptyString(row.uri);
    if (uri !== undefined) out.set(uri, row);
  }
  return out;
}

/**
 * Every plugin the sweep INSTANTIATED, as a {@link MeasuredPlugin} carrying the three hosting
 * dimensions.
 *
 * A line for a plugin the tool could not find or instantiate carries no topology, and the
 * format's plugin entry requires one (rule 2: no invented numbers). It is left out rather than
 * written with a reason: its three blocks would all be `probe-failed`, which by the merge's own
 * rule override nothing — a line with no reading and no power to change a figure.
 */
export function measuredPluginsFromSweep(passes: SweepPasses): MeasuredPlugin[] {
  const deep = byUri(passes.lifecycle);
  const soak = byUri(passes.soak);
  const out: MeasuredPlugin[] = [];
  for (const row of passes.measurements) {
    if (!isRecord(row)) continue;
    const uri = nonEmptyString(row.uri);
    const audioInputs = finiteNumber(row.audioInputs);
    const audioOutputs = finiteNumber(row.audioOutputs);
    if (uri === undefined || audioInputs === undefined || audioOutputs === undefined) continue;
    out.push({
      uri,
      topology: {
        audioInputs,
        audioOutputs,
        ...optional("controlInputs", finiteNumber(row.controlInputs)),
      },
      stability: stabilityOf(row, deep.get(uri), soak.get(uri)),
      rtSafety: rtSafetyOf(row),
      features: featuresOf(row),
    });
  }
  return out;
}

/** Parse JSONL text: every line that is a JSON object, in order. A plugin's own stdout banner
 *  before the JSON is the sweep harness's problem and already stripped there. */
export function parseJsonl(text: string): unknown[] {
  return text
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line): unknown => JSON.parse(line));
}
