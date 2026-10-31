// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The CLAP arm of the one qualifier. `native/clap-qualify` loads a `.clap` under the interposer
 * (`native/rt_interpose.so`), sweeps each plugin at every rate and prints what it MEASURED, one
 * JSON line per plugin; this module runs it, reads those lines strictly, and turns each into the
 * RT-safety verdict document: the binary's SHA-256, the console it was judged for, and the verdict
 * of the `rtSafety` dimension from the same rules `classifyPluginHosting` folds
 * ({@link rtSafetyReasons}, {@link clapRtReasons}) — never a second judge. A line that cannot be
 * read, a prober that is absent, crashed or timed out, is a {@link ClapQualifyError}: nothing was
 * measured, and nothing is rated.
 */
import { existsSync } from "node:fs";

import { CLAP_QUALIFY_TOOL_NAME, RT_INTERPOSE_NAME } from "./qualify-declarations.js";
import {
  HOSTING_CODE,
  clapRtReasons,
  contributedHostingRating,
  noteSweepReasons,
  rtSafetyReasons,
  type ClapLatencyAtRate,
  type HostingReason,
  type PluginClapMeasurement,
  type PluginNoteSweepMeasurement,
  type PluginRtSafetyMeasurement,
  type PluginStabilityMeasurement,
  type QualifiedPlugin,
} from "./hosting-suitability.js";
import {
  OMX_CLAP_HOST_CONFIGURED_EXTENSIONS,
  OMX_CLAP_HOST_EXTENSIONS,
  OPENMIXER_CONSOLE_PROFILE,
  type HostProfile,
} from "./host-profiles.js";
import type { QualifyVerdict } from "./qualify-cli.js";
import { RATING_SEVERITY, worstRating, type SuitabilityRating } from "./rating.js";
import { halfPopulatedRefusal, locateNativeTools } from "./tool-paths.js";
import { readIntegrity, readMemoryFootprint, readTimingScheduling, type IntegrityMeasurement, type MemoryFootprint, type TimingScheduling, type VoicesHeld } from "./measurement/format.js";
import { isVoiceBasis } from "./measurement/vocabulary.js";
import { coreFraction } from "./cost-fields.js";

export class ClapQualifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClapQualifyError";
  }
}

// --- the prober's line ---------------------------------------------------------------------------

/** What the interposer counted; `interposer: false` is a run without it, which counts nothing. */
export interface ClapRtSafetyReading extends PluginRtSafetyMeasurement {
  /** The first events the interposer recorded inside `process()`, by libc call (`malloc`, `pthread_mutex_lock`, ...). */
  readonly events?: readonly string[];
}

/** What the note sweep counted; `applicable: false` is a plugin the prober did not play. */
export interface ClapNoteSweepReading extends PluginNoteSweepMeasurement {
  /** The first events the interposer recorded inside `process()` while the plugin was played. */
  readonly events?: readonly string[];
}

/** The CLAP facts as the prober printed them: the measurement, and whether any output was not finite. */
export interface ClapProbedFacts extends PluginClapMeasurement {
  readonly nonFinite: boolean;
}

/** One rate's cost: the block times in nanoseconds per sample, warm-up dropped, and the notes held for an instrument. */
export interface ClapCostFigure {
  readonly nsPerSampleMedian: number;
  readonly nsPerSampleP95: number;
  readonly nsPerSampleMin: number;
  readonly nsPerSampleMax: number;
  /** The median of the dropped warm-up blocks: the evidence that dropping them was warranted. */
  readonly warmupNsPerSampleMedian: number;
  readonly blocks: number;
  /** For an instrument: the notes held while it was timed. Absent for an effect. */
  readonly voices?: VoicesHeld;
  /** What these blocks were timed under. */
  readonly scheduling?: TimingScheduling;
}

/** One rate the cost arm did not time, and why; an instrument's declared capacity is kept when it has one. */
export interface ClapCostUnmeasured {
  readonly unmeasuredReason: string;
  readonly unmeasuredDetail: string;
  readonly voices?: { readonly capacity: number };
}

export type ClapCostAtRate = ClapCostFigure | ClapCostUnmeasured;

export function isClapCostFigure(at: ClapCostAtRate): at is ClapCostFigure {
  return !("unmeasuredReason" in at);
}

