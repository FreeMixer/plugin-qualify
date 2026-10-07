// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The prober's JSON → the interchange format.
 *
 * `tools/scan.py` and `tools/benchmark.py` write a flat array of annotated descriptors —
 * their own working shape, which predates this format and carries fields (curation tiers,
 * parameter lists, RPM ownership) that have nothing to do with a measurement. This module
 * is the one place that knows both shapes, and it is where three deliberate conversions
 * happen:
 *
 * 1. **Free text becomes vocabulary.** The prober says `"worker crashed (…)"`,
 *    `"probe timed out"`, `"non-finite output"` — useful to a human, unmergeable between
 *    projects. Each is mapped to a term from {@link ./vocabulary.ts}, and the prober's own
 *    sentence is preserved verbatim next to it so the coarser code never destroys the
 *    detail.
 * 2. **Derived figures are dropped.** `coreFractionP95` and `instancesPerCoreP95` are
 *    `nsPerSample × rate` and its reciprocal. Storing them invites the two to disagree
 *    after an edit; the format keeps the measured primitive and lets consumers derive.
 * 3. **`nsPerSampleP95` becomes `nsPerSamplePercentile`.** The percentile is a property of
 *    the RUN, declared once in {@link ../format.CostMethod}. Baking `95` into every field
 *    name would make a p99 run unrepresentable.
 *
 * The reader is structural: it validates the fields it needs and ignores everything else,
 * so it survives the prober growing new ones.
 */

import type {
  CostAtRate,
  CostMeasurement,
  LatencyAtRate,
  LatencyMeasurement,
  MeasuredParamSweep,
  MeasuredPlugin,
  PluginTopology,
} from "./format.js";
import { booleanValue, finiteNumber, isRecord, nonEmptyString, optional, positiveNumber } from "./guards.js";
import type { MeasurementDimension } from "./vocabulary.js";

/** One free-text prober failure, and the vocabulary term it means. */
interface ReasonRule {
  /** Matched against the prober's lowercased text. */
  readonly match: RegExp;
  readonly code: string;
}

/**
 * The prober's words → the controlled vocabulary. Ordered: the first match wins, so the
 * specific patterns come before the general ones.
 *
 * A table rather than a switch precisely so the next prober — someone else's — can be
 * supported by adding rows, which is the whole ambition of publishing a format.
 */
export const PROBE_REASON_RULES: readonly ReasonRule[] = [
  { match: /^no-audio-in$/, code: "no-audio-in" },
  { match: /^no-audio-out$/, code: "no-audio-out" },
  { match: /^silent-output$/, code: "silent-output" },
  { match: /worker crashed|worker desync|worker unavailable/, code: "probe-crashed" },
  { match: /timed out|timeout/, code: "probe-timeout" },
  { match: /non-finite/, code: "non-finite-output" },
  { match: /not installed/, code: "not-installed" },
  { match: /refus|instantiat/, code: "refused-instantiation" },
];

/**
 * The vocabulary code for a prober reason.
 *
 * Anything unmatched becomes `probe-error` — never a guessed structural reason. A reason we
 * cannot classify must not be allowed to claim the plugin has nothing to measure, because
 * that claim would override a good figure from another machine ({@link ./merge.ts}).
 */
export function probeReasonCode(text: string): string {
  const lower = text.toLowerCase();
  return PROBE_REASON_RULES.find((rule) => rule.match.test(lower))?.code ?? "probe-error";
}

function reasonFields(text: string | undefined): { unmeasuredReason?: string; unmeasuredDetail?: string } {
  if (text === undefined) return {};
  const code = probeReasonCode(text);
  return {
    unmeasuredReason: code,
    // Keep the prober's sentence only when it says more than the code already does.
    ...(text === code ? {} : { unmeasuredDetail: text }),
  };
}

