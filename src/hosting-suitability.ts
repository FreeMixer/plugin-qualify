// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Which HOST a plugin has earned: the console's own RT thread, or a `mod-host` process.
 *
 * "Thoroughly tested" is not a hand list and never an author's opinion. It is the derived
 * verdict `hosting.rating === "suitable"`, computed on every read from measurements the
 * catalog holds. `path` follows the rating and nothing else: `suitable` earns `in-process`,
 * every rating below it is `isolated` with the reasons that decided it.
 *
 * The shape mirrors {@link import('./destination-suitability.js').classifyForRole} because
 * the same law governs both — a standing is DERIVED, absence is an admission rather than a
 * pass, and an override may only ever demote. What differs is the stake. A destination
 * verdict that is wrong puts a reverb in a wedge; a hosting verdict that is wrong puts an
 * untested plugin on the thread the whole desk's audio runs on, where its crash is not its
 * own. So every dimension here fails CLOSED: no measurement means `unknown`, and `unknown`
 * means isolated.
 */
import {
  RATING_SEVERITY,
  worstRating,
  type SuitabilityKind,
  type SuitabilityRating,
} from "./rating.js";
import type {
  FeaturesMeasurement,
  LifecycleReading,
  RtSafetyMeasurement,
  SoakAtRate,
  SoakReading,
  ThreadReading,
} from "./measurement/format.js";
import { memoryWithinBudget, type MemoryReadings } from "./memory-budget.js";

/**
 * What a reason may interpolate: wire-serialisable scalars only. Structurally the same record as
 * the console's coded-refusal parameters, so a consumer passes it straight through.
 */
export type CodedRefusalParams = Readonly<Record<string, string | number>>;

/**
 * The plugin the rating reads — exactly the fields it judges, and nothing a host's own catalog
 * adds. The console's plugin descriptor satisfies it structurally; the standalone CLI
 * builds it from the scan and the interchange document.
 */
export interface QualifiedPlugin {
  readonly audioInputs: number;
  readonly audioOutputs: number;
  readonly hasMidiIn: boolean;
  /** The benchmark's latency block; only whether it resolved, conforms and moves is read. */
  readonly latency?: {
    readonly unmeasurable?: unknown;
    readonly scalingClass?: string;
    readonly paramSweep?: unknown;
  };
  /** Measured cost: per rate (Hz as a string key), or per rate AND quantum. */
  readonly cpuCost?: {
    /** One figure per rate, at the block the prober ran: the old format. Read only when `perRateQuantum` is absent. */
    readonly perRate?: Readonly<
      Record<string, { readonly coreFractionP95: number; readonly nsPerSampleMedian: number; readonly nsPerSampleP95: number }>
    >;
    /**
     * One figure per rate and quantum, keyed by {@link costPointKey}: a probe output's grid. When this is
     * present it is the only cost there is, so a pair it lacks is unmeasured, never read from `perRate`.
     */
    readonly perRateQuantum?: Readonly<
      Record<string, { readonly coreFractionP95: number; readonly nsPerSampleMedian: number; readonly nsPerSampleP95: number }>
    >;
  };
  readonly stability?: PluginStabilityMeasurement;
  readonly rtSafety?: PluginRtSafetyMeasurement;
  readonly lv2Features?: PluginLv2Features;
  /** The plugin's binary format, the scan's declared fact (CLAP spec §6); absent reads `lv2`. */
  readonly format?: "lv2" | "clap";
  /** What one instance holds: per rate, or per rate AND quantum as {@link cpuCost} has it. A missing cell is unmeasured. */
  readonly memory?: MemoryReadings;
  /** What the CLAP prober (`native/clap-qualify`) measured, for a `clap` plugin (CLAP spec §3). */
  readonly clap?: PluginClapMeasurement;
}

/** Where a plugin's audio is actually processed. */
export type HostingPath = "in-process" | "isolated";

/** The dimensions that decide a host, folded worst-wins. */
export type HostingDimension =
  | "stability"
  | "rtSafety"
  | "features"
  | "cost"
  | "latency"
  | "topology"
  | "memory";

// The in-process feature list and the CLAP host extensions are the `openmixer-console` host
// profile's; they live with the profiles (`host-profiles.ts`) and are re-exported here, where the
// native test (`lv2-inprocess-features.sh`) and the contract-limits render read them.
export { OMX_CLAP_HOST_EXTENSIONS, OMX_INPROCESS_FEATURES, OPENMIXER_CONSOLE_PROFILE, type HostProfile } from "./host-profiles.js";
import { OMX_CLAP_HOST_EXTENSIONS, OMX_INPROCESS_FEATURES, OPENMIXER_CONSOLE_PROFILE, type HostProfile } from "./host-profiles.js";

/** The catalog key of a CLAP plugin is `urn:clap:<clap_plugin_descriptor.id>` (CLAP spec §6). */
export const CLAP_URI_PREFIX = "urn:clap:";

/** Whether `uri` is a CLAP catalog key — the key grammar, for a plugin the catalog may not hold. */
export function isClapUri(uri: string): boolean {
  return uri.startsWith(CLAP_URI_PREFIX);
}

/**
 * Whether the plugin `uri` names is hosted through the CLAP path: the descriptor's DECLARED
 * format where the catalog holds one, else the key grammar (a `urn:clap:` uri the catalog never
 * scanned is still a CLAP the console has no LV2 host for).
 */
export function isClapPlugin(uri: string, descriptor: Pick<QualifiedPlugin, "format"> | undefined): boolean {
  return descriptor?.format === "clap" || (descriptor?.format === undefined && isClapUri(uri));
}

/** The CLAP descriptor feature that makes a plugin an audio effect (`clap/plugin-features.h`). */
export const CLAP_FEATURE_AUDIO_EFFECT = "audio-effect";

/** The CLAP descriptor feature that makes a plugin an instrument (`clap/plugin-features.h`). */
export const CLAP_FEATURE_INSTRUMENT = "instrument";

/**
 * Features that disqualify outright rather than merely being unprovided: they need a host we
 * are not and will not become inside the RT thread.
 */
const DISQUALIFYING_FEATURES: readonly string[] = [
  "http://lv2plug.in/ns/ext/instance-access",
  "http://lv2plug.in/ns/ext/data-access",
  "http://lv2plug.in/ns/extensions/ui#idleInterface",
];

/** Providable only while the console pins its quantum; without a pinned quantum they are
 *  promises the stage cannot keep, and §3 conditions them on exactly that. */
const QUANTUM_PINNED_FEATURES: readonly string[] = [
  "http://lv2plug.in/ns/ext/buf-size#fixedBlockLength",
  "http://lv2plug.in/ns/ext/buf-size#powerOf2BlockLength",
];

/**
 * Promises the adapter keeps independent of what the profile's in-process list offers: the
 * adapter's ports are its own memory, so `lv2:inPlaceBroken` always holds (omx-clap-core #94).
 */
const ALWAYS_MET_FEATURES: readonly string[] = ["http://lv2plug.in/ns/lv2core#inPlaceBroken"];

/** The verdict's message codes, declared in their union list file. */
import { HOSTING_CODE } from "./hosting-codes.js";
export { HOSTING_CODE };

export type HostingCode = (typeof HOSTING_CODE)[keyof typeof HOSTING_CODE];