/**
 * The cost arm: every rate timed with every parameter swept, an effect fed noise and an instrument
 * holding notes (`notes-held`), each rate's figures or the reason it has none.
 */
export interface ClapCostReading {
  readonly stimulus: "notes-held" | "noise";
  readonly blockFrames: number;
  readonly warmupBlocks: number;
  /** The percentile `nsPerSampleP95` is taken at. */
  readonly percentile: number;
  readonly perRate: Readonly<Record<string, ClapCostAtRate>>;
  /** What one instance held at each rate (`memory` on the prober's per-rate object), read apart from the timing. */
  readonly memory?: Readonly<Record<string, MemoryFootprint>>;
}

/** One plugin's line from `clap-qualify`. */
export interface ClapQualifyLine {
  readonly uri: string;
  readonly id: string;
  readonly binary: { readonly path: string; readonly sha256: string };
  /** The host extensions the prober offered; the verdict's headless pass holds only for these. */
  readonly hostExtensions: readonly string[];
  readonly clap: ClapProbedFacts;
  readonly rtSafety: ClapRtSafetyReading;
  /** The note sweep: the plugin played through its note input, counted apart. */
  readonly noteSweep: ClapNoteSweepReading;
  /** The cost arm; absent when the plugin did not initialise and activate headless. */
  readonly cost?: ClapCostReading;
  /**
   * The pin (spec §11): the `.clap`'s digest by its name in its directory and the layout fingerprint
   * the prober computed through plugin-hostd's `pin.h`, or the reason it took none.
   */
  readonly integrity: IntegrityMeasurement;
}

const SHA256 = /^[0-9a-f]{64}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return Object.prototype.toString.call(v) === "[object Object]";
}

function bad(what: string): never {
  throw new ClapQualifyError(`clap-qualify printed a line that is not its document: ${what}`);
}

function str(o: Record<string, unknown>, key: string, where: string): string {
  const v = o[key];
  return typeof v === "string" ? v : bad(`${where} has no string ${key}`);
}

function count(o: Record<string, unknown>, key: string, where: string): number {
  const v = o[key];
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : bad(`${where} has no count ${key}`);
}

function bool(o: Record<string, unknown>, key: string, where: string): boolean {
  const v = o[key];
  return typeof v === "boolean" ? v : bad(`${where} has no boolean ${key}`);
}

function strings(o: Record<string, unknown>, key: string, where: string): string[] {
  const v = o[key];
  if (!Array.isArray(v)) return bad(`${where} has no list ${key}`);
  return v.map((s) => (typeof s === "string" ? s : bad(`${where} ${key} holds something that is not a string`)));
}

function readClap(v: unknown): ClapProbedFacts {
  if (!isRecord(v)) return bad("no clap facts");
  const latencyIn = v["latency"];
  if (!isRecord(latencyIn)) return bad("clap has no latency map");
  const latency: Record<string, ClapLatencyAtRate> = {};
  for (const [rate, at] of Object.entries(latencyIn)) {
    if (!/^[1-9]\d*$/.test(rate) || !isRecord(at)) return bad(`clap latency at ${rate}`);
    if (at["from"] !== undefined && at["from"] !== "note") return bad(`clap latency at ${rate} from ${JSON.stringify(at["from"])}`);
    if (at["heard"] !== undefined && (at["from"] !== "note" || at["heard"] !== false)) return bad(`clap latency at ${rate} heard`);
    latency[rate] = {
      declaredFrames: count(at, "declaredFrames", `latency ${rate}`),
      measuredFrames: count(at, "measuredFrames", `latency ${rate}`),
      ...(at["from"] === "note" ? { from: "note" as const } : {}),
      ...(at["heard"] === false ? { heard: false } : {}),
    };
  }
  return {
    mainInputChannels: count(v, "mainInputChannels", "clap"),
    mainOutputChannels: count(v, "mainOutputChannels", "clap"),
    sidechainInputs: count(v, "sidechainInputs", "clap"),
    features: strings(v, "features", "clap"),
    headlessOk: bool(v, "headlessOk", "clap"),
    noteInputs: count(v, "noteInputs", "clap"),
    latency,
    threadViolations: count(v, "threadViolations", "clap"),
    processErrors: count(v, "processErrors", "clap"),
    processCalls: count(v, "processCalls", "clap"),
    nonFinite: bool(v, "nonFinite", "clap"),
  };
}