function readTopology(entry: Record<string, unknown>): PluginTopology | undefined {
  const audioInputs = finiteNumber(entry.audioInputs);
  const audioOutputs = finiteNumber(entry.audioOutputs);
  if (audioInputs === undefined || audioOutputs === undefined) return undefined;
  const midiInputs = entry.hasMidiIn === true ? 1 : entry.hasMidiIn === false ? 0 : undefined;
  const controlInputs = Array.isArray(entry.params)
    ? entry.params.filter((p) => isRecord(p) && p.kind === "control").length
    : undefined;
  return {
    audioInputs,
    audioOutputs,
    ...optional("midiInputs", midiInputs),
    ...optional("controlInputs", controlInputs),
  };
}

function readSweep(value: unknown): MeasuredParamSweep | undefined {
  if (!isRecord(value)) return undefined;
  const rate = positiveNumber(value.rate);
  const defaultFrames = finiteNumber(value.defaultFrames);
  const minFrames = finiteNumber(value.minFrames);
  const maxFrames = finiteNumber(value.maxFrames);
  if (rate === undefined || defaultFrames === undefined || minFrames === undefined || maxFrames === undefined) {
    return undefined;
  }
  const controls: Record<string, { minFrames: number; maxFrames: number }> = {};
  if (isRecord(value.controls)) {
    for (const [symbol, span] of Object.entries(value.controls)) {
      if (!isRecord(span)) continue;
      const lo = finiteNumber(span.minFrames);
      const hi = finiteNumber(span.maxFrames);
      if (lo === undefined || hi === undefined) continue;
      controls[symbol] = { minFrames: lo, maxFrames: hi };
    }
  }
  return { rate, defaultFrames, minFrames, maxFrames, controls };
}

/**
 * Rates the prober condemned, as `rate → reason`. In the catalog shape these live in a
 * parallel `unreliableRates` array; the format puts the exclusion ON the reading it
 * disqualifies, where a consumer cannot fail to notice it.
 */
function excludedRates(value: unknown): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (!isRecord(item)) continue;
    const rate = positiveNumber(item.rate);
    const reason = nonEmptyString(item.reason);
    if (rate === undefined || reason === undefined) continue;
    out.set(String(rate), reason);
  }
  return out;
}

function readLatency(value: unknown): LatencyMeasurement | undefined {
  if (!isRecord(value)) return undefined;
  const excluded = excludedRates(value.unreliableRates);
  const perRate: Record<string, LatencyAtRate> = {};
  if (isRecord(value.perRate)) {
    for (const [key, reading] of Object.entries(value.perRate)) {
      const rate = positiveNumber(Number(key));
      if (rate === undefined || !isRecord(reading)) continue;
      const frames = finiteNumber(reading.frames);
      const ms = finiteNumber(reading.ms);
      if (frames === undefined || ms === undefined) continue;
      perRate[String(rate)] = {
        frames,
        ms,
        ...optional("stimulus", nonEmptyString(value.stimulus)),
        ...optional("excludedReason", excluded.get(String(rate))),
      };
    }
  }
  const unmeasurable = nonEmptyString(value.unmeasurable);
  const measurement: LatencyMeasurement = {
    perRate,
    ...optional("scalingClass", nonEmptyString(value.scalingClass)),
    ...optional("scalingNote", nonEmptyString(value.scalingNote)),
    ...optional("declaredPortSymbol", nonEmptyString(value.portSymbol)),
    ...optional("declaredFrames", finiteNumber(value.reportedFrames)),
    ...optional("declaredMismatch", booleanValue(value.declaredMismatch)),
    ...optional("paramSweep", readSweep(value.paramSweep)),
    // A reason only when there is no reading: a figure and a reason are mutually exclusive.
    ...(Object.keys(perRate).length === 0 ? reasonFields(unmeasurable) : {}),
  };
  return measurement;
}