/**
 * The refusals libomx-clap-core returns from `open`, `activate` and the timed open, each named by the KEY of the
 * `HOSTING_CODE` it answers with — never by the string, so no second spelling of a code exists. The console's
 * generator renders them into omx-clap-host's `clap_host_limits.h` as `CLAP_HOST_CODE_<NAME>`, the left column's
 * name in upper snake case. The facts the qualifier judges from a measurement (latency, thread violations, process
 * errors, RT safety) are the console's and are not here.
 */
export const CLAP_CORE_REFUSALS = {
  headlessFailed: "clapHeadlessFailed",
  noteInput: "clapNoteInput",
  noAudioInput: "topologyNoAudioInput",
  noAudioOutput: "topologyNoAudioOutput",
  widerThanStrip: "topologyWiderThanStrip",
  tooManyPorts: "topologyTooManyPorts",
  crashedLive: "stabilityCrashedLive",
  outputNonFinite: "outputNonFinite",
} as const satisfies Record<string, keyof typeof HOSTING_CODE>;

/**
 * One line per refusal, rendered as the `///<` comment on its `CLAP_HOST_CODE_<NAME>` define in
 * omx-clap-host's `clap_host_limits.h` (spec mod-host-clap-backend §10.4), declared here beside the
 * refusal so the renderer holds no prose. A refusal without a line renders bare.
 */
export const CLAP_CORE_REFUSAL_DESCRIPTIONS: { readonly [K in keyof typeof CLAP_CORE_REFUSALS]?: string } = {
  noteInput: "the plugin declares a note input the configuration refuses",
  noAudioInput: "the plugin has no audio input",
  noAudioOutput: "the plugin has no audio output",
  widerThanStrip: "the plugin is wider than the strip",
  tooManyPorts: "the plugin has more ports than the auxiliary limit allows",
  crashedLive: "the plugin crashed live on this rig",
  outputNonFinite: "the plugin produced non-finite output",
};

/** One dimension's answer for one plugin. */
export interface HostingReason {
  readonly dimension: HostingDimension;
  readonly kind: SuitabilityKind;
  readonly rating: SuitabilityRating;
  readonly code: HostingCode;
  readonly params: CodedRefusalParams;
}

/**
 * What a reason may contribute. Unlike the destination classifier, every reason here is
 * objective — there is no taste in whether a plugin allocates inside `run()`. The cautions
 * that look advisory (`spawns-threads`, `links-gui-toolkit`) are MEASURED facts, so they are
 * objective too and cap the plugin at `conditional` by their own rating rather than by a kind
 * rule. An advisory reason, if one is ever added, may never do worse than `conditional`.
 */
export function contributedHostingRating(reason: HostingReason): SuitabilityRating {
  if (reason.kind === "advisory" && RATING_SEVERITY[reason.rating] > RATING_SEVERITY.conditional) {
    return "conditional";
  }
  return reason.rating;
}

/** How a crash was attributed. `unknown` is the default and derives `unknown`, never blame. */
export type CrashAttribution = "plugin" | "host" | "unknown";

/** One row of the signature table: a crash shape we have seen and named. */
export interface CrashSignature {
  readonly id: string;
  readonly attribution: CrashAttribution;
  /** The top plugin-owned stack frame, or a host frame that exonerates the plugin. */
  readonly topFrame: string;
  readonly signal?: "SIGSEGV" | "SIGABRT" | "SIGBUS";
  /** What was found about this cluster. Provenance, so a row is never folklore. */
  readonly note: string;
}

/**
 * Seeded from the crashes investigated on 2026-09-03/04. A raw crash matching NO row is
 * `unknown` — the table blames a plugin only where a named investigation did.
 */
export const CRASH_SIGNATURES: readonly CrashSignature[] = [
  {
    id: "pipewire-jack-close-double-free",
    attribution: "host",
    topFrame: "pw_memmap_free",
    signal: "SIGSEGV",
    note: "closing a PipeWire JACK client frees a memory map twice; the host crashes, not the plugin",
  },
  {
    id: "pipewire-jack-close-double-free-abort",
    attribution: "host",
    topFrame: "tcache_double_free_verify",
    signal: "SIGABRT",
    note: "the same double free in PipeWire's JACK client close, caught by glibc's tcache check as an abort",
  },
  {
    id: "mod-host-effects-remove",
    attribution: "host",
    topFrame: "effects_remove",
    note: "mod-host crashes in effects_remove while removing an effect; the host is at fault",
  },
  {
    id: "plugin-instantiate-layout",
    attribution: "plugin",
    topFrame: "lilv_instance_instantiate",
    note: "the plugin crashes while lilv instantiates it, on a port layout it cannot host",
  },
];

/** A crash as observed, before attribution. */
export interface ObservedCrash {
  readonly signal?: "SIGSEGV" | "SIGABRT" | "SIGBUS";
  readonly topFrame?: string;
  /** The sanitizer's error class, when a sanitizer build caught it (interchange §3a). */
  readonly sanitizer?: string;
  /** Basename of the object the faulting frame lies in. */
  readonly frameObject?: string;
}

/**
 * Map a raw crash to blame. Fails to `unknown`: a signature must match the frame AND, where
 * the row names one, the signal. An unmatched crash never reads as the plugin's fault.
 */
export function attributeCrash(
  crash: ObservedCrash,
  table: readonly CrashSignature[] = CRASH_SIGNATURES,
  pluginBinary?: string,
): CrashAttribution {
  // A sanitizer caught a memory error and the faulting frame is in the plugin's OWN binary:
  // that is the plugin's (plugin-qualify spec §2 — the #98 zero-size atom:Path overread).
  if (
    crash.sanitizer !== undefined &&
    pluginBinary !== undefined &&
    crash.frameObject === pluginBinary
  ) {
    return "plugin";
  }
  if (crash.topFrame === undefined) return "unknown";
  for (const row of table) {
    if (row.topFrame !== crash.topFrame) continue;
    if (row.signal !== undefined && crash.signal !== undefined && row.signal !== crash.signal) {
      continue;
    }
    return row.attribution;
  }
  return "unknown";
}

/**
 * What a lifecycle sweep MEASURED about a plugin surviving — the interchange format's stability
 * block as it lands on a descriptor (`measurement-catalog.ts`), RAW: the cycles as run, the
 * threads as counted, the crashes as observed, the soak per rate as rendered. Whether any of that
 * adds up to a pass is {@link stabilityReasons}' to say, and nobody else's.
 */
export interface PluginStabilityMeasurement {
  readonly lifecycle?: LifecycleReading;
  readonly threads?: ThreadReading;
  readonly crashes?: readonly ObservedCrash[];
  /** A continuous render per rate with the controls swept — judged at EVERY rate it ran. */
  readonly soak?: SoakReading;
  readonly linksGuiToolkit?: boolean;
  /** Recorded when a live console's pre-rack trial or a show killed it. */
  readonly crashedLive?: boolean;
  /** The host the figures were taken on — the run's, set by the door that landed them. */
  readonly runHost?: string;
}

/**
 * The interposer's counts inside `run()`, RAW, with the pair it ran at and the flags that say
 * whether the count is a measurement at all ({@link rtSafetyMeasured}) — the interchange's
 * rt-safety block as it lands, minus the reason a block with no reading carries instead.
 */