function readRtSafety(v: unknown): ClapRtSafetyReading {
  if (!isRecord(v)) return bad("no rtSafety");
  if (!bool(v, "interposer", "rtSafety")) return { interposer: false };
  return {
    interposer: true,
    swept: bool(v, "swept", "rtSafety"),
    sweepApplicable: bool(v, "sweepApplicable", "rtSafety"),
    blocks: count(v, "blocks", "rtSafety"),
    blockFrames: count(v, "blockFrames", "rtSafety"),
    allocationsInRun: count(v, "allocationsInRun", "rtSafety"),
    locksInRun: count(v, "locksInRun", "rtSafety"),
    syscallsInRun: count(v, "syscallsInRun", "rtSafety"),
    events: strings(v, "events", "rtSafety"),
  };
}

function readNoteSweep(v: unknown): ClapNoteSweepReading {
  if (!isRecord(v)) return bad("no noteSweep");
  if (!bool(v, "applicable", "noteSweep")) return { applicable: false };
  const dialect = str(v, "dialect", "noteSweep");
  if (dialect !== "clap" && dialect !== "midi") return bad(`noteSweep dialect ${dialect}`);
  const played = {
    applicable: true,
    dialect,
    blocks: count(v, "blocks", "noteSweep"),
    blockFrames: count(v, "blockFrames", "noteSweep"),
    noteEvents: count(v, "noteEvents", "noteSweep"),
    processErrors: count(v, "processErrors", "noteSweep"),
    nonFinite: bool(v, "nonFinite", "noteSweep"),
  } as const;
  if (!bool(v, "interposer", "noteSweep")) return { ...played, interposer: false };
  return {
    ...played,
    interposer: true,
    allocationsInRun: count(v, "allocationsInRun", "noteSweep"),
    locksInRun: count(v, "locksInRun", "noteSweep"),
    syscallsInRun: count(v, "syscallsInRun", "noteSweep"),
    events: strings(v, "events", "noteSweep"),
  };
}

function figure(o: Record<string, unknown>, key: string, where: string): number {
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : bad(`${where} has no figure ${key}`);
}

function readVoices(v: unknown, where: string): { held?: number; basis?: VoicesHeld["basis"]; capacity?: number } {
  if (!isRecord(v)) return bad(`${where} voices is not an object`);
  const out: { held?: number; basis?: VoicesHeld["basis"]; capacity?: number } = {};
  if ("held" in v || "basis" in v) {
    const basis = v["basis"];
    if (!isVoiceBasis(basis)) return bad(`${where} voices basis ${JSON.stringify(basis)}`);
    const held = count(v, "held", `${where} voices`);
    if (held === 0) return bad(`${where} holds no note`);
    out.held = held;
    out.basis = basis;
  }
  if ("capacity" in v) out.capacity = count(v, "capacity", `${where} voices`);
  return out;
}

function readCostAtRate(v: unknown, where: string, notes: boolean): ClapCostAtRate {
  if (!isRecord(v)) return bad(`${where} is not an object`);
  const voices = v["voices"] === undefined ? undefined : readVoices(v["voices"], where);
  if (voices !== undefined && !notes) return bad(`${where} holds notes for a plugin fed noise`);
  if (v["unmeasuredReason"] !== undefined) {
    if (voices?.held !== undefined) return bad(`${where} held notes and timed nothing`);
    return {
      unmeasuredReason: str(v, "unmeasuredReason", where),
      unmeasuredDetail: str(v, "unmeasuredDetail", where),
      ...(voices?.capacity === undefined ? {} : { voices: { capacity: voices.capacity } }),
    };
  }
  if (notes && (voices === undefined || voices.held === undefined || voices.basis === undefined)) {
    return bad(`${where} timed an instrument without saying what it held`);
  }
  const blocks = count(v, "blocks", where);
  if (blocks === 0) return bad(`${where} timed no block`);
  const scheduling = readTimingScheduling(v["scheduling"]);
  return {
    nsPerSampleMedian: figure(v, "nsPerSampleMedian", where),
    nsPerSampleP95: figure(v, "nsPerSampleP95", where),
    nsPerSampleMin: figure(v, "nsPerSampleMin", where),
    nsPerSampleMax: figure(v, "nsPerSampleMax", where),
    warmupNsPerSampleMedian: figure(v, "warmupNsPerSampleMedian", where),
    blocks,
    ...(voices?.held === undefined || voices.basis === undefined
      ? {}
      : { voices: { held: voices.held, basis: voices.basis, ...(voices.capacity === undefined ? {} : { capacity: voices.capacity }) } }),
    ...(scheduling === undefined ? {} : { scheduling }),
  };
}