function readCost(value: unknown): CostMeasurement | undefined {
  if (!isRecord(value)) return undefined;
  const perRate: Record<string, CostAtRate> = {};
  if (isRecord(value.perRate)) {
    for (const [key, reading] of Object.entries(value.perRate)) {
      const rate = positiveNumber(Number(key));
      if (rate === undefined || !isRecord(reading)) continue;
      const median = finiteNumber(reading.nsPerSampleMedian);
      const high = finiteNumber(reading.nsPerSampleP95);
      const blocks = finiteNumber(reading.blocks);
      const blockFrames = positiveNumber(reading.blockFrames);
      if (median === undefined || high === undefined || blocks === undefined || blockFrames === undefined) {
        continue;
      }
      perRate[String(rate)] = {
        nsPerSampleMedian: median,
        nsPerSamplePercentile: high,
        blocks,
        blockFrames,
        ...optional("nsPerSampleMin", finiteNumber(reading.nsPerSampleMin)),
        ...optional("nsPerSampleMax", finiteNumber(reading.nsPerSampleMax)),
        ...optional("warmupNsPerSampleMedian", finiteNumber(reading.warmupNsPerSampleMedian)),
        ...optional("silentOutput", booleanValue(reading.silentOutput)),
      };
    }
  }
  const reason = nonEmptyString(value.unmeasurable) ?? nonEmptyString(value.failed);
  return {
    perRate,
    ...(Object.keys(perRate).length === 0 ? reasonFields(reason) : {}),
  };
}

/**
 * The plugin's own version, `"<minor>.<micro>"`, when the scan recorded one.
 *
 * Absent rather than `"0.0"` when it did not: a version of zero is a real LV2 answer
 * (unstable/development), so it must not double as "we do not know".
 */
function readVersion(entry: Record<string, unknown>): string | undefined {
  const minor = finiteNumber(entry.minorVersion);
  const micro = finiteNumber(entry.microVersion);
  if (minor === undefined || micro === undefined) return nonEmptyString(entry.version);
  return `${minor}.${micro}`;
}

/**
 * One prober descriptor as a {@link MeasuredPlugin}, or `undefined` when it is not one.
 *
 * `dimensions` says which dimensions the run covered: a dimension NOT covered yields no
 * block at all (the run never asked), while a covered dimension always yields one, carrying
 * either readings or a reason. That distinction is what makes a partial run readable. The
 * prober's JSON carries only `latency` and `cost`; a hosting dimension listed here yields no
 * block, because this reader has nothing to read it from (`sweep-jsonl.ts` does).
 */
export function measuredPluginFromProbeEntry(
  value: unknown,
  dimensions: readonly MeasurementDimension[],
): MeasuredPlugin | undefined {
  if (!isRecord(value)) return undefined;
  const uri = nonEmptyString(value.uri);
  if (uri === undefined) return undefined;
  const topology = readTopology(value);
  if (topology === undefined) return undefined;

  const latency = dimensions.includes("latency")
    ? readLatency(value.latency) ?? { perRate: {}, unmeasuredReason: "not-attempted" }
    : undefined;
  const cost = dimensions.includes("cost")
    ? readCost(value.cpuCost) ?? { perRate: {}, unmeasuredReason: "not-attempted" }
    : undefined;

  return {
    uri,
    topology,
    ...optional("name", nonEmptyString(value.name)),
    ...optional("version", readVersion(value)),
    ...optional("bundle", nonEmptyString(value.bundlePath)),
    ...optional("lv2Class", nonEmptyString(value.lv2Class)),
    ...optional("latency", latency),
    ...optional("cost", cost),
  };
}

/** Every readable descriptor in a prober output array, as measured plugins. */
export function measuredPluginsFromProbeOutput(
  value: unknown,
  dimensions: readonly MeasurementDimension[],
): MeasuredPlugin[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const plugin = measuredPluginFromProbeEntry(entry, dimensions);
    return plugin === undefined ? [] : [plugin];
  });
}