export type PluginRtSafetyMeasurement = Omit<RtSafetyMeasurement, "unmeasuredReason" | "unmeasuredDetail">;

/** What the plugin DEMANDS of a host, read off the instance the sweep loaded. */
export type PluginLv2Features = Omit<FeaturesMeasurement, "unmeasuredReason" | "unmeasuredDetail">;

export { DEFAULT_HOSTING_POLICY, type HostingPolicy } from "./qualify-declarations.js";
import { DEFAULT_HOSTING_POLICY, type HostingPolicy } from "./qualify-declarations.js";
import { costFieldsMissing, costPointKey } from "./cost-fields.js";

/** One declared rate's latency reading from the CLAP qualifier (CLAP spec §3, latency). */
export interface ClapLatencyAtRate {
  /** `latency.get()` after `activate` at this rate; a plugin without the ext declares 0. */
  readonly declaredFrames: number;
  /** Where the qualifier's impulse landed through `process()`, in frames; for an instrument, where a note's
   *  sound began. */
  readonly measuredFrames: number;
  /** `note`: a plugin with no main audio input, measured from a note struck at frame 0 (the onset of its
   *  sound, which an attack envelope may put later than its latency). Absent: from an impulse. */
  readonly from?: "note";
  /** `false`: the note was struck and nothing was heard, so there is no onset to read. */
  readonly heard?: boolean;
}

/**
 * What the CLAP prober (`native/clap-qualify`) MEASURED about a CLAP plugin, RAW (CLAP spec §3): the facts the CLAP
 * arm of each dimension reads. Whether any of it earns `suitable` is the `clap*Reasons` arms' to say.
 */
export interface PluginClapMeasurement {
  /** Main audio ports: channel counts of the ONE main input and ONE main output the qualifier
   *  found (0 where none); `sidechainInputs` counts non-main audio inputs. */
  readonly mainInputChannels: number;
  readonly mainOutputChannels: number;
  readonly sidechainInputs: number;
  /** `clap_plugin_descriptor.features`, as declared. */
  readonly features: readonly string[];
  /** `init()` and `activate()` both succeeded HEADLESS, with only OMX_CLAP_HOST_EXTENSIONS offered. */
  readonly headlessOk: boolean;
  /** Note input ports the `note-ports` ext declares (0 where the ext is absent). */
  readonly noteInputs: number;
  /** Declared vs measured latency at every declared rate, keyed by the rate's decimal string. */
  readonly latency: Readonly<Record<string, ClapLatencyAtRate>>;
  /** Strict `thread-check` violations counted across the sweep. */
  readonly threadViolations: number;
  /** `CLAP_PROCESS_ERROR` returns counted across the sweep. */
  readonly processErrors: number;
  /** `process()` calls the sweep made after its warm-up; a sweep of 0 measured nothing. */
  readonly processCalls: number;
}

/**
 * The note sweep of a CLAP plugin with a note input (plugin-qualify's prober): the plugin played at
 * every rate — a chord, bend and a controller, pressure, the chord let go, a burst of note ons and
 * their offs, all notes off — in the dialect its first note input reads, counted under the
 * interposer apart from the parameter sweep. `applicable: false` is a plugin the prober could not
 * play: no note input, or none in a dialect it speaks.
 */
export interface PluginNoteSweepMeasurement {
  readonly applicable: boolean;
  readonly dialect?: "clap" | "midi";
  readonly blocks?: number;
  readonly blockFrames?: number;
  /** Note, expression and MIDI events the sweep sent. */
  readonly noteEvents?: number;
  readonly processErrors?: number;
  readonly nonFinite?: boolean;
  readonly interposer?: boolean;
  readonly allocationsInRun?: number;
  readonly locksInRun?: number;
  readonly syscallsInRun?: number;
}

/** What the classifier is told about the console asking. */
export interface HostingClassifyOptions {
  /** The LIVE rate. Cost is read here and nowhere else — never projected. */
  readonly rate: number;
  /** The LIVE quantum in frames, when the console pins one. */
  readonly quantum?: number;
  /** Basename of the plugin's own binary, when known: a sanitizer error faulting there is the plugin's. */
  readonly pluginBinary?: string;
  readonly policy?: HostingPolicy;
  /** Curator override. `isolated` is the ONLY legal value; see {@link assertHostingOverride}. */
  readonly override?: "isolated";
  /** The host the console is actually running, to compare against the figures' provenance. */
  readonly consoleHost?: string;
  /** False when the sweep's positive control did not fire — poisons the whole verdict. */
  readonly sweepControlFired?: boolean;
  /** The host judged against (plugin-qualify §3a). Absent: `openmixer-console`, the console's own. */
  readonly profile?: HostProfile;
}

/** The verdict, and everything that produced it. */
export interface PluginHosting {
  readonly rating: SuitabilityRating;
  readonly path: HostingPath;
  readonly reasons: readonly HostingReason[];
  /** The ONE reason that decided it: the worst, first-listed. Undefined when suitable. */
  readonly deciding?: HostingReason;
}

function reason(
  dimension: HostingDimension,
  kind: SuitabilityKind,
  rating: SuitabilityRating,
  code: HostingCode,
  params: CodedRefusalParams = {},
): HostingReason {
  return { dimension, kind, rating, code, params };
}

/**
 * Refuse an illegal override at the door. A curator may take a plugin OFF the RT thread and
 * may never put one on it — no measurement, no in-process, and no "force" exists anywhere.
 * Throws rather than coercing, because silently demoting a bad value would hide the mistake.
 */
export function assertHostingOverride(value: unknown, where: string): "isolated" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "isolated") return "isolated";
  throw new Error(
    `${where}: hostingOverride may only be "isolated" (got ${JSON.stringify(value)}). ` +
      `An override can demote a plugin to the isolated host; it can never grant in-process ` +
      `hosting, which is earned from measurements alone.`,
  );
}

/**
 * The level at which a rate is DEAD against the plugin's own best: `policy.soakDeadDropDb` or
 * more below it. A ratio against the plugin itself, never an absolute floor — a quiet plugin is
 * not a dead one. The one application of that threshold; the soak rule below and the report's
 * short-render column both ask it.
 */
export function deadAgainstBest(levelDbfs: number, bestDbfs: number, policy: HostingPolicy): boolean {
  return bestDbfs > -Infinity && levelDbfs < bestDbfs - policy.soakDeadDropDb;
}

/** The classes of soak failure, as the strings `failures` is built from. */
export type SoakFailureKind = "died" | "non-finite" | "dead" | "mostly-silent" | "startup-blast" | "timed-out" | "leaks";

export interface SoakFailure {
  readonly rate: number;
  readonly kind: SoakFailureKind;
  /** Extra words for the string form, e.g. `20dBFS`. */
  readonly detail?: string;
  /** For `leaks`: what the growth was and the ceiling it passed, which the reason carries. */
  readonly params?: CodedRefusalParams;
}