function readCost(v: unknown): ClapCostReading {
  if (!isRecord(v)) return bad("cost is not an object");
  const stimulus = str(v, "stimulus", "cost");
  if (stimulus !== "notes-held" && stimulus !== "noise") return bad(`cost stimulus ${stimulus}`);
  const perRateIn = v["perRate"];
  if (!isRecord(perRateIn)) return bad("cost has no perRate map");
  const perRate: Record<string, ClapCostAtRate> = {};
  const memory: Record<string, MemoryFootprint> = {};
  for (const [rate, at] of Object.entries(perRateIn)) {
    if (!/^[1-9]\d*$/.test(rate)) return bad(`cost rate ${rate}`);
    perRate[rate] = readCostAtRate(at, `cost at ${rate}`, stimulus === "notes-held");
    const footprint = isRecord(at) ? readMemoryFootprint(at["memory"]) : undefined;
    if (footprint !== undefined) memory[rate] = footprint;
  }
  return {
    stimulus,
    blockFrames: count(v, "blockFrames", "cost"),
    warmupBlocks: count(v, "warmupBlocks", "cost"),
    percentile: figure(v, "percentile", "cost"),
    perRate,
    ...(Object.keys(memory).length === 0 ? {} : { memory }),
  };
}

/**
 * The cost arm's figures as the classifier's cost gate reads them, per rate: the median and the P95
 * per sample, and the P95 as a fraction of one core at that rate. A rate the arm did not time is absent.
 */
export function clapCostPerRate(
  cost: ClapCostReading | undefined,
): Record<string, { coreFractionP95: number; nsPerSampleMedian: number; nsPerSampleP95: number; voices?: VoicesHeld }> {
  const out: Record<string, { coreFractionP95: number; nsPerSampleMedian: number; nsPerSampleP95: number; voices?: VoicesHeld }> = {};
  for (const [rate, at] of Object.entries(cost?.perRate ?? {})) {
    if (!isClapCostFigure(at)) continue;
    const fraction = coreFraction(at.nsPerSampleP95, Number(rate));
    if (fraction === undefined) continue;
    out[rate] = {
      coreFractionP95: fraction,
      nsPerSampleMedian: at.nsPerSampleMedian,
      nsPerSampleP95: at.nsPerSampleP95,
      ...(at.voices === undefined ? {} : { voices: at.voices }),
    };
  }
  return out;
}

/**
 * A prober line as the plugin the full classifier (`classifyPluginHosting`) reads: the CLAP facts, the
 * interposer's counts with the note sweep beside them, and the cost arm's figures per rate. The prober
 * measures no stability (that is the soak's), so the caller passes what it has; without it the verdict
 * is `unknown` on stability, never a pass.
 */
export function qualifiedPluginOfClapLine(line: ClapQualifyLine, stability?: PluginStabilityMeasurement): QualifiedPlugin {
  const { events: _events, ...rtSafety } = line.rtSafety;
  const { events: _noteEvents, ...noteSweep } = line.noteSweep;
  const { nonFinite: _nonFinite, ...clap } = line.clap;
  return {
    format: "clap",
    audioInputs: line.clap.mainInputChannels,
    audioOutputs: line.clap.mainOutputChannels,
    hasMidiIn: line.clap.noteInputs > 0,
    clap,
    rtSafety: { ...rtSafety, noteSweep },
    cpuCost: { perRate: clapCostPerRate(line.cost) },
    ...(line.cost?.memory === undefined ? {} : { memory: { perRate: line.cost.memory } }),
    ...(stability === undefined ? {} : { stability }),
  };
}

