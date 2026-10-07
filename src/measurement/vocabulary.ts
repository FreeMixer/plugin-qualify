// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The controlled vocabularies the interchange format speaks.
 *
 * This is the boring file that decides whether two projects' measurements can be merged
 * (issue #343, point 3). Everyone who has written an LV2 prober has invented their own
 * words for "there was nothing to measure here", so nobody's results combine. The words
 * are fixed here, each with the ONE property a merger actually needs to branch on —
 * whether the plugin has nothing to measure or whether OUR PROBE failed — and each with
 * a plain description a UI can render.
 *
 * Everything is a data table, not a switch. Adding a term is one row; a consumer that
 * meets a term it does not know must be able to fall back on the `kind`, which is why the
 * readers below return a term record rather than a bare string.
 */

import { nonEmptyString } from "./guards.js";

// ---------------------------------------------------------------------------
// Why a figure is absent
// ---------------------------------------------------------------------------

/**
 * What an absent figure means for a MERGE, and it is the only distinction that changes
 * behaviour:
 *
 * - `nothing-to-measure` — a property of the PLUGIN. An instrument has no audio input to
 *   drive; a meter has no audio output to read. Any prober on any machine reaches the
 *   same conclusion, so this outcome is as portable as a measurement and may override one.
 * - `probe-failed` — a property of THIS RUN. The plugin crashed the worker, timed out,
 *   refused to instantiate. It says nothing about the plugin's latency or cost, so it
 *   must NOT override a figure someone else managed to take.
 * - `not-attempted` — the run did not cover this plugin or this dimension at all. Neither
 *   a finding nor a failure; it is the shape a PARTIAL run has, and partial runs are
 *   first-class here.
 */
export type UnmeasuredKind = "nothing-to-measure" | "probe-failed" | "not-attempted";

/** One term of the "why is there no figure" vocabulary. */
export interface UnmeasuredTerm {
  readonly code: string;
  readonly kind: UnmeasuredKind;
  /** Plain description, English. A UI localises from `code`; this is for logs and specs. */
  readonly description: string;
}

/**
 * Every reason a figure may be absent. The census in
 * `packages/catalog/data/CATALOG_PROVENANCE.md` is what these were derived from — each
 * one is an outcome the 958-plugin sweep actually produced, not a hypothetical.
 */
export const UNMEASURED_TERMS: readonly UnmeasuredTerm[] = [
  {
    code: "no-audio-in",
    kind: "nothing-to-measure",
    description: "No audio input port: an instrument, a generator or an analyser. Nothing to drive.",
  },
  {
    code: "no-audio-out",
    kind: "nothing-to-measure",
    description: "No audio output port: a meter or a sink. Nothing to read.",
  },
  {
    code: "silent-output",
    kind: "nothing-to-measure",
    description:
      "Instantiated and driven, but emitted nothing under a stimulus that should have passed. " +
      "A convolver with no impulse response, a vocoder with no carrier, a gate that never opened.",
  },
  {
    code: "needs-carrier",
    kind: "nothing-to-measure",
    description: "Requires a second audio input (a carrier or side-chain) the prober did not supply.",
  },
  {
    code: "needs-impulse-response",
    kind: "nothing-to-measure",
    description: "A convolver requiring an IR file the prober did not load.",
  },
  {
    code: "refused-instantiation",
    kind: "probe-failed",
    description: "The plugin would not instantiate at this rate or block size.",
  },
  {
    code: "probe-crashed",
    kind: "probe-failed",
    description: "The probe worker died (signal or abort) while hosting this plugin.",
  },
  {
    code: "probe-timeout",
    kind: "probe-failed",
    description: "The probe exceeded its per-plugin time limit and was abandoned.",
  },
  {
    code: "non-finite-output",
    kind: "probe-failed",
    description: "Output contained NaN or infinity, so no onset or block time could be trusted.",
  },
  {
    code: "not-installed",
    kind: "probe-failed",
    description:
      "The URI was not present in this machine's LV2 world. A fact about this installation, " +
      "not about the plugin — another host may well have it.",
  },
  {
    code: "probe-error",
    kind: "probe-failed",
    description:
      "The probe reported a failure with no more specific term. Its own words are kept verbatim " +
      "in the measurement's `unmeasuredDetail`, so a coarse code never destroys the detail.",
  },
  {
    code: "not-attempted",
    kind: "not-attempted",
    description: "This run did not cover this plugin for this dimension. A partial run, not a finding.",
  },
];

const UNMEASURED_BY_CODE: ReadonlyMap<string, UnmeasuredTerm> = new Map(
  UNMEASURED_TERMS.map((term) => [term.code, term]),
);

/**
 * The vocabulary term for a code, or `undefined` when the code is not one of ours.
 *
 * A third-party document carrying an unknown reason is not an error — the format is meant
 * to be extended by people we will never meet. {@link unmeasuredKind} is what a merger
 * should consult, and it is deliberately conservative about strangers.
 */
export function unmeasuredTerm(code: string | undefined): UnmeasuredTerm | undefined {
  return code === undefined ? undefined : UNMEASURED_BY_CODE.get(code);
}

/**
 * How a merger must treat an absence reason. An UNKNOWN code resolves to `probe-failed`,
 * the conservative answer: a reason we cannot interpret must never be allowed to delete
 * somebody else's real measurement, and treating it as a plugin property would do exactly
 * that.
 */
export function unmeasuredKind(code: string | undefined): UnmeasuredKind {
  if (code === undefined) return "not-attempted";
  return UNMEASURED_BY_CODE.get(code)?.kind ?? "probe-failed";
}

// ---------------------------------------------------------------------------
// How latency moves with the sample rate
// ---------------------------------------------------------------------------

/**
 * The rate-scaling laws, DERIVED from readings at several rates and never assumed from
 * what a plugin is called. The population behind each term is in
 * `CATALOG_PROVENANCE.md`'s 2026-07-28 rows.
 */
export interface ScalingTerm {
  readonly code: string;
  readonly description: string;
}

export const SCALING_TERMS: readonly ScalingTerm[] = [
  {
    code: "fixed-frame",
    description: "Constant frame count at every rate — an FFT window. Milliseconds halve when the rate doubles.",
  },
  {
    code: "fixed-time",
    description: "Constant milliseconds at every rate — a look-ahead. Frames double when the rate doubles.",
  },
  { code: "zero", description: "No latency a mix can notice at any measured rate." },
  {
    code: "nonconforming",
    description:
      "Fits neither law at a magnitude that reaches a mix: the plugin changes what it does with " +
      "the rate. Flagged rather than averaged; nothing may be projected from it.",
  },
  { code: "single-rate", description: "One usable reading, so no law can be fitted." },
  { code: "unmeasured", description: "No rate produced a figure." },
];

const SCALING_CODES: ReadonlySet<string> = new Set(SCALING_TERMS.map((t) => t.code));

/** True when `code` is a scaling term this version of the format defines. */
export function isKnownScalingCode(code: string): boolean {
  return SCALING_CODES.has(code);
}

/**
 * Why a derived scaling class is not the naive fit over every reading — `below-budget`,
 * where the readings fit no law but are all small enough that the disagreement is the onset
 * detector's rather than the plugin's, and `informational-rate`, where only a reading below
 * the operational rates breaks the law (`lv2-measurement-interchange.md` §1a).
 */
export const SCALING_NOTE_TERMS: readonly ScalingTerm[] = [
  {
    code: "below-budget",
    description:
      "The readings fit no law, but every one of them is inside the per-channel latency budget, " +
      "so the disagreement is measurement noise rather than plugin behaviour.",
  },
  {
    code: "informational-rate",
    description:
      "The readings together fit no law, but those at the operational rates (48 kHz and up) do; " +
      "the reading below them stays in perRate as information and does not flag the plugin.",
  },
];

/**
 * Why one rate's reading was excluded from the fit and from every rate resolution. A
 * failed reading served as an exact answer is worse than no reading, because a zero reads
 * as confidence.
 */
export const EXCLUSION_TERMS: readonly ScalingTerm[] = [
  {
    code: "impossible-zero",
    description:
      "Zero frames at this rate while another rate measured non-zero. Both scaling laws map zero " +
      "to zero, so no single latency produces this; the onset detector was defeated.",
  },
];

// ---------------------------------------------------------------------------
// How a figure was taken
// ---------------------------------------------------------------------------

/** The measurement methods the format has names for. */
export const METHOD_TERMS: readonly ScalingTerm[] = [
  {
    code: "impulse-onset",
    description:
      "Latency as the round-trip delay from a unit impulse to the first output sample above the " +
      "residual floor. Measures the plugin, not what it declares.",
  },
  {
    code: "declared-port",
    description: "Latency read from the plugin's own lv2:latency output port. What it CLAIMS.",
  },
  {
    code: "block-time-percentile",
    description:
      "Cost as a percentile of per-block wall time under a sustained stimulus, warm-up blocks " +
      "discarded, normalised to nanoseconds per sample.",
  },
];

const METHOD_CODES: ReadonlySet<string> = new Set(METHOD_TERMS.map((t) => t.code));

/** True when `code` is a method term this version of the format defines. */
export function isKnownMethodCode(code: string): boolean {
  return METHOD_CODES.has(code);
}

/**
 * The measurable dimensions. A document declares which of them it covers.
 *
 * `latency` and `cost` are 1.0's. `stability`, `rtSafety` and `features` joined in 1.1 for the
 * hosting verdict — whether a plugin survives, whether its `run()` is RT-clean, what it
 * demands of a host — and merge under exactly the same per-plugin, per-DIMENSION precedence.
 */
export const MEASUREMENT_DIMENSIONS = ["latency", "cost", "stability", "rtSafety", "features"] as const;

/**
 * The dimensions the standalone prober (`scan.py` + `benchmark.py`, driven by `lv2-measure.mjs`
 * and the console's Setup analysis) can measure. The three hosting dimensions come from a
 * different tool — the `lv2-measure.c` sweep, read by `sweep-jsonl.ts` — so a run asked of the
 * prober for `stability` would be asking it for something it cannot take.
 */
export const PROBED_DIMENSIONS = ["latency", "cost"] as const satisfies readonly (typeof MEASUREMENT_DIMENSIONS)[number][];

/** One measurable dimension. */
export type MeasurementDimension = (typeof MEASUREMENT_DIMENSIONS)[number];

/** `value` as a dimension, or `undefined` when it is not one. */
export function readDimension(value: unknown): MeasurementDimension | undefined {
  const text = nonEmptyString(value);
  return MEASUREMENT_DIMENSIONS.find((d) => d === text);
}

/**
 * The four ratings a verdict speaks (`lv2-measurement-interchange.md` §3b) — the ONE list; the
 * rating vocabulary (`rating.ts`) derives its type from it, so the document and the classifier
 * can never disagree on a word.
 */
export const VERDICT_RATINGS = ["suitable", "conditional", "unknown", "unsuitable"] as const;
export type VerdictRating = (typeof VERDICT_RATINGS)[number];

/** How a host runs its plugins (`2026-09-25-plugin-qualify.md` §3a). */
export const HOST_ISOLATIONS = ["in-process", "per-process", "shared-process"] as const;
export type HostIsolation = (typeof HOST_ISOLATIONS)[number];

/** Whether a host aligns on a plugin's reported latency (`compensated`) or only passes it on. */
export const HOST_LATENCY_HANDLING = ["compensated", "uncompensated"] as const;
export type HostLatencyHandling = (typeof HOST_LATENCY_HANDLING)[number];