/** A soak's reading: what voided it, if anything, and what it proved when nothing did. */
export interface SoakFindings {
  /** The SHORTEST rate's seconds — a soak proves no more than its weakest rate ran. */
  readonly seconds: number;
  /** Every rate that voids the soak, as `<why>@<rate>` — `died@`, `non-finite@`, `dead@`, `mostly-silent@`, `startup-blast@`, `timed-out@`. */
  readonly failures: readonly string[];
  /** The same failures, structured — what the per-rate verdict reads. `timed-out` is the supervisor's
   *  cut, a fact about the harness: it voids the soak but is never a failure of the plugin. */
  readonly failed: readonly SoakFailure[];
  readonly ratesTested: number;
  /** The largest RSS growth across rates, warm-up included, for the record; `leaks` is what is judged. */
  readonly rssGrowthKb: number;
}

/** A soak rate that settled or opened ABOVE this is blasting: it voids the soak, and a rate
 *  settled above it cannot be the reference, or every sane rate reads dead against it. */
const BLAST_DBFS = 6;

/**
 * The growth a rate's soak is still showing, in KB per minute of audio: from halfway past warm-up to its highest reading,
 * so that a library that finishes loading a little late is not a leak and a leak of any size is. `undefined` when the soak
 * did not reach those readings: not read as flat.
 */
export function soakGrowthKbPerMin(v: SoakAtRate): number | undefined {
  const { rssMidKb, midSeconds, rssMaxKb, seconds } = v;
  if (rssMidKb === undefined || midSeconds === undefined || rssMaxKb === undefined || seconds === undefined || seconds <= midSeconds) return undefined;
  return (Math.max(rssMaxKb - rssMidKb, 0) * 60) / (seconds - midSeconds);
}

/**
 * Read a soak, rate by rate. A rate voids it if the plugin did not instantiate or died there,
 * emitted a non-finite window, settled dead against its own best rate ({@link deadAgainstBest};
 * settled = the LAST window, never the first — Calf opens at +200 dBFS at 192 k), spent more
 * than half its windows silent, or opened above +6 dBFS. A few silent windows in ten thousand is
 * a gate closing on a swept threshold — the plugin working, not dying.
 *
 * `undefined` when there is no soak, or it covered no rate: nothing was read.
 */
export function soakFindings(soak: SoakReading | undefined, policy: HostingPolicy): SoakFindings | undefined {
  if (soak === undefined) return undefined;
  const rates = Object.entries(soak.perRate);
  if (rates.length === 0) return undefined;
  const gone = (v: SoakAtRate): boolean => v.timedOut !== true && (v.died === true || v.instantiated === false);
  const cut = (v: SoakAtRate): boolean => v.timedOut === true;
  const settled = rates.map(([, v]) =>
    gone(v) || cut(v) || (v.lastRmsDbfs ?? -Infinity) > BLAST_DBFS ? -Infinity : v.lastRmsDbfs ?? -Infinity,
  );
  const best = Math.max(...settled);
  const failed: SoakFailure[] = [];
  for (const [key, v] of rates) {
    const rate = Number(key);
    if (cut(v)) {
      failed.push({ rate, kind: "timed-out" });
      continue;
    }
    if (gone(v)) {
      failed.push({ rate, kind: "died" });
      continue;
    }
    if ((v.nonFiniteWindows ?? 0) > 0) {
      failed.push({ rate, kind: "non-finite" });
      continue;
    }
    if (deadAgainstBest(v.lastRmsDbfs ?? -Infinity, best, policy)) {
      failed.push({ rate, kind: "dead" });
      continue;
    }
    if ((v.silentWindows ?? 0) > (v.windows ?? 1) * 0.5) {
      failed.push({ rate, kind: "mostly-silent" });
      continue;
    }
    const first = v.firstRmsDbfs ?? -99;
    if (first > BLAST_DBFS) {
      failed.push({ rate, kind: "startup-blast", detail: `${first.toFixed(0)}dBFS` });
      continue;
    }
    const growth = soakGrowthKbPerMin(v);
    if (growth !== undefined && growth > policy.memoryGrowthKbPerMinCeiling) {
      failed.push({
        rate,
        kind: "leaks",
        detail: `${growth.toFixed(0)}KB/min`,
        params: {
          growthKbPerMin: Math.round(growth),
          ceilingKbPerMin: policy.memoryGrowthKbPerMinCeiling,
          ...(policy.memoryGrowthCeilingProvisional ? { provisional: "yes" as const } : {}),
        },
      });
    }
  }
  const failures = failed.map((f) => `${f.kind}@${f.rate}${f.detail === undefined ? "" : `(${f.detail})`}`);
  return {
    seconds: Math.min(...rates.map(([, v]) => v.seconds ?? 0)),
    failures,
    failed,
    ratesTested: rates.length,
    rssGrowthKb: Math.max(...rates.map(([, v]) => v.rssGrowthKb ?? 0)),
  };
}

/** Threads the plugin's first instance brought with it. */
export function threadsSpawned(threads: ThreadReading | undefined): number {
  return threads !== undefined && threads.afterFirstInstantiate > threads.before
    ? threads.afterFirstInstantiate - threads.before
    : 0;
}

export function stabilityReasons(
  m: PluginStabilityMeasurement | undefined,
  policy: HostingPolicy,
  pluginBinary?: string,
  /** Whether the plugin shares its process with others (profile isolation, §3a): threads it
   *  spawns and a GUI toolkit it links are cautions only there. */
  sharesProcess = true,
  /** The console's rate: a soak failure measured at it is the plugin's verdict there. */
  rate?: number,
): readonly HostingReason[] {
  const out: HostingReason[] = [];
  if (m === undefined || m.lifecycle === undefined) {
    return [reason("stability", "objective", "unknown", HOSTING_CODE.stabilityUnmeasured)];
  }
  if (m.crashedLive === true) {
    out.push(
      reason("stability", "objective", "unsuitable", HOSTING_CODE.stabilityCrashedLive, {}),
    );
  }
  const attributions = (m.crashes ?? []).map((c) => attributeCrash(c, CRASH_SIGNATURES, pluginBinary));
  if (attributions.includes("plugin")) {
    out.push(reason("stability", "objective", "unsuitable", HOSTING_CODE.stabilityCrashedAttributed));
  } else if (attributions.includes("unknown")) {
    out.push(reason("stability", "objective", "unknown", HOSTING_CODE.stabilityCrashUnattributed));
  }
  const cycles = m.lifecycle.instantiated;
  if (cycles < policy.cycleFloor) {
    out.push(
      reason("stability", "objective", "unknown", HOSTING_CODE.stabilityBelowFloor, {
        cycles,
        floor: policy.cycleFloor,
      }),
    );
  }
  // Any failure voids the soak: the plugin has not proven a clean show, so it reads unsoaked —
  // unknown, isolated — and never a crash, because silence at a rate is a measurement of
  // audio, not of the process.
  const soak = soakFindings(m.soak, policy);
  const soaked = soak === undefined || soak.failures.length > 0 ? 0 : soak.seconds;
  if (soaked < policy.soakSeconds || m.soak?.sweptParams !== true) {
    out.push(
      reason("stability", "objective", "unknown", HOSTING_CODE.stabilityUnsoaked, {
        soakSeconds: soaked,
        required: policy.soakSeconds,
        ...(soak !== undefined && soak.failures.length > 0 ? { failures: soak.failures.join(" ") } : {}),
      }),
    );
  }
  // A failure MEASURED at the rate being judged is that plugin's verdict at that rate: unsuitable.
  // At any other rate it only means the soak did not hold everywhere (unsoaked, above). A
  // supervisor timeout is the harness's fact, never the plugin's.
  for (const f of soak?.failed ?? []) {
    if (f.kind === "timed-out" || rate === undefined || f.rate !== rate) continue;
    out.push(
      reason("stability", "objective", "unsuitable", HOSTING_CODE.stabilitySoakFailedAtRate, {
        failure: f.kind,
        rate: f.rate,
        ...f.params,
      }),
    );
  }
  const spawned = sharesProcess ? threadsSpawned(m.threads) : 0;
  if (spawned > 0) {
    out.push(
      reason("stability", "objective", "conditional", HOSTING_CODE.stabilitySpawnsThreads, {
        threads: spawned,
      }),
    );
  }
  if (sharesProcess && m.linksGuiToolkit === true) {
    out.push(reason("stability", "objective", "conditional", HOSTING_CODE.stabilityLinksGuiToolkit));
  }
  if (out.length === 0) {
    out.push(
      reason("stability", "objective", "suitable", HOSTING_CODE.stabilitySoaked, {
        cycles,
        soakSeconds: soaked,
      }),
    );
  }
  return out;
}