/** One line of the prober's stdout, or a {@link ClapQualifyError} saying how it differs. */
export function parseClapQualifyLine(text: string): ClapQualifyLine {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return bad("not JSON");
  }
  if (!isRecord(v)) return bad("not an object");
  if (v["format"] !== "clap") return bad(`format is ${JSON.stringify(v["format"])}`);
  const id = str(v, "id", "the line");
  const uri = str(v, "uri", "the line");
  if (uri !== `urn:clap:${id}`) return bad(`uri ${uri} is not urn:clap:${id}`);
  const binary = v["binary"];
  if (!isRecord(binary)) return bad("no binary");
  const sha256 = str(binary, "sha256", "binary");
  if (!SHA256.test(sha256)) return bad(`binary sha256 ${sha256} is not 64 lowercase hex digits`);
  return {
    uri,
    id,
    binary: { path: str(binary, "path", "binary"), sha256 },
    hostExtensions: strings(v, "hostExtensions", "the line"),
    clap: readClap(v["clap"]),
    rtSafety: readRtSafety(v["rtSafety"]),
    noteSweep: readNoteSweep(v["noteSweep"]),
    ...(v["cost"] === undefined ? {} : { cost: readCost(v["cost"]) }),
    integrity: readIntegrity(v["integrity"]) ?? bad("no integrity"),
  };
}

/** Every non-empty line of the prober's stdout. */
export function parseClapQualifyOutput(stdout: string): ClapQualifyLine[] {
  return stdout.split("\n").filter((l) => l.trim() !== "").map(parseClapQualifyLine);
}

// --- the verdict document ------------------------------------------------------------------------

/**
 * The document's schema name; a reader refuses any other it does not know. `/2` is `/1` with
 * `measured.noteSweep` added and the note sweep's reasons folded into `verdict` (a plugin with no
 * note input gets none, so its `/2` verdict is its `/1` verdict); every `/1` field is unchanged, so
 * a `/1` reader of `verdict.rating` and `verdict.rtSafe` reads a `/2` document right. `/3` is `/2`
 * with `measured.cost` added (the cost arm, an instrument's with the notes it held), which no
 * verdict reads.
 */
export const RT_SAFETY_DOCUMENT_SCHEMA = "plugin-qualify.rt-safety/3";

/**
 * The RT-safety verdict of one plugin binary for one console: keyed by the binary's SHA-256 and
 * the host profile id, so a verdict never outlives the bytes it was measured on. `measured` is what
 * the prober printed, raw; `verdict` is the `rtSafety` dimension's worst-wins fold of it.
 */
export interface RtSafetyDocument {
  readonly schema: typeof RT_SAFETY_DOCUMENT_SCHEMA;
  readonly plugin: {
    readonly uri: string;
    readonly format: "clap";
    readonly binary: { readonly path: string; readonly sha256: string };
  };
  /** The host profile the verdict is for. */
  readonly console: string;
  readonly verdict: {
    readonly rating: SuitabilityRating;
    /** `rating === "suitable"` — in-process only with it. */
    readonly rtSafe: boolean;
    /** The ONE reason that decided it; absent when suitable. */
    readonly deciding?: HostingReason;
    readonly reasons: readonly HostingReason[];
  };
  readonly measured: {
    readonly hostExtensions: readonly string[];
    readonly clap: ClapProbedFacts;
    readonly rtSafety: ClapRtSafetyReading;
    readonly noteSweep: ClapNoteSweepReading;
    readonly cost?: ClapCostReading;
    readonly integrity: IntegrityMeasurement;
  };
}

/**
 * The verdict document for one prober line under one host profile. The interposer's counts and the
 * two violations only a CLAP commits decide it. The line is judged against the profile's own CLAP
 * host extensions: a line from a prober that offered others is not that host's measurement, and a
 * host with no CLAP path has none; both read `unknown`.
 */
