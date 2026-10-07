// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * **The LV2 plugin measurement interchange format** — one measurement run, on one
 * machine, in one document (issue #343).
 *
 * `lv2:latency` is a declared port and it is often wrong: the 958-plugin sweep behind
 * `data/catalog.json` found 57 declared-vs-measured mismatches. Measured figures exist in
 * several projects and are shared by none of them, because there is no shape to share them
 * in. This is that shape. The schema is the deliverable; the prober is replaceable.
 *
 * ## The three rules the format exists to enforce
 *
 * 1. **A figure carries the conditions it was taken under.** {@link MeasurementRun} is not
 *    optional metadata and is not a footer — it is the document's other half. A cost
 *    figure without its host, governor, block and stimulus is a decoration; a latency
 *    figure without the plugin's version is a trap, because the next release moves the FFT
 *    window and the number silently becomes a lie.
 * 2. **Unknown is a value.** A plugin that could not be measured carries a REASON from a
 *    controlled vocabulary ({@link ./vocabulary.ts}) and no number at all. Nothing in this
 *    format has a default: an absent field means "not determined", never zero and never
 *    false. Readers here return `undefined` rather than inventing.
 * 3. **Per rate, always.** Latency does not scale one way and cost does not scale at all
 *    predictably — 19 plugins in the reference sweep fit neither scaling law, and 48 cost
 *    figures grow with the SQUARE of the rate. A single-rate document is a claim about one
 *    rate and the format will not let it pretend otherwise: every figure lives under an
 *    explicit rate key.
 *
 * ## Version strategy
 *
 * `formatVersion` is `"<major>.<minor>"`.
 *
 * - **major** changes when a reader written for the previous major would MISREAD a
 *   document: a field removed, renamed, re-scaled, or given a new meaning. A reader that
 *   meets a higher major must refuse the document ({@link readMeasurementDocument} does),
 *   because the alternative is silently consuming figures it has misunderstood.
 * - **minor** changes are additive only: new optional fields, new vocabulary terms. A
 *   reader at minor N reads minor N+1 fine, ignoring what it does not know — and is TOLD
 *   it is doing so ({@link MeasurementReadResult.forwardMinor}), so a UI can say "this
 *   document was written by a newer tool" instead of quietly dropping data.
 *
 * Unknown fields are preserved nowhere and that is deliberate: a reader that round-trips
 * fields it does not understand invites a consumer to depend on them. Re-emit from the
 * original document, never from a parse.
 */

import {
  booleanValue,
  finiteNumber,
  isRecord,
  mapArray,
  nonEmptyString,
  optional,
  positiveNumber,
} from "./guards.js";
import {
  type HostIsolation,
  type HostLatencyHandling,
  type MeasurementDimension,
  type VerdictRating,
  HOST_ISOLATIONS,
  HOST_LATENCY_HANDLING,
  MEASUREMENT_DIMENSIONS,
  VERDICT_RATINGS,
  readDimension,
} from "./vocabulary.js";

/** The `format` discriminator every document carries. Never absent, never anything else. */
export const MEASUREMENT_FORMAT_ID = "lv2-plugin-measurements";

/** The major this build writes and is guaranteed to understand. */
export const MEASUREMENT_FORMAT_MAJOR = 1;

/** The minor this build writes. Additive-only within {@link MEASUREMENT_FORMAT_MAJOR}.
 *  `1.1` added the three hosting dimensions — {@link StabilityMeasurement},
 *  {@link RtSafetyMeasurement}, {@link FeaturesMeasurement} — which a 1.0 reader skips. */
export const MEASUREMENT_FORMAT_MINOR = 2;

/** The version string this build writes, e.g. `"1.0"`. */
export const MEASUREMENT_FORMAT_VERSION = `${MEASUREMENT_FORMAT_MAJOR}.${MEASUREMENT_FORMAT_MINOR}`;

/** A parsed `formatVersion`. */
export interface FormatVersion {
  readonly major: number;
  readonly minor: number;
}

/**
 * Parse a `"<major>.<minor>"` version, or `undefined` when it is not one.
 *
 * Deliberately strict — two non-negative integers and nothing else. A version we cannot
 * parse is a document we cannot claim to understand, and guessing at `"1"` or `"1.0.0"`
 * would be exactly the sloppiness a version field exists to prevent.
 */
export function parseFormatVersion(value: unknown): FormatVersion | undefined {
  const text = nonEmptyString(value);
  if (text === undefined) return undefined;
  const match = /^(\d+)\.(\d+)$/.exec(text);
  if (match === null) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return undefined;
  return { major, minor };
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * The machine a run happened on.
 *
 * Every field except {@link hostname} is optional and every one of them is absent when it
 * could not be READ — the prober reports what `/proc` and `/sys` told it and nothing else.
 * `realtimePriority` and `memoryLocked` are the exception and are required, because
 * "we did not try" and "we tried and were not allowed" are both `false` and a consumer
 * comparing two runs must not have to guess which.
 */
export interface MeasurementHost {
  /** The machine's name. The single field an operator recognises. */
  readonly hostname: string;
  readonly kernel?: string;
  readonly os?: string;
  readonly cpuModel?: string;
  readonly cpuCount?: number;
  /** The core the prober pinned itself to, when it pinned at all. */
  readonly pinnedCpu?: number;
  /** What kind of core that was — `performance` / `efficiency` on a hybrid CPU. */
  readonly pinnedCpuKind?: string;
  readonly pinnedCpuMaxKHz?: number;
  /** The cpufreq governor in force, read at run time. `performance` and `powersave`
   *  produce materially different cost figures on the same silicon. */
  readonly governor?: string;
  readonly turboEnabled?: boolean;
  /** Whether the prober ran with realtime scheduling. Required: `false` is a finding. */
  readonly realtimePriority: boolean;
  /** Whether the prober's pages were locked. Required, same reason. */
  readonly memoryLocked: boolean;
  /** Versions of what did the probing (`{ python: "3.14.6", lilv: "0.24.26" }`). */
  readonly toolchain?: Readonly<Record<string, string>>;
}

/** How the latency figures in this document were taken. */
export interface LatencyMethod {
  /** A {@link ../vocabulary.METHOD_TERMS} code — `impulse-onset` or `declared-port`. */
  readonly method: string;
  readonly blockFrames: number;
  /** What was fed in, in words. An onset measured through an opened gate is not the same
   *  measurement as one through a bare impulse, and the difference must be legible. */
  readonly stimulus: string;
  /** Whether latency-bearing controls were swept to find parameter-dependent latency. */
  readonly paramSweep: boolean;
}

/** How the cost figures in this document were taken. */
export interface CostMethod {
  /** A {@link ../vocabulary.METHOD_TERMS} code — `block-time-percentile`. */
  readonly method: string;
  readonly blockFrames: number;
  /** Blocks timed and then DISCARDED before the steady-state window opened. */
  readonly warmupBlocks: number;
  readonly minTimedBlocks?: number;
  readonly maxTimedBlocks?: number;
  /** Wall-time budget per plugin per rate, after which timing stops early. */
  readonly targetSecondsPerPlugin?: number;
  /** The percentile the headline figure is quoted at. The mean hides the tail that xruns. */
  readonly percentile: number;
  readonly stimulus: string;
  /** How control ports were set — the operating point the figure describes. */
  readonly controls: string;
  /** Lower bound on the harness's own per-block overhead. Plugins near it are too cheap
   *  to rank apart, and it is REPORTED rather than subtracted. */
  readonly timingFloorNsPerBlock?: number;
}

/**
 * One measurement run: who measured, on what, how, when, and over which rates.
 *
 * A document is exactly one run, on purpose. Merging figures taken on different machines
 * is a consumer's decision with a consumer's caveats ({@link ./merge.ts}); baking it into
 * the document would make a merged file indistinguishable from a measured one.
 */
export interface MeasurementRun {
  /** Stable identifier for this run — referenced by a merged view to name a figure's source. */
  readonly id: string;
  /** ISO 8601, with offset. */
  readonly measuredAt: string;
  /** Which dimensions this run covered. A plugin carrying no figure for a dimension NOT
   *  listed here was never asked; one carrying none for a dimension that IS listed has a
   *  reason. That distinction is why the field exists. */
  readonly dimensions: readonly MeasurementDimension[];
  /** Every sample rate the run measured at, ascending. */
  readonly rates: readonly number[];
  readonly tool: { readonly name: string; readonly version: string };
  readonly host: MeasurementHost;
  readonly method: { readonly latency?: LatencyMethod; readonly cost?: CostMethod };
  /** Wall-clock duration of the run. The only honest basis for estimating the next one. */
  readonly elapsedSeconds?: number;
  /** Free-text label an operator gave the run ("after installing LSP 1.2.22"). */
  readonly label?: string;
  /**
   * Always `true` on a run carrying cost figures: the numbers RANK plugins on the machine
   * named above and do not predict another. Kept as an explicit field rather than a
   * convention so a consumer cannot claim it never saw the caveat.
   */
  readonly relativeRankingOnly: boolean;
  /** The caveat in prose, for anyone reading the file directly. */
  readonly note: string;
}

// ---------------------------------------------------------------------------
// Per-plugin figures
// ---------------------------------------------------------------------------

/** What the prober saw of the plugin's ports. Cheap, portable, and it decides suitability. */
export interface PluginTopology {
  readonly audioInputs: number;
  readonly audioOutputs: number;
  readonly midiInputs?: number;
  readonly controlInputs?: number;
}

/** One rate's latency reading. */
export interface LatencyAtRate {
  readonly frames: number;
  readonly ms: number;
  /** Set when this reading needed an ESCALATED stimulus (a gate that had to be opened).
   *  The figure then describes that operating point, not the plugin at rest. */
  readonly stimulus?: string;
  /**
   * Set when the reading was taken but REJECTED as evidence, with a vocabulary code
   * ({@link ../vocabulary.EXCLUSION_TERMS}). The number stays — this is the measurement
   * record — but a consumer must not resolve a rate to it.
   */
  readonly excludedReason?: string;
}

/** The controls that move a plugin's latency, and the span they move it over. */
export interface MeasuredParamSweep {
  readonly rate: number;
  readonly defaultFrames: number;
  readonly minFrames: number;
  readonly maxFrames: number;
  /** Per-control span, keyed by control-port symbol. */
  readonly controls: Readonly<Record<string, { readonly minFrames: number; readonly maxFrames: number }>>;
}

/** Everything one run learned about one plugin's latency. */
export interface LatencyMeasurement {
  /** Readings keyed by sample rate in Hz as a decimal string (`"96000"`). May be empty. */
  readonly perRate: Readonly<Record<string, LatencyAtRate>>;
  /** A {@link ../vocabulary.SCALING_TERMS} code, derived from {@link perRate}. */
  readonly scalingClass?: string;
  /** A {@link ../vocabulary.SCALING_NOTE_TERMS} code: why the class is not the naive fit. */
  readonly scalingNote?: string;
  /** Symbol of the plugin's own `lv2:latency` port, when it has one. */
  readonly declaredPortSymbol?: string;
  /** What that port CLAIMED, in frames. Kept next to the measurement, never instead of it. */
  readonly declaredFrames?: number;
  /** Set when declared and measured disagree beyond rounding — a data-quality flag on the
   *  PLUGIN, and the single most useful thing this format publishes. */
  readonly declaredMismatch?: boolean;
  readonly paramSweep?: MeasuredParamSweep;
  /** An {@link ../vocabulary.UNMEASURED_TERMS} code. Set exactly when {@link perRate} is
   *  empty; a figure and a reason are mutually exclusive. */
  readonly unmeasuredReason?: string;
  /** The prober's own words for that reason, kept verbatim. The CODE is what a merger
   *  branches on; this is what a human reads when the code is too coarse to debug with. */
  readonly unmeasuredDetail?: string;
}

/** One rate's cost reading. Per SAMPLE, so it is independent of the block size. */
export interface CostAtRate {
  readonly nsPerSampleMedian: number;
  /** The percentile named in {@link CostMethod.percentile} — what a bad block costs. */
  readonly nsPerSamplePercentile: number;
  readonly nsPerSampleMin?: number;
  readonly nsPerSampleMax?: number;
  /** Timed blocks the statistics were computed over, warm-up already dropped. */
  readonly blocks: number;
  readonly blockFrames: number;
  /** Median over the DISCARDED warm-up blocks: the evidence that discarding was warranted
   *  rather than assumed. */
  readonly warmupNsPerSampleMedian?: number;
  /** Timed, but emitted silence under a stimulus that should have passed — the figure may
   *  describe a short-circuit path rather than the DSP. */
  readonly silentOutput?: boolean;
}

/** Everything one run learned about one plugin's CPU cost. */
export interface CostMeasurement {
  /** Readings keyed by sample rate in Hz as a decimal string. May be empty. */
  readonly perRate: Readonly<Record<string, CostAtRate>>;
  /** An {@link ../vocabulary.UNMEASURED_TERMS} code, set exactly when {@link perRate} is empty. */
  readonly unmeasuredReason?: string;
  /** The prober's own words for that reason, kept verbatim. See {@link LatencyMeasurement.unmeasuredDetail}. */
  readonly unmeasuredDetail?: string;
}

// ---------------------------------------------------------------------------
// The hosting dimensions (1.1): whether a plugin SURVIVES, whether its run() is RT-clean,
// and what it demands of a host. RAW readings, each one what the prober saw — never a
// conclusion. Whether a soak held or a count is a measurement is the consumer's rule, and
// a format that stored the conclusion would make every consumer share one reader's rules.
// ---------------------------------------------------------------------------

/** Instantiate/destroy cycles, as run. */
export interface LifecycleReading {
  readonly cycles: number;
  readonly instantiated: number;
  readonly failed: number;
}

/** The process's thread count around the plugin's first instance. */
export interface ThreadReading {
  readonly before: number;
  readonly afterFirstInstantiate: number;
  readonly afterAllFreed?: number;
  readonly leaked?: number;
}

/** A crash as observed. Attribution — whose fault — is the consumer's, from its own table. */
export interface CrashReading {
  readonly signal?: string;
  readonly topFrame?: string;
  /** The error class a sanitizer build reported, verbatim (`"heap-buffer-overflow"`). */
  readonly sanitizer?: string;
  /** Basename of the shared object the faulting frame lies in (`"zero-path.so"`). */
  readonly frameObject?: string;
}

/** One rate of a continuous soak: the render as it went, window by window. */
export interface SoakAtRate {
  /** The process died at this rate. Every other field is then absent. */
  readonly died?: boolean;
  readonly instantiated?: boolean;
  readonly seconds?: number;
  readonly blockFrames?: number;
  readonly windows?: number;
  readonly nonFiniteWindows?: number;
  readonly silentWindows?: number;
  readonly firstRmsDbfs?: number;
  readonly lastRmsDbfs?: number;
  readonly minRmsDbfs?: number;
  readonly rssStartKb?: number;
  readonly rssMaxKb?: number;
  readonly rssGrowthKb?: number;
}

/** A continuous soak, per rate, with whether the controls were swept while it ran. */
export interface SoakReading {
  readonly sweptParams: boolean;
  readonly perRate: Readonly<Record<string, SoakAtRate>>;
}

/** Everything one run learned about one plugin SURVIVING. Readable when it has a lifecycle. */
export interface StabilityMeasurement {
  readonly lifecycle?: LifecycleReading;
  readonly threads?: ThreadReading;
  readonly crashes?: readonly CrashReading[];
  readonly soak?: SoakReading;
  readonly unmeasuredReason?: string;
  readonly unmeasuredDetail?: string;
}

/**
 * What an interposer counted INSIDE `run()`. `rate` and `blockFrames` are the pair it ran at —
 * a count is a property of the code paths the run took there. Readable when all three counts
 * are present.
 */
export interface RtSafetyMeasurement {
  readonly rate?: number;
  readonly blockFrames?: number;
  readonly blocks?: number;
  readonly repeats?: number;
  /** The interposer was actually loaded. A zero from an absent interposer counts nothing. */
  readonly interposer?: boolean;
  /** The controls were swept across their ranges while counting. */
  readonly swept?: boolean;
  /** False when the plugin has no control a sweep could move. */
  readonly sweepApplicable?: boolean;
  readonly allocationsInRun?: number;
  readonly allocationsMin?: number;
  readonly locksInRun?: number;
  readonly syscallsInRun?: number;
  /** Repeats disagreed. */
  readonly variable?: boolean;
  readonly unmeasuredReason?: string;
  readonly unmeasuredDetail?: string;
}

/** What the plugin DEMANDS of a host, read off the instance the run loaded. */
export interface FeaturesMeasurement {
  readonly required?: readonly string[];
  readonly optional?: readonly string[];
  readonly cvPorts?: number;
  readonly unmeasuredReason?: string;
  readonly unmeasuredDetail?: string;
}

/** One plugin as one run saw it. */
export interface MeasuredPlugin {
  readonly uri: string;
  readonly name?: string;
  /**
   * The plugin's own version (`lv2:minorVersion.lv2:microVersion`), when it declares one.
   * A latency figure attached to no version is the trap #343 names: the next release moves
   * the window and the figure becomes wrong without becoming absent.
   */
  readonly version?: string;
  /** The LV2 bundle it came from — what an operator greps for when a figure surprises them. */
  readonly bundle?: string;
  /** The plugin's declared LV2 class label, verbatim. */
  readonly lv2Class?: string;
  readonly topology: PluginTopology;
  readonly latency?: LatencyMeasurement;
  readonly cost?: CostMeasurement;
  readonly stability?: StabilityMeasurement;
  readonly rtSafety?: RtSafetyMeasurement;
  readonly features?: FeaturesMeasurement;
}

/** What a host spends on one plugin instance: the P95 core-fraction ceiling, at its rate and quantum. */
export interface HostBudget {
  readonly coreFractionCeiling: number;
  readonly rate: number;
  readonly quantum: number;
}

/**
 * A HOST PROFILE (`2026-09-25-plugin-qualify.md` §3a; §3b here): the host a verdict was judged
 * against — only what differs between hosts. A document carries every profile its verdicts name,
 * in full, so a verdict against a project's own profile is reproducible from the document alone.
 */
export interface HostProfile {
  readonly id: string;
  /** The LV2 feature URIs the host passes to `instantiate`. */
  readonly lv2Features: readonly string[];
  /** The CLAP host extensions it offers; `null` for a host with no CLAP path at all. */
  readonly clapExtensions: readonly string[] | null;
  /** Whether it feeds note/MIDI input — hosts instruments. */
  readonly instruments: boolean;
  readonly cost: HostBudget;
  readonly latency: HostLatencyHandling;
  readonly isolation: HostIsolation;
}

/** One plugin's verdict under one host profile (§3b). `host` is a `hostProfiles[].id`. */
export interface DocumentVerdict {
  readonly uri: string;
  readonly host: string;
  readonly rating: VerdictRating;
  /** `rating === "suitable"`, and nothing else. */
  readonly qualified: boolean;
  /** The code of the reason that decided it; absent for `suitable`. */
  readonly deciding?: string;
}

/** A complete document: one run, and what it found. */
export interface MeasurementDocument {
  readonly format: typeof MEASUREMENT_FORMAT_ID;
  readonly formatVersion: string;
  readonly run: MeasurementRun;
  readonly plugins: readonly MeasuredPlugin[];
  /** v1.2: the hosts the run's verdicts were judged against (§3b). */
  readonly hostProfiles?: readonly HostProfile[];
  /** v1.2: one verdict per plugin per host profile — conclusions, beside the raw blocks. */
  readonly verdicts?: readonly DocumentVerdict[];
}

export type HostProfileRead = { ok: true; profile: HostProfile } | { ok: false; problem: string };

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x !== "");
const isPositive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * Read a host profile — a document's, or a project's own file. Every field is required and
 * typed; a missing or mistyped one is refused by name, and a host the reader was not told about
 * is never filled in from a default.
 */
export function readHostProfile(value: unknown): HostProfileRead {
  if (!isRecord(value)) return { ok: false, problem: "a host profile is a JSON object" };
  const { id, lv2Features, clapExtensions, instruments, cost, latency, isolation } = value;
  if (typeof id !== "string" || id === "") return { ok: false, problem: "id: a non-empty string" };
  if (!isStringList(lv2Features)) return { ok: false, problem: "lv2Features: a list of feature URIs" };
  if (clapExtensions !== null && !isStringList(clapExtensions)) {
    return { ok: false, problem: "clapExtensions: a list of extension ids, or null for no CLAP" };
  }
  if (typeof instruments !== "boolean") return { ok: false, problem: "instruments: true or false" };
  if (!isRecord(cost) || !isPositive(cost.coreFractionCeiling) || !isPositive(cost.rate) || !isPositive(cost.quantum)) {
    return { ok: false, problem: "cost: { coreFractionCeiling, rate, quantum }, each a positive number" };
  }
  if (!Number.isInteger(cost.rate) || !Number.isInteger(cost.quantum)) {
    return { ok: false, problem: "cost: rate and quantum are integers" };
  }
  if (!(HOST_LATENCY_HANDLING as readonly unknown[]).includes(latency)) {
    return { ok: false, problem: `latency: one of ${HOST_LATENCY_HANDLING.join(", ")}` };
  }
  if (!(HOST_ISOLATIONS as readonly unknown[]).includes(isolation)) {
    return { ok: false, problem: `isolation: one of ${HOST_ISOLATIONS.join(", ")}` };
  }
  return {
    ok: true,
    profile: {
      id,
      lv2Features,
      clapExtensions,
      instruments,
      cost: { coreFractionCeiling: cost.coreFractionCeiling, rate: cost.rate, quantum: cost.quantum },
      latency: latency as HostLatencyHandling,
      isolation: isolation as HostIsolation,
    },
  };
}

/** A verdict as written, or `undefined`: its host must be declared, `qualified` must be its rating's. */
function readVerdict(value: unknown, hosts: ReadonlySet<string>): DocumentVerdict | undefined {
  if (!isRecord(value)) return undefined;
  const uri = nonEmptyString(value.uri);
  const host = nonEmptyString(value.host);
  const rating = (VERDICT_RATINGS as readonly unknown[]).includes(value.rating) ? (value.rating as VerdictRating) : undefined;
  if (uri === undefined || host === undefined || !hosts.has(host) || rating === undefined) return undefined;
  if (value.qualified !== (rating === "suitable")) return undefined;
  if (value.deciding !== undefined && nonEmptyString(value.deciding) === undefined) return undefined;
  return { uri, host, rating, qualified: rating === "suitable", ...optional("deciding", nonEmptyString(value.deciding)) };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** A refusal to read a document, with the reason in a form a UI can render. */
export interface MeasurementReadFailure {
  readonly ok: false;
  /** Stable code: `not-an-object` / `wrong-format` / `bad-version` / `future-major` /
   *  `missing-run` / `missing-plugins`. */
  readonly problem: string;
  /** English detail for logs. UIs render from {@link problem} plus {@link found}. */
  readonly detail: string;
  /** What was actually there, when the problem is about a value. */
  readonly found?: string;
}

/** A document read successfully, plus what the reader had to tolerate to do it. */
export interface MeasurementReadSuccess {
  readonly ok: true;
  readonly document: MeasurementDocument;
  readonly version: FormatVersion;
  /**
   * Set when the document's minor is AHEAD of this build's: it was written by a newer tool
   * and may carry fields this reader dropped. Everything read is still valid — minors are
   * additive — but a surface should say so rather than imply completeness.
   */
  readonly forwardMinor?: true;
  /**
   * Plugin entries dropped for being malformed. Never silent: a document that half-parses
   * must say how much of it was lost, or a consumer will read a partial catalogue as a
   * complete one.
   */
  readonly droppedPlugins: number;
  /**
   * v1.2: verdicts (and host profiles) dropped for being malformed or naming a host the document
   * does not declare — present whenever the document carried either list.
   */
  readonly droppedVerdicts?: number;
}

/** The outcome of {@link readMeasurementDocument}. */
export type MeasurementReadResult = MeasurementReadSuccess | MeasurementReadFailure;

function readToolchain(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    const text = nonEmptyString(entry);
    if (text !== undefined) out[key] = text;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readHost(value: unknown): MeasurementHost | undefined {
  if (!isRecord(value)) return undefined;
  const hostname = nonEmptyString(value.hostname);
  const realtimePriority = booleanValue(value.realtimePriority);
  const memoryLocked = booleanValue(value.memoryLocked);
  if (hostname === undefined || realtimePriority === undefined || memoryLocked === undefined) {
    return undefined;
  }
  return {
    hostname,
    realtimePriority,
    memoryLocked,
    ...optional("kernel", nonEmptyString(value.kernel)),
    ...optional("os", nonEmptyString(value.os)),
    ...optional("cpuModel", nonEmptyString(value.cpuModel)),
    ...optional("cpuCount", finiteNumber(value.cpuCount)),
    ...optional("pinnedCpu", finiteNumber(value.pinnedCpu)),
    ...optional("pinnedCpuKind", nonEmptyString(value.pinnedCpuKind)),
    ...optional("pinnedCpuMaxKHz", finiteNumber(value.pinnedCpuMaxKHz)),
    ...optional("governor", nonEmptyString(value.governor)),
    ...optional("turboEnabled", booleanValue(value.turboEnabled)),
    ...optional("toolchain", readToolchain(value.toolchain)),
  };
}

function readLatencyMethod(value: unknown): LatencyMethod | undefined {
  if (!isRecord(value)) return undefined;
  const method = nonEmptyString(value.method);
  const blockFrames = positiveNumber(value.blockFrames);
  const stimulus = nonEmptyString(value.stimulus);
  const paramSweep = booleanValue(value.paramSweep);
  if (method === undefined || blockFrames === undefined || stimulus === undefined || paramSweep === undefined) {
    return undefined;
  }
  return { method, blockFrames, stimulus, paramSweep };
}

function readCostMethod(value: unknown): CostMethod | undefined {
  if (!isRecord(value)) return undefined;
  const method = nonEmptyString(value.method);
  const blockFrames = positiveNumber(value.blockFrames);
  const warmupBlocks = finiteNumber(value.warmupBlocks);
  const percentile = finiteNumber(value.percentile);
  const stimulus = nonEmptyString(value.stimulus);
  const controls = nonEmptyString(value.controls);
  if (
    method === undefined ||
    blockFrames === undefined ||
    warmupBlocks === undefined ||
    percentile === undefined ||
    stimulus === undefined ||
    controls === undefined
  ) {
    return undefined;
  }
  return {
    method,
    blockFrames,
    warmupBlocks,
    percentile,
    stimulus,
    controls,
    ...optional("minTimedBlocks", finiteNumber(value.minTimedBlocks)),
    ...optional("maxTimedBlocks", finiteNumber(value.maxTimedBlocks)),
    ...optional("targetSecondsPerPlugin", finiteNumber(value.targetSecondsPerPlugin)),
    ...optional("timingFloorNsPerBlock", finiteNumber(value.timingFloorNsPerBlock)),
  };
}

function readRun(value: unknown): MeasurementRun | undefined {
  if (!isRecord(value)) return undefined;
  const id = nonEmptyString(value.id);
  const measuredAt = nonEmptyString(value.measuredAt);
  const host = readHost(value.host);
  const note = nonEmptyString(value.note);
  const relativeRankingOnly = booleanValue(value.relativeRankingOnly);
  const dimensions = mapArray(value.dimensions, readDimension);
  const rates = mapArray(value.rates, positiveNumber);
  const tool = isRecord(value.tool)
    ? { name: nonEmptyString(value.tool.name), version: nonEmptyString(value.tool.version) }
    : undefined;
  if (
    id === undefined ||
    measuredAt === undefined ||
    host === undefined ||
    note === undefined ||
    relativeRankingOnly === undefined ||
    dimensions === undefined ||
    rates === undefined ||
    tool?.name === undefined ||
    tool.version === undefined
  ) {
    return undefined;
  }
  const method = isRecord(value.method) ? value.method : {};
  return {
    id,
    measuredAt,
    dimensions,
    rates: [...rates].sort((a, b) => a - b),
    tool: { name: tool.name, version: tool.version },
    host,
    method: {
      ...optional("latency", readLatencyMethod(method.latency)),
      ...optional("cost", readCostMethod(method.cost)),
    },
    relativeRankingOnly,
    note,
    ...optional("elapsedSeconds", finiteNumber(value.elapsedSeconds)),
    ...optional("label", nonEmptyString(value.label)),
  };
}

function readTopology(value: unknown): PluginTopology | undefined {
  if (!isRecord(value)) return undefined;
  const audioInputs = finiteNumber(value.audioInputs);
  const audioOutputs = finiteNumber(value.audioOutputs);
  if (audioInputs === undefined || audioOutputs === undefined) return undefined;
  return {
    audioInputs,
    audioOutputs,
    ...optional("midiInputs", finiteNumber(value.midiInputs)),
    ...optional("controlInputs", finiteNumber(value.controlInputs)),
  };
}

/**
 * Read a `{ "48000": {...} }` rate map, keeping only entries whose KEY is a positive
 * integer rate and whose value the item reader accepted. A rate key that is not a number
 * is not a rate, and silently keeping it would let `"default"` masquerade as one.
 */
function readRateMap<T>(value: unknown, read: (item: unknown) => T | undefined): Readonly<Record<string, T>> {
  if (!isRecord(value)) return {};
  const out: Record<string, T> = {};
  for (const [key, entry] of Object.entries(value)) {
    const rate = positiveNumber(Number(key));
    if (rate === undefined || !Number.isInteger(rate)) continue;
    const parsed = read(entry);
    if (parsed !== undefined) out[String(rate)] = parsed;
  }
  return out;
}

function readLatencyAtRate(value: unknown): LatencyAtRate | undefined {
  if (!isRecord(value)) return undefined;
  const frames = finiteNumber(value.frames);
  const ms = finiteNumber(value.ms);
  if (frames === undefined || ms === undefined) return undefined;
  return {
    frames,
    ms,
    ...optional("stimulus", nonEmptyString(value.stimulus)),
    ...optional("excludedReason", nonEmptyString(value.excludedReason)),
  };
}

function readSweepControls(value: unknown): Readonly<Record<string, { minFrames: number; maxFrames: number }>> {
  if (!isRecord(value)) return {};
  const out: Record<string, { minFrames: number; maxFrames: number }> = {};
  for (const [symbol, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    const minFrames = finiteNumber(entry.minFrames);
    const maxFrames = finiteNumber(entry.maxFrames);
    if (minFrames === undefined || maxFrames === undefined) continue;
    out[symbol] = { minFrames, maxFrames };
  }
  return out;
}

function readParamSweep(value: unknown): MeasuredParamSweep | undefined {
  if (!isRecord(value)) return undefined;
  const rate = positiveNumber(value.rate);
  const defaultFrames = finiteNumber(value.defaultFrames);
  const minFrames = finiteNumber(value.minFrames);
  const maxFrames = finiteNumber(value.maxFrames);
  if (rate === undefined || defaultFrames === undefined || minFrames === undefined || maxFrames === undefined) {
    return undefined;
  }
  return { rate, defaultFrames, minFrames, maxFrames, controls: readSweepControls(value.controls) };
}

function readLatency(value: unknown): LatencyMeasurement | undefined {
  if (!isRecord(value)) return undefined;
  const perRate = readRateMap(value.perRate, readLatencyAtRate);
  return {
    perRate,
    ...optional("scalingClass", nonEmptyString(value.scalingClass)),
    ...optional("scalingNote", nonEmptyString(value.scalingNote)),
    ...optional("declaredPortSymbol", nonEmptyString(value.declaredPortSymbol)),
    ...optional("declaredFrames", finiteNumber(value.declaredFrames)),
    ...optional("declaredMismatch", booleanValue(value.declaredMismatch)),
    ...optional("paramSweep", readParamSweep(value.paramSweep)),
    ...optional("unmeasuredReason", nonEmptyString(value.unmeasuredReason)),
    ...optional("unmeasuredDetail", nonEmptyString(value.unmeasuredDetail)),
  };
}

function readCostAtRate(value: unknown): CostAtRate | undefined {
  if (!isRecord(value)) return undefined;
  const nsPerSampleMedian = finiteNumber(value.nsPerSampleMedian);
  const nsPerSamplePercentile = finiteNumber(value.nsPerSamplePercentile);
  const blocks = finiteNumber(value.blocks);
  const blockFrames = positiveNumber(value.blockFrames);
  if (
    nsPerSampleMedian === undefined ||
    nsPerSamplePercentile === undefined ||
    blocks === undefined ||
    blockFrames === undefined
  ) {
    return undefined;
  }
  return {
    nsPerSampleMedian,
    nsPerSamplePercentile,
    blocks,
    blockFrames,
    ...optional("nsPerSampleMin", finiteNumber(value.nsPerSampleMin)),
    ...optional("nsPerSampleMax", finiteNumber(value.nsPerSampleMax)),
    ...optional("warmupNsPerSampleMedian", finiteNumber(value.warmupNsPerSampleMedian)),
    ...optional("silentOutput", booleanValue(value.silentOutput)),
  };
}

function readCost(value: unknown): CostMeasurement | undefined {
  if (!isRecord(value)) return undefined;
  return {
    perRate: readRateMap(value.perRate, readCostAtRate),
    ...optional("unmeasuredReason", nonEmptyString(value.unmeasuredReason)),
    ...optional("unmeasuredDetail", nonEmptyString(value.unmeasuredDetail)),
  };
}

function reasonOf(value: Record<string, unknown>): { unmeasuredReason?: string; unmeasuredDetail?: string } {
  return {
    ...optional("unmeasuredReason", nonEmptyString(value.unmeasuredReason)),
    ...optional("unmeasuredDetail", nonEmptyString(value.unmeasuredDetail)),
  };
}

/** A lifecycle reading, or `undefined` unless all three counts are there. */
export function readLifecycle(value: unknown): LifecycleReading | undefined {
  if (!isRecord(value)) return undefined;
  const cycles = finiteNumber(value.cycles);
  const instantiated = finiteNumber(value.instantiated);
  const failed = finiteNumber(value.failed);
  if (cycles === undefined || instantiated === undefined || failed === undefined) return undefined;
  return { cycles, instantiated, failed };
}

/** A thread reading, or `undefined` without its before/after pair. */
export function readThreads(value: unknown): ThreadReading | undefined {
  if (!isRecord(value)) return undefined;
  const before = finiteNumber(value.before);
  const afterFirstInstantiate = finiteNumber(value.afterFirstInstantiate);
  if (before === undefined || afterFirstInstantiate === undefined) return undefined;
  return {
    before,
    afterFirstInstantiate,
    ...optional("afterAllFreed", finiteNumber(value.afterAllFreed)),
    ...optional("leaked", finiteNumber(value.leaked)),
  };
}

function readCrash(value: unknown): CrashReading | undefined {
  if (!isRecord(value)) return undefined;
  return {
    ...optional("signal", nonEmptyString(value.signal)),
    ...optional("topFrame", nonEmptyString(value.topFrame)),
    ...optional("sanitizer", nonEmptyString(value.sanitizer)),
    ...optional("frameObject", nonEmptyString(value.frameObject)),
  };
}

/** One soak rate. Every field optional: a rate that died carries `died` and nothing else. */
export function readSoakAtRate(value: unknown): SoakAtRate | undefined {
  if (!isRecord(value)) return undefined;
  return {
    ...optional("died", booleanValue(value.died)),
    ...optional("instantiated", booleanValue(value.instantiated)),
    ...optional("seconds", finiteNumber(value.seconds)),
    ...optional("blockFrames", positiveNumber(value.blockFrames)),
    ...optional("windows", finiteNumber(value.windows)),
    ...optional("nonFiniteWindows", finiteNumber(value.nonFiniteWindows)),
    ...optional("silentWindows", finiteNumber(value.silentWindows)),
    ...optional("firstRmsDbfs", finiteNumber(value.firstRmsDbfs)),
    ...optional("lastRmsDbfs", finiteNumber(value.lastRmsDbfs)),
    ...optional("minRmsDbfs", finiteNumber(value.minRmsDbfs)),
    ...optional("rssStartKb", finiteNumber(value.rssStartKb)),
    ...optional("rssMaxKb", finiteNumber(value.rssMaxKb)),
    ...optional("rssGrowthKb", finiteNumber(value.rssGrowthKb)),
  };
}

function readSoak(value: unknown): SoakReading | undefined {
  if (!isRecord(value)) return undefined;
  const sweptParams = booleanValue(value.sweptParams);
  if (sweptParams === undefined) return undefined;
  return { sweptParams, perRate: readRateMap(value.perRate, readSoakAtRate) };
}

function readStability(value: unknown): StabilityMeasurement | undefined {
  if (!isRecord(value)) return undefined;
  return {
    ...optional("lifecycle", readLifecycle(value.lifecycle)),
    ...optional("threads", readThreads(value.threads)),
    ...optional("crashes", mapArray(value.crashes, readCrash)),
    ...optional("soak", readSoak(value.soak)),
    ...reasonOf(value),
  };
}

function readRtSafety(value: unknown): RtSafetyMeasurement | undefined {
  if (!isRecord(value)) return undefined;
  return {
    ...optional("rate", positiveNumber(value.rate)),
    ...optional("blockFrames", positiveNumber(value.blockFrames)),
    ...optional("blocks", finiteNumber(value.blocks)),
    ...optional("repeats", finiteNumber(value.repeats)),
    ...optional("interposer", booleanValue(value.interposer)),
    ...optional("swept", booleanValue(value.swept)),
    ...optional("sweepApplicable", booleanValue(value.sweepApplicable)),
    ...optional("allocationsInRun", finiteNumber(value.allocationsInRun)),
    ...optional("allocationsMin", finiteNumber(value.allocationsMin)),
    ...optional("locksInRun", finiteNumber(value.locksInRun)),
    ...optional("syscallsInRun", finiteNumber(value.syscallsInRun)),
    ...optional("variable", booleanValue(value.variable)),
    ...reasonOf(value),
  };
}

function readFeatures(value: unknown): FeaturesMeasurement | undefined {
  if (!isRecord(value)) return undefined;
  return {
    ...optional("required", mapArray(value.required, nonEmptyString)),
    ...optional("optional", mapArray(value.optional, nonEmptyString)),
    ...optional("cvPorts", finiteNumber(value.cvPorts)),
    ...reasonOf(value),
  };
}

function readPlugin(value: unknown): MeasuredPlugin | undefined {
  if (!isRecord(value)) return undefined;
  const uri = nonEmptyString(value.uri);
  const topology = readTopology(value.topology);
  if (uri === undefined || topology === undefined) return undefined;
  return {
    uri,
    topology,
    ...optional("name", nonEmptyString(value.name)),
    ...optional("version", nonEmptyString(value.version)),
    ...optional("bundle", nonEmptyString(value.bundle)),
    ...optional("lv2Class", nonEmptyString(value.lv2Class)),
    ...optional("latency", readLatency(value.latency)),
    ...optional("cost", readCost(value.cost)),
    ...optional("stability", readStability(value.stability)),
    ...optional("rtSafety", readRtSafety(value.rtSafety)),
    ...optional("features", readFeatures(value.features)),
  };
}

/**
 * Read an untrusted value — a parsed JSON file, a wire frame — as a measurement document.
 *
 * Never throws and never casts: every field is validated on the way in and the result is
 * built from the pieces that passed. A document whose major exceeds this build's is
 * REFUSED rather than partially read, because a major bump means a field this reader
 * recognises no longer means what it thinks.
 */
export function readMeasurementDocument(value: unknown): MeasurementReadResult {
  if (!isRecord(value)) {
    return { ok: false, problem: "not-an-object", detail: "expected a JSON object" };
  }
  if (value.format !== MEASUREMENT_FORMAT_ID) {
    return {
      ok: false,
      problem: "wrong-format",
      detail: `expected format "${MEASUREMENT_FORMAT_ID}"`,
      ...optional("found", nonEmptyString(value.format)),
    };
  }
  const version = parseFormatVersion(value.formatVersion);
  if (version === undefined) {
    return {
      ok: false,
      problem: "bad-version",
      detail: 'formatVersion must be "<major>.<minor>"',
      ...optional("found", nonEmptyString(value.formatVersion)),
    };
  }
  if (version.major > MEASUREMENT_FORMAT_MAJOR) {
    return {
      ok: false,
      problem: "future-major",
      detail: `this build understands major ${MEASUREMENT_FORMAT_MAJOR}; reading a newer major would misinterpret it`,
      found: `${version.major}.${version.minor}`,
    };
  }
  const run = readRun(value.run);
  if (run === undefined) {
    return {
      ok: false,
      problem: "missing-run",
      detail: "run provenance is mandatory: a figure without its conditions is not comparable",
    };
  }
  if (!Array.isArray(value.plugins)) {
    return { ok: false, problem: "missing-plugins", detail: "plugins must be an array" };
  }
  const plugins = value.plugins.flatMap((entry) => {
    const plugin = readPlugin(entry);
    return plugin === undefined ? [] : [plugin];
  });
  const judged = readJudged(value);
  const document: MeasurementDocument = {
    format: MEASUREMENT_FORMAT_ID,
    formatVersion: `${version.major}.${version.minor}`,
    run,
    plugins,
    ...(judged === undefined ? {} : { hostProfiles: judged.hostProfiles, verdicts: judged.verdicts }),
  };
  return {
    ok: true,
    document,
    version,
    droppedPlugins: value.plugins.length - plugins.length,
    ...(judged === undefined ? {} : { droppedVerdicts: judged.dropped }),
    ...(version.major === MEASUREMENT_FORMAT_MAJOR && version.minor > MEASUREMENT_FORMAT_MINOR
      ? { forwardMinor: true }
      : {}),
  };
}

/** The v1.2 pair, when the document carries either list; a malformed entry is dropped and counted. */
function readJudged(
  value: Record<string, unknown>,
): { hostProfiles: HostProfile[]; verdicts: DocumentVerdict[]; dropped: number } | undefined {
  if (value.hostProfiles === undefined && value.verdicts === undefined) return undefined;
  const rawProfiles = Array.isArray(value.hostProfiles) ? value.hostProfiles : [];
  const rawVerdicts = Array.isArray(value.verdicts) ? value.verdicts : [];
  const hostProfiles = rawProfiles.flatMap((p) => {
    const r = readHostProfile(p);
    return r.ok ? [r.profile] : [];
  });
  const hosts = new Set(hostProfiles.map((p) => p.id));
  const verdicts = rawVerdicts.flatMap((v) => {
    const r = readVerdict(v, hosts);
    return r === undefined ? [] : [r];
  });
  return {
    hostProfiles,
    verdicts,
    dropped: rawProfiles.length - hostProfiles.length + (rawVerdicts.length - verdicts.length),
  };
}

/**
 * Build a document at THIS build's version.
 *
 * The only supported way to create one: it stamps `format` and `formatVersion` so no call
 * site can write a document claiming a version its content does not match, and it sorts
 * plugins by URI so two runs over the same host produce a diffable file.
 */
export function buildMeasurementDocument(
  run: MeasurementRun,
  plugins: readonly MeasuredPlugin[],
  judged?: { readonly hostProfiles: readonly HostProfile[]; readonly verdicts: readonly DocumentVerdict[] },
): MeasurementDocument {
  return {
    format: MEASUREMENT_FORMAT_ID,
    formatVersion: MEASUREMENT_FORMAT_VERSION,
    run,
    plugins: [...plugins].sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0)),
    ...(judged === undefined ? {} : { hostProfiles: judged.hostProfiles, verdicts: judged.verdicts }),
  };
}

/** Serialise a document: 2-space JSON with a trailing newline, stable across runs. */
export function serialiseMeasurementDocument(document: MeasurementDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Every dimension a run may declare, in presentation order. Re-exported for consumers
 *  that need the list without reaching into the vocabulary module. */
export { MEASUREMENT_DIMENSIONS, type MeasurementDimension };