/**
 * Whether an interposer count is a MEASUREMENT: the interposer was loaded, all three counts are
 * present, and the controls were swept — or the plugin has none a sweep could move, so its
 * at-rest count is the only state there is. Measured at rest otherwise is not measured.
 */
export function rtSafetyMeasured(m: PluginRtSafetyMeasurement | undefined): boolean {
  return (
    m !== undefined &&
    m.interposer === true &&
    (m.swept === true || m.sweepApplicable === false) &&
    m.allocationsInRun !== undefined &&
    m.syscallsInRun !== undefined &&
    m.locksInRun !== undefined
  );
}

/** A measured count above zero — the disqualifier, asked in one place. */
export function rtSafetyViolating(m: PluginRtSafetyMeasurement | undefined): boolean {
  return (
    rtSafetyMeasured(m) &&
    (m?.allocationsInRun ?? 0) + (m?.syscallsInRun ?? 0) + (m?.locksInRun ?? 0) > 0
  );
}

export function rtSafetyReasons(
  m: PluginRtSafetyMeasurement | undefined,
): readonly HostingReason[] {
  if (m === undefined || !rtSafetyMeasured(m)) {
    return [reason("rtSafety", "objective", "unknown", HOSTING_CODE.rtSafetyUnmeasured)];
  }
  if (m.variable === true) {
    return [reason("rtSafety", "objective", "unknown", HOSTING_CODE.rtSafetyNotReproducible)];
  }
  // RT-unsafe is a hosting mode, never a refusal (#196): the plugin loads and runs in a worker of its own, never
  // grouped with RT-safe plugins; conditional is isolated in the pin. Crashes, hangs and load failures stay unsuitable.
  if (rtSafetyViolating(m)) {
    return [
      reason("rtSafety", "objective", "conditional", HOSTING_CODE.rtSafetyViolations, {
        allocations: m.allocationsInRun ?? 0,
        syscalls: m.syscallsInRun ?? 0,
        locks: m.locksInRun ?? 0,
      }),
    ];
  }
  return [
    reason("rtSafety", "objective", "suitable", HOSTING_CODE.rtSafetyClean, {
      blocks: m.blocks ?? 0,
    }),
  ];
}

export function featureReasons(
  features: PluginLv2Features | undefined,
  descriptor: Pick<QualifiedPlugin, "hasMidiIn">,
  provided: readonly string[] = OMX_INPROCESS_FEATURES,
  quantumPinned = false,
  /** The host feeds MIDI input (an instrument host, §3a): a MIDI input is no caution there. */
  instruments = false,
): readonly HostingReason[] {
  const out: HostingReason[] = [];
  if (features === undefined) {
    out.push(reason("features", "objective", "unknown", HOSTING_CODE.featuresUnscanned));
  } else {
    const required = features.required ?? [];
    // A host that LISTS one of these provides it: refused are only those it does not list.
    const refused = (quantumPinned ? DISQUALIFYING_FEATURES : [...DISQUALIFYING_FEATURES, ...QUANTUM_PINNED_FEATURES])
      .filter((f) => !provided.includes(f));
    const disqualifying = required.filter((f) => refused.includes(f));
    if (disqualifying.length > 0) {
      out.push(
        reason("features", "objective", "unsuitable", HOSTING_CODE.featuresDisqualifying, {
          features: disqualifying.join(" "),
        }),
      );
    }
    const missing = required.filter(
      (f) =>
        !provided.includes(f) &&
        !refused.includes(f) &&
        !QUANTUM_PINNED_FEATURES.includes(f) &&
        !ALWAYS_MET_FEATURES.includes(f),
    );
    if (missing.length > 0) {
      out.push(
        reason("features", "objective", "unsuitable", HOSTING_CODE.featuresMissing, {
          features: missing.join(" "),
        }),
      );
    }
  }
  if (descriptor.hasMidiIn && !instruments) {
    out.push(reason("features", "objective", "conditional", HOSTING_CODE.featuresMidiIn));
  }
  if (out.length === 0) {
    out.push(reason("features", "objective", "suitable", HOSTING_CODE.featuresProvided));
  }
  return out;
}

export function hostingCostReasons(
  descriptor: Pick<QualifiedPlugin, "cpuCost">,
  options: HostingClassifyOptions,
  policy: HostingPolicy,
): readonly HostingReason[] {
  const grid = descriptor.cpuCost?.perRateQuantum;
  const perRate =
    grid === undefined
      ? descriptor.cpuCost?.perRate?.[String(options.rate)]
      : options.quantum === undefined
        ? undefined
        : grid[costPointKey(options.rate, options.quantum)];
  if (perRate === undefined) {
    return [
      reason("cost", "objective", "unknown", HOSTING_CODE.costUnmeasured, {
        rate: options.rate,
        quantum: options.quantum ?? 0,
      }),
    ];
  }
  // Refuse before comparing: `undefined > ceiling` is false, which is how a gate passes by absence.
  const missing = costFieldsMissing(perRate);
  if (missing.length > 0) {
    return [
      reason("cost", "objective", "unknown", HOSTING_CODE.costFieldsMissing, {
        rate: options.rate,
        missing: missing.join(","),
      }),
    ];
  }
  const out: HostingReason[] = [];
  const p95 = perRate.coreFractionP95;
  // The per-instance ceiling is the HOST's budget (§3a), not the policy's.
  const ceiling = (options.profile ?? OPENMIXER_CONSOLE_PROFILE).cost.coreFractionCeiling;
  if (p95 > ceiling) {
    out.push(
      reason("cost", "objective", "unsuitable", HOSTING_CODE.costAboveCeiling, {
        coreFractionP95: p95,
        ceiling,
      }),
    );
  }
  const median = perRate.nsPerSampleMedian;
  const p95ns = perRate.nsPerSampleP95;
  if (median > 0 && p95ns / median > policy.costTailRatioCeiling) {
    out.push(
      reason("cost", "objective", "conditional", HOSTING_CODE.costSpiky, {
        tailRatio: p95ns / median,
        ceiling: policy.costTailRatioCeiling,
      }),
    );
  }
  if (out.length === 0) {
    out.push(
      reason("cost", "objective", "suitable", HOSTING_CODE.costWithinCeiling, {
        coreFractionP95: p95,
        ceiling,
      }),
    );
  }
  return out;
}