export function rtSafetyDocument(line: ClapQualifyLine, profile: HostProfile = OPENMIXER_CONSOLE_PROFILE): RtSafetyDocument {
  const offered = profile.clapExtensions;
  const offeredAsProfile =
    offered !== null && line.hostExtensions.length === offered.length && offered.every((e) => line.hostExtensions.includes(e));
  const reasons: HostingReason[] =
    offered === null
      ? [{ dimension: "rtSafety", kind: "objective", rating: "unknown", code: HOSTING_CODE.clapFormatNotHosted, params: {} }]
      : offeredAsProfile
        ? [...rtSafetyReasons(line.rtSafety), ...clapRtReasons(line.clap), ...noteSweepReasons(line.noteSweep, line.clap.noteInputs)]
        : [
            {
              dimension: "rtSafety",
              kind: "objective",
              rating: "unknown",
              code: HOSTING_CODE.clapExtensionsNotCovered,
              params: { extensions: line.hostExtensions.join(" ") },
            },
          ];
  const rating = worstRating(reasons.map(contributedHostingRating));
  const deciding = [...reasons]
    .sort((a, b) => RATING_SEVERITY[contributedHostingRating(b)] - RATING_SEVERITY[contributedHostingRating(a)])
    .find((r) => contributedHostingRating(r) === rating);
  return {
    schema: RT_SAFETY_DOCUMENT_SCHEMA,
    plugin: { uri: line.uri, format: "clap", binary: line.binary },
    console: profile.id,
    verdict: { rating, rtSafe: rating === "suitable", ...(rating === "suitable" || deciding === undefined ? {} : { deciding }), reasons },
    measured: {
      hostExtensions: line.hostExtensions,
      clap: line.clap,
      rtSafety: line.rtSafety,
      noteSweep: line.noteSweep,
      ...(line.cost === undefined ? {} : { cost: line.cost }),
      integrity: line.integrity,
    },
  };
}

/** The document as the CLI's verdict row. */
export function rtSafetyVerdict(doc: RtSafetyDocument): QualifyVerdict {
  return {
    uri: doc.plugin.uri,
    host: doc.console,
    measured: true,
    rating: doc.verdict.rating,
    qualified: doc.verdict.rtSafe,
    ...(doc.verdict.deciding === undefined ? {} : { deciding: doc.verdict.deciding.code }),
  };
}

/** Where a document is written in `--out`: one file per binary and console. */
export function rtSafetyDocumentName(doc: RtSafetyDocument): string {
  return `${doc.plugin.binary.sha256}.${doc.console}.rt-safety.json`;
}

// --- the prober and the interposer a run uses ---------------------------------------------------

/**
 * The prober and the interposer this run uses: each its setting, else both from one place, the
 * package's own build or else the first installed directory (`NATIVE_TOOL_DIRS`) holding them
 * (`locateNativeTools`). Absent, or half there, it throws, naming where it looked.
 */
export function clapQualifyTools(
  env: Readonly<Record<string, string | undefined>>,
  exists: (path: string) => boolean = existsSync,
): { tool: string; interposer: string } {
  const { tools, halfPopulated } = locateNativeTools([CLAP_QUALIFY_TOOL_NAME, RT_INTERPOSE_NAME], env, exists);
  if (halfPopulated !== undefined) throw new ClapQualifyError(`no CLAP prober and interposer pair: ${halfPopulatedRefusal(halfPopulated)}`);
  const [tool, interposer] = tools.map(({ path, looked, setting }, i) => {
    if (path === undefined) {
      const what = i === 0 ? "prober" : "interposer";
      throw new ClapQualifyError(`no CLAP ${what} at ${looked.join(", ")}: install the plugin-qualify package, build it with make -C native, or set ${setting}`);
    }
    return path;
  });
  return { tool: tool!, interposer: interposer! };
}

/**
 * What the prober must offer beyond the console's extensions to measure for `profile`: the extra
 * extensions of its list, when the prober can offer each and the list holds the console's; `undefined`
 * for a profile the prober cannot stand in for (no CLAP path, or an extension it cannot offer), which
 * is judged from the console's run and reads `unknown` there.
 */
export function proberOffer(profile: HostProfile): readonly string[] | undefined {
  const wanted = profile.clapExtensions;
  if (wanted === null || !OMX_CLAP_HOST_EXTENSIONS.every((e) => wanted.includes(e))) return undefined;
  const extra = wanted.filter((e) => !OMX_CLAP_HOST_EXTENSIONS.includes(e));
  if (!extra.every((e) => OMX_CLAP_HOST_CONFIGURED_EXTENSIONS.includes(e))) return undefined;
  return OMX_CLAP_HOST_CONFIGURED_EXTENSIONS.filter((e) => extra.includes(e));
}