/**
 * What a host's memory budget makes of a plugin. A host with no budget declared reads nothing here. Every cell the host
 * runs is read; the worst stands, so a plugin is never read as fitting on the cell that happened to be measured. A missing
 * figure is `unknown`, never a fit. Under a provisional budget a plugin below the ceiling is `conditional` with a code of its
 * own, since the number it was held to was not measured on that kind of host; one above it is `unsuitable` and says the
 * ceiling is provisional.
 */
export function hostingMemoryReasons(
  memory: MemoryReadings | undefined,
  profile: HostProfile,
  /** The live rate and quantum, for a host whose budget names no cells of its own; absent, the cell its cost is read at. */
  live?: { readonly rate: number; readonly quantum?: number },
): readonly HostingReason[] {
  const budget = profile.cost.memory;
  if (budget === undefined) return [];
  const provisional: CodedRefusalParams = budget.provisional === true ? { provisional: "yes" } : {};
  const cells = budget.cells ?? [{ rate: live?.rate ?? profile.cost.rate, quantum: live?.quantum ?? profile.cost.quantum }];
  const reads = cells.map((c) => ({ ...c, read: memoryWithinBudget(memoryAt(memory, c.rate, c.quantum), budget) }));
  const above = reads.find((r) => r.read.outcome === "above");
  if (above !== undefined && above.read.outcome === "above") {
    return [
      reason("memory", "objective", "unsuitable", HOSTING_CODE.memoryAboveCeiling, {
        rate: above.rate,
        quantum: above.quantum,
        figure: above.read.figure,
        kb: above.read.kb,
        ceilingKb: above.read.ceilingKb,
        ...provisional,
      }),
    ];
  }
  const unmeasured = reads.find((r) => r.read.outcome === "unmeasured");
  if (unmeasured !== undefined && unmeasured.read.outcome === "unmeasured") {
    return [
      reason("memory", "objective", "unknown", HOSTING_CODE.memoryUnmeasured, {
        rate: unmeasured.rate,
        quantum: unmeasured.quantum,
        ...(unmeasured.read.unmeasuredReason === undefined ? {} : { unmeasuredReason: unmeasured.read.unmeasuredReason }),
      }),
    ];
  }
  const first = reads[0]!.read;
  const params: CodedRefusalParams = first.outcome === "within" ? { perInstanceKb: first.perInstanceKb, firstInstanceKb: first.firstInstanceKb, ceilingKb: budget.perInstanceKb, consoleCeilingKb: budget.perConsoleKb } : {};
  return budget.provisional === true
    ? [reason("memory", "objective", "conditional", HOSTING_CODE.memoryWithinProvisionalCeiling, { ...params, ...provisional })]
    : [reason("memory", "objective", "suitable", HOSTING_CODE.memoryWithinCeiling, params)];
}

/** The footprint at a rate and quantum: a grid's cell when the plugin has a grid, else its rate's. */
function memoryAt(memory: MemoryReadings | undefined, rate: number, quantum: number) {
  if (memory?.perRateQuantum !== undefined) return memory.perRateQuantum[costPointKey(rate, quantum)];
  return memory?.perRate?.[String(rate)];
}

export function hostingLatencyReasons(
  descriptor: Pick<QualifiedPlugin, "latency">,
  handling: HostProfile["latency"] = "compensated",
): readonly HostingReason[] {
  const latency = descriptor.latency;
  // Fails closed, like every other dimension: a plugin with no latency figure at all, or
  // one the benchmark declared unmeasurable, has not been judged and does not pass by
  // default. The oracle's first fixture omitted latency and still expected `suitable`,
  // which is how this branch was missing — a self-consistent suite proving nothing.
  // A plugin whose worker interface was refused is not unmeasured by accident: it is not hostable.
  if (typeof latency?.unmeasurable === "string" && latency.unmeasurable.includes(HOSTING_CODE.workerNonconforming)) {
    return [reason("latency", "objective", "unsuitable", HOSTING_CODE.workerNonconforming)];
  }
  if (latency === undefined || latency.unmeasurable !== undefined) {
    return [reason("latency", "objective", "unknown", HOSTING_CODE.latencyUnmeasured)];
  }
  if (latency.scalingClass === "nonconforming") {
    return [reason("latency", "objective", "unknown", HOSTING_CODE.latencyNonconforming)];
  }
  // A parameter-dependent latency is ALLOWED in-process: the live latency port is read every
  // cycle, so a moving latency is reported rather than assumed. It is a caution, not a bar.
  // A host that does not compensate aligns on nothing, so a moving figure costs it nothing.
  if (latency.paramSweep !== undefined && handling === "compensated") {
    return [reason("latency", "objective", "conditional", HOSTING_CODE.latencyParameterDependent)];
  }
  return [reason("latency", "objective", "suitable", HOSTING_CODE.latencyResolved)];
}

export function hostingTopologyReasons(
  descriptor: Pick<QualifiedPlugin, "audioInputs" | "audioOutputs"> & Partial<Pick<QualifiedPlugin, "hasMidiIn">>,
  instruments = false,
): readonly HostingReason[] {
  const { audioInputs: ins, audioOutputs: outs } = descriptor;
  // An instrument host feeds MIDI: no audio input but a MIDI input and an audio output is an instrument.
  if (ins === 0 && instruments && descriptor.hasMidiIn === true && outs > 0) {
    return [reason("topology", "objective", "suitable", HOSTING_CODE.topologyInstrument, { ins, outs })];
  }
  if (ins === 0) {
    return [reason("topology", "objective", "unsuitable", HOSTING_CODE.topologyNoAudioInput)];
  }
  if (outs === 0) {
    return [reason("topology", "objective", "unsuitable", HOSTING_CODE.topologyNoAudioOutput)];
  }
  if ((ins === 1 && outs === 1) || (ins === 2 && outs === 2)) {
    return [
      reason("topology", "objective", "suitable", HOSTING_CODE.topologyMatched, { ins, outs }),
    ];
  }
  return [
    reason("topology", "objective", "conditional", HOSTING_CODE.topologyTooManyPorts, { ins, outs }),
  ];
}

/**
 * The CLAP arm of `topology` (CLAP spec §3): the qualifier's main-port facts feed the same
 * dimension the LV2 scan feeds. No measurement → `unknown` (`hosting.clap.unqualified`), never
 * a guess from the descriptor.
 */
export function clapTopologyReasons(clap: PluginClapMeasurement | undefined, instruments = false): readonly HostingReason[] {
  if (clap === undefined) {
    return [reason("topology", "objective", "unknown", HOSTING_CODE.clapUnqualified)];
  }
  const ins = clap.mainInputChannels;
  const outs = clap.mainOutputChannels;
  if (ins === 0 && instruments && clap.noteInputs > 0 && outs > 0 && outs <= 2) {
    return [reason("topology", "objective", "suitable", HOSTING_CODE.topologyInstrument, { ins, outs })];
  }
  if (ins === 0) return [reason("topology", "objective", "unsuitable", HOSTING_CODE.topologyNoAudioInput)];
  if (outs === 0) return [reason("topology", "objective", "unsuitable", HOSTING_CODE.topologyNoAudioOutput)];
  if (ins > 2 || outs > 2) {
    return [reason("topology", "objective", "unsuitable", HOSTING_CODE.topologyWiderThanStrip, { ins, outs })];
  }
  if (clap.sidechainInputs > 0) {
    return [reason("topology", "objective", "unsuitable", HOSTING_CODE.topologyTooManyPorts, { ins, outs, sidechains: clap.sidechainInputs })];
  }
  return [reason("topology", "objective", "suitable", HOSTING_CODE.topologyMatched, { ins, outs })];
}

/**
 * The CLAP arm of `latency` (CLAP spec §3): declared = measured at EVERY declared rate earns;
 * one rate that lies refuses (`unsuitable` — compensation reads the figure as truth); no rate
 * measured is `unknown`. An instrument has no input to put an impulse in, so its figure is the onset
 * of a note struck at frame 0: an onset before the declared latency is the same lie, one at or after
 * it is resolved (an attack envelope sounds later than the plugin's delay, and that is no latency),
 * and a note that was never heard is unmeasured.
 */
export function clapLatencyReasons(clap: PluginClapMeasurement | undefined): readonly HostingReason[] {
  const rates = clap ? Object.keys(clap.latency) : [];
  if (clap === undefined || rates.length === 0) {
    return [reason("latency", "objective", "unknown", HOSTING_CODE.latencyUnmeasured)];
  }
  for (const rate of rates) {
    const at = clap.latency[rate]!;
    if (at.from === "note" && at.heard === false) {
      return [reason("latency", "objective", "unknown", HOSTING_CODE.latencyUnmeasured, { rate: Number(rate) })];
    }
    const lies = at.from === "note" ? at.measuredFrames < at.declaredFrames : at.declaredFrames !== at.measuredFrames;
    if (lies) {
      return [
        reason("latency", "objective", "unsuitable", HOSTING_CODE.clapLatencyMismatch, {
          rate: Number(rate), declared: at.declaredFrames, measured: at.measuredFrames,
        }),
      ];
    }
  }
  return [reason("latency", "objective", "suitable", HOSTING_CODE.latencyResolved)];
}

/**
 * The CLAP arm of `features` (CLAP spec §3): an audio effect that initialised and activated
 * HEADLESS with only OMX_CLAP_HOST_EXTENSIONS offered, and no note input (the measurement's or the
 * scan's `hasMidiIn`). Every miss is its own code; a note input is an instrument, `unsuitable`.
 */
export function clapFeatureReasons(
  clap: PluginClapMeasurement | undefined,
  profile: HostProfile = OPENMIXER_CONSOLE_PROFILE,
  scannedNoteInput = false,
): readonly HostingReason[] {
  // A host with no CLAP path cannot run one, whatever it measured (§3a).
  if (profile.clapExtensions === null) {
    return [reason("features", "objective", "unsuitable", HOSTING_CODE.clapFormatNotHosted)];
  }
  if (clap === undefined) {
    return [reason("features", "objective", "unknown", HOSTING_CODE.clapUnqualified)];
  }
  const out: HostingReason[] = [];
  const offered = profile.clapExtensions;
  if (!clap.headlessOk) {
    out.push(reason("features", "objective", "unsuitable", HOSTING_CODE.clapHeadlessFailed));
  } else {
    // The headless pass was taken with OMX_CLAP_HOST_EXTENSIONS offered: a host offering less
    // has not been shown to initialise the plugin.
    const uncovered = OMX_CLAP_HOST_EXTENSIONS.filter((e) => !offered.includes(e));
    if (uncovered.length > 0) {
      out.push(reason("features", "objective", "unknown", HOSTING_CODE.clapExtensionsNotCovered, { extensions: uncovered.join(" ") }));
    }
  }
  if ((clap.noteInputs > 0 || scannedNoteInput) && !profile.instruments) {
    out.push(reason("features", "objective", "unsuitable", HOSTING_CODE.clapNoteInput, { noteInputs: clap.noteInputs }));
  }
  if (out.length === 0) out.push(reason("features", "objective", "suitable", HOSTING_CODE.featuresProvided));
  return out;
}

/**
 * The CLAP additions to `rtSafety` (CLAP spec §3): the interposer's counts are read by
 * `rtSafetyReasons` exactly as for an LV2; these are the two violations only a CLAP can commit
 * — a strict thread-check violation (`conditional`: the plugin runs isolated, #196) and a `CLAP_PROCESS_ERROR`
 * (`unsuitable`). A sweep
 * that made no `process()` call measured nothing.
 */
export function clapRtReasons(clap: PluginClapMeasurement | undefined): readonly HostingReason[] {
  if (clap === undefined || clap.processCalls === 0) {
    return [reason("rtSafety", "objective", "unknown", HOSTING_CODE.clapUnqualified)];
  }
  const out: HostingReason[] = [];
  if (clap.threadViolations > 0) {
    out.push(reason("rtSafety", "objective", "conditional", HOSTING_CODE.clapThreadViolation, { violations: clap.threadViolations }));
  }
  if (clap.processErrors > 0) {
    out.push(reason("rtSafety", "objective", "unsuitable", HOSTING_CODE.clapProcessError, { errors: clap.processErrors }));
  }
  return out;
}

/**
 * The rtSafety reasons of the note sweep, for a plugin with `noteInputs` note inputs: none for a
 * plugin that takes no notes; `unknown` when it takes notes and was not played under the
 * interposer (an instrument is cheap and clean at rest, so the parameter sweep alone says nothing
 * about a voice); `conditional` (isolated in the pin: its own worker, never refused) on any
 * allocation, lock or syscall while it was played; `unsuitable` on a process error only (a crash);
 * `suitable` on a clean count.
 */
export function noteSweepReasons(sweep: PluginNoteSweepMeasurement | undefined, noteInputs: number): readonly HostingReason[] {
  if (noteInputs === 0) return [];
  if (sweep === undefined || !sweep.applicable || sweep.interposer !== true || !sweep.blocks ||
      sweep.allocationsInRun === undefined || sweep.locksInRun === undefined || sweep.syscallsInRun === undefined) {
    return [reason("rtSafety", "objective", "unknown", HOSTING_CODE.rtSafetyNotesUnmeasured)];
  }
  const out: HostingReason[] = [];
  if (sweep.allocationsInRun + sweep.locksInRun + sweep.syscallsInRun > 0) {
    out.push(
      reason("rtSafety", "objective", "conditional", HOSTING_CODE.rtSafetyNotesViolations, {
        allocations: sweep.allocationsInRun,
        syscalls: sweep.syscallsInRun,
        locks: sweep.locksInRun,
      }),
    );
  }
  if ((sweep.processErrors ?? 0) > 0) {
    out.push(reason("rtSafety", "objective", "unsuitable", HOSTING_CODE.clapProcessError, { errors: sweep.processErrors ?? 0 }));
  }
  return out.length > 0
    ? out
    : [reason("rtSafety", "objective", "suitable", HOSTING_CODE.rtSafetyNotesClean, { blocks: sweep.blocks, events: sweep.noteEvents ?? 0 })];
}

/**
 * The verdict. Worst-wins across every dimension, exactly as `classifyForRole` folds — with
 * three gates that can poison the whole result before the fold is even read: a curator
 * override, a sweep whose positive control did not fire, and figures taken on a different
 * host than the console is running.
 */
export function classifyPluginHosting(
  descriptor: QualifiedPlugin,
  options: HostingClassifyOptions,
): PluginHosting {
  const policy = options.policy ?? DEFAULT_HOSTING_POLICY;
  const profile = options.profile ?? OPENMIXER_CONSOLE_PROFILE;
  const sharesProcess = profile.isolation !== "per-process";
  // The descriptor's own measured blocks and nothing else: they reached it through the
  // interchange's one door (`measurement-catalog.ts`), whose per-dimension precedence is the
  // only precedence there is. A second "passed measurements win" seam here was how an offline
  // report could agree with itself while every served descriptor read unknown.
  // The CLAP arm: the SAME six dimensions, fed from the
  // qualifier's CLAP facts where the LV2 scan's facts do not exist for the format. Stability,
  // the interposer's counts and the cost are format-blind and read unchanged. A host that plays
  // notes (an instrument host) also reads the note sweep: an instrument is clean at rest, so the
  // parameter sweep alone says nothing about what a voice does.
  const reasons: HostingReason[] = descriptor.format === "clap"
    ? [
        ...stabilityReasons(descriptor.stability, policy, options.pluginBinary, sharesProcess, options.rate),
        ...rtSafetyReasons(descriptor.rtSafety),
        ...clapRtReasons(descriptor.clap),
        ...(profile.instruments ? noteSweepReasons(descriptor.rtSafety?.noteSweep, descriptor.clap?.noteInputs ?? (descriptor.hasMidiIn ? 1 : 0)) : []),
        ...clapFeatureReasons(descriptor.clap, profile, descriptor.hasMidiIn),
        ...hostingCostReasons(descriptor, options, policy),
        ...hostingMemoryReasons(descriptor.memory, profile, options),
        ...clapLatencyReasons(descriptor.clap),
        ...clapTopologyReasons(descriptor.clap, profile.instruments),
      ]
    : [
        ...stabilityReasons(descriptor.stability, policy, options.pluginBinary, sharesProcess, options.rate),
        ...rtSafetyReasons(descriptor.rtSafety),
        ...(profile.instruments ? noteSweepReasons(descriptor.rtSafety?.noteSweep, descriptor.hasMidiIn ? 1 : 0) : []),
        ...featureReasons(descriptor.lv2Features, descriptor, profile.lv2Features, options.quantum !== undefined, profile.instruments),
        ...hostingCostReasons(descriptor, options, policy),
        ...hostingMemoryReasons(descriptor.memory, profile, options),
        ...hostingLatencyReasons(descriptor, profile.latency),
        ...hostingTopologyReasons(descriptor, profile.instruments),
      ];

  // A sweep whose positive control did not fire proves nothing about anything it measured.
  // The whole roster reads `unknown` — the false-signals law, made mechanical.
  if (options.sweepControlFired === false) {
    reasons.unshift(
      reason("stability", "objective", "unknown", HOSTING_CODE.sweepControlDidNotFire),
    );
  }

  // A dnf upgrade must not carry a verdict forward. Different host, no `suitable`.
  const figureHost = descriptor.stability?.runHost;
  if (
    options.consoleHost !== undefined &&
    figureHost !== undefined &&
    figureHost !== options.consoleHost
  ) {
    reasons.unshift(
      reason("stability", "objective", "unknown", HOSTING_CODE.hostProvenanceDiffers, {
        measuredOn: figureHost,
        runningOn: options.consoleHost,
      }),
    );
  }

  if (options.override === "isolated") {
    reasons.unshift(
      reason("stability", "objective", "unsuitable", HOSTING_CODE.overrideIsolated),
    );
  }

  const rating = worstRating(reasons.map(contributedHostingRating));
  const deciding = [...reasons]
    .sort(
      (a, b) =>
        RATING_SEVERITY[contributedHostingRating(b)] - RATING_SEVERITY[contributedHostingRating(a)],
    )
    .find((r) => contributedHostingRating(r) === rating);
  return {
    rating,
    // In-process is a place only an in-process host has; every other host runs it in its own.
    path: rating === "suitable" && profile.isolation === "in-process" ? "in-process" : "isolated",
    reasons,
    ...(rating === "suitable" ? {} : { deciding }),
  };
}

/** What a racked slot's host actually IS, and the ONE reason it is that. */
export interface RealisedHosting {
  readonly path: HostingPath;
  /** The plugin's own rating, carried through — `unknown` where nothing could be judged. */
  readonly rating: SuitabilityRating;
  readonly reason: HostingCode;
}

/** What the CONSOLE brings to the question, beside the plugin's own verdict. */
export interface HostingRealisation {
  /** The operator's authored switch (`/console/plugins/hosting`). */
  readonly inProcessEnabled: boolean;
  /** Whether an in-process body exists to run a plugin in at all. */
  readonly inProcessAvailable: boolean;
  /**
   * Whether the plugin is LINKED into the engine (its static-link registry): it needs no verdict
   * to run in-process. Absent reads as not linked.
   */
  readonly linked?: boolean;
}

/**
 * The REALISED host of one racked plugin — a different fact from the verdict, and kept in a
 * different field for that reason.
 *
 * `classifyPluginHosting` answers what a plugin EARNED. This answers where it RUNS, which
 * three things decide in order, each with its own reason so the operator reads the first one
 * that applies rather than a fold:
 *
 * 1. the console's switch is off — nothing runs in-process, whatever it earned;
 * 1a. the plugin is LINKED into the engine — it runs in-process wherever a body exists, with no
 *    verdict to read;
 * 2. nothing could be judged (no verdict: the console has observed no rate and quantum) or the
 *    verdict is below `suitable` — the plugin's own deciding reason stands;
 * 3. it earned in-process and there is no in-process body to run it in yet.
 *
 * Order matters and is the operator's, not the machine's: a console-wide fact is a better
 * answer to "why is this plugin not on the fast path" than a per-plugin one, because it is the
 * one the operator can act on.
 */
export function realisedHosting(
  verdict: PluginHosting | undefined,
  realisation: HostingRealisation,
): RealisedHosting {
  const rating = verdict?.rating ?? "unknown";
  if (!realisation.inProcessEnabled) {
    return { path: "isolated", rating, reason: HOSTING_CODE.disabled };
  }
  if (realisation.linked === true) {
    return realisation.inProcessAvailable
      ? { path: "in-process", rating, reason: HOSTING_CODE.linked }
      : { path: "isolated", rating, reason: HOSTING_CODE.noRealisation };
  }
  if (verdict === undefined) {
    return { path: "isolated", rating, reason: HOSTING_CODE.unjudged };
  }
  if (verdict.path === "isolated") {
    return {
      path: "isolated",
      rating,
      // `deciding` is present for every rating below `suitable`; the fall-back names the one
      // state that could produce an isolated verdict with no reason at all — nothing judged.
      reason: verdict.deciding?.code ?? HOSTING_CODE.unjudged,
    };
  }
  if (!realisation.inProcessAvailable) {
    return { path: "isolated", rating, reason: HOSTING_CODE.noRealisation };
  }
  return { path: "in-process", rating, reason: HOSTING_CODE.realisedInProcess };
}
