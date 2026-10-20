// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The controlled vocabularies the interchange format speaks.
 *
 * This is the boring file that decides whether two projects' measurements can be merged
 * Everyone who has written an LV2 prober has invented their own
 * words for "there was nothing to measure here", so nobody's results combine. The words
 * are fixed here, each with the ONE property a merger actually needs to branch on —
 * whether the plugin has nothing to measure or whether OUR PROBE failed — and each with
 * a plain description a UI can render.
 *
 * Everything is a data table, not a switch. A consumer that meets a term it does not know
 * must be able to fall back on the `kind`, which is why the readers below return a term record
 * rather than a bare string.
 *
 * The WORDS are omx-contract's (`data/measurement.json` and `data/resource-profile.json`, rendered
 * as `<ITEM>_WORDS`), in its order: a word is added there, once, and every consumer reads it. What
 * stays here is the prose, keyed by the contract's word type, so a word the contract adds without
 * a description here, or a description for a word it lacks, is a type error.
 */

import {
  MEASUREMENT_COST_METHODS_WORDS,
  MEASUREMENT_DIMENSIONS_WORDS,
  MEASUREMENT_LATENCY_EXCLUSIONS_WORDS,
  MEASUREMENT_LATENCY_METHODS_WORDS,
  MEASUREMENT_LATENCY_SCALING_NOTES_WORDS,
  MEASUREMENT_LATENCY_SCALING_WORDS,
  MEASUREMENT_UNMEASURED_KINDS_WORDS,
  MEASUREMENT_UNMEASURED_REASONS,
  MEASUREMENT_UNMEASURED_REASONS_WORDS,
  MEASUREMENT_VERDICT_RATINGS_WORDS,
  MEASUREMENT_VOICE_BASES_WORDS,
  RESOURCE_HOST_ISOLATIONS_WORDS,
  RESOURCE_HOST_LATENCY_HANDLING_WORDS,
} from "@openmixer/omx-contract";
import { nonEmptyString } from "./guards.js";

/** Pairs each word, in the contract's order, with its description here. */
function described<Code extends string>(
  words: readonly Code[],
  descriptions: Readonly<Record<Code, string>>,
): readonly { readonly code: Code; readonly description: string }[] {
  return words.map((code) => ({ code, description: descriptions[code] }));
}

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
export type UnmeasuredKind = (typeof MEASUREMENT_UNMEASURED_KINDS_WORDS)[number];

/** One reason a figure may be absent: a word of the contract's MEASUREMENT_UNMEASURED_REASONS. */
export type UnmeasuredCode = (typeof MEASUREMENT_UNMEASURED_REASONS_WORDS)[number];

/** One term of the "why is there no figure" vocabulary. */
export interface UnmeasuredTerm {
  readonly code: UnmeasuredCode;
  readonly kind: UnmeasuredKind;
  /** Plain description, English. A UI localises from `code`; this is for logs and specs. */
  readonly description: string;
}

/**
 * Every reason a figure may be absent, in plain English. These were derived from a sweep of 958
 * plugins — each one is an outcome that sweep actually produced, not a hypothetical. The words and
 * their kinds are the contract's.
 */
const UNMEASURED_DESCRIPTIONS: Readonly<Record<UnmeasuredCode, string>> = {
  "no-audio-in":
    "No audio input port: an instrument, a generator or an analyser. Nothing to drive.",
  "no-audio-out":
    "No audio output port: a meter or a sink. Nothing to read.",
  "silent-output":
    "Instantiated and driven, but emitted nothing under a stimulus that should have passed. " +
      "A convolver with no impulse response, a vocoder with no carrier, a gate that never opened.",
  "needs-carrier":
    "Requires a second audio input (a carrier or side-chain) the prober did not supply.",
  "needs-impulse-response":
    "A convolver requiring an IR file the prober did not load.",
  "unpinnable":
    "The files the host loads cannot be pinned (plugin-qualify spec §11.1): a path holding ',', '=' or " +
      "whitespace, a manifest using @base or a percent-encoded IRI, or a CLAP plugin with more parameters than the " +
      "host accepts. The plugin stays unpinned, never partly pinned.",
  "no-voices":
    "An instrument whose voice-info declares a voice capacity of 0: there is no voice to hold down, so its " +
      "cost with notes held cannot be taken.",
  "notes-unplayable":
    "An instrument whose note input reads no dialect the prober speaks (CLAP's or MIDI's): it cannot be played.",
  "voices-unknown":
    "An instrument that declares no voice capacity, measured by a run given no probe count (`--probe-notes`): " +
      "the run did not know how many notes to hold, so it timed none.",
  "refused-instantiation":
    "The plugin would not instantiate at this rate or block size.",
  "probe-crashed":
    "The probe worker died (signal or abort) while hosting this plugin.",
  "probe-timeout":
    "The probe exceeded its per-plugin time limit and was abandoned.",
  "non-finite-output":
    "Output contained NaN or infinity, so no onset or block time could be trusted.",
  "not-installed":
    "The URI was not present in this machine's LV2 world. A fact about this installation, " +
      "not about the plugin — another host may well have it.",
  "worker-nonconforming":
    "The plugin's LV2_Worker_Interface leaves work or work_response NULL, which the LV2 worker " +
      "specification does not allow: it was refused before any call, not measured.",
  "probe-error":
    "The probe reported a failure with no more specific term. Its own words are kept verbatim " +
      "in the measurement's `unmeasuredDetail`, so a coarse code never destroys the detail.",
  "not-attempted":
    "This run did not cover this plugin for this dimension. A partial run, not a finding.",
};

/** Every reason a figure may be absent, in the contract's order, of the contract's kind. */
export const UNMEASURED_TERMS: readonly UnmeasuredTerm[] = Object.values(MEASUREMENT_UNMEASURED_REASONS).map(
  (reason) => ({ code: reason.word, kind: reason.group, description: UNMEASURED_DESCRIPTIONS[reason.word] }),
);

const UNMEASURED_BY_CODE: ReadonlyMap<string, UnmeasuredTerm> = new Map<string, UnmeasuredTerm>(
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

/** A word of the contract's MEASUREMENT_LATENCY_SCALING. */
export type ScalingCode = (typeof MEASUREMENT_LATENCY_SCALING_WORDS)[number];

export const SCALING_TERMS: readonly ScalingTerm[] = described(MEASUREMENT_LATENCY_SCALING_WORDS, {
  "fixed-frame": "Constant frame count at every rate — an FFT window. Milliseconds halve when the rate doubles.",
  "fixed-time": "Constant milliseconds at every rate — a look-ahead. Frames double when the rate doubles.",
  zero: "No latency a mix can notice at any measured rate.",
  nonconforming:
    "Fits neither law at a magnitude that reaches a mix: the plugin changes what it does with " +
    "the rate. Flagged rather than averaged; nothing may be projected from it.",
  "single-rate": "One usable reading, so no law can be fitted.",
  unmeasured: "No rate produced a figure.",
});

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
export const SCALING_NOTE_TERMS = described(MEASUREMENT_LATENCY_SCALING_NOTES_WORDS, {
  "below-budget":
    "The readings fit no law, but every one of them is inside the per-channel latency budget, " +
    "so the disagreement is measurement noise rather than plugin behaviour.",
  "informational-rate":
    "The readings together fit no law, but those at the operational rates (48 kHz and up) do; " +
    "the reading below them stays in perRate as information and does not flag the plugin.",
});

/** One of the {@link SCALING_NOTE_TERMS} codes — the words `latency.scalingNote` may carry. */
export type ScalingNoteCode = (typeof MEASUREMENT_LATENCY_SCALING_NOTES_WORDS)[number];

/**
 * Why one rate's reading was excluded from the fit and from every rate resolution. A
 * failed reading served as an exact answer is worse than no reading, because a zero reads
 * as confidence.
 */
export const EXCLUSION_TERMS: readonly ScalingTerm[] = described(MEASUREMENT_LATENCY_EXCLUSIONS_WORDS, {
  "impossible-zero":
    "Zero frames at this rate while another rate measured non-zero. Both scaling laws map zero " +
    "to zero, so no single latency produces this; the onset detector was defeated.",
});

// ---------------------------------------------------------------------------
// How a figure was taken
// ---------------------------------------------------------------------------

/** How a latency figure was taken: a word of the contract's MEASUREMENT_LATENCY_METHODS. */
export type LatencyMethodCode = (typeof MEASUREMENT_LATENCY_METHODS_WORDS)[number];

/** How a cost figure was taken: a word of the contract's MEASUREMENT_COST_METHODS. */
export type CostMethodCode = (typeof MEASUREMENT_COST_METHODS_WORDS)[number];

/** The measurement methods the format has names for: the latency methods, then the cost methods. */
export const METHOD_TERMS: readonly ScalingTerm[] = [
  ...described(MEASUREMENT_LATENCY_METHODS_WORDS, {
    "impulse-onset":
      "Latency as the round-trip delay from a unit impulse to the first output sample above the " +
      "residual floor. Measures the plugin, not what it declares.",
    "declared-port": "Latency read from the plugin's own lv2:latency output port. What it CLAIMS.",
    "note-onset":
      "An instrument's latency: the delay from a note on to the first output sample above the " +
      "residual floor. Measures what the plugin does with a held note.",
  }),
  ...described(MEASUREMENT_COST_METHODS_WORDS, {
    "block-time-percentile":
      "Cost as a percentile of per-block wall time under a sustained stimulus, warm-up blocks " +
      "discarded, normalised to nanoseconds per sample.",
  }),
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
export const MEASUREMENT_DIMENSIONS = MEASUREMENT_DIMENSIONS_WORDS;

/**
 * The dimensions the standalone prober (`scan.py` + `benchmark.py`, driven by `lv2-measure.mjs`
 * and the console's Setup analysis) can measure. The three hosting dimensions come from a
 * different tool — the native measurer `native/lv2-measure.c`, read by `sweep-jsonl.ts` — so a
 * run asked of the prober for `stability` would be asking it for something it cannot take.
 */
export const PROBED_DIMENSIONS = ["latency", "cost"] as const satisfies readonly (typeof MEASUREMENT_DIMENSIONS)[number][];

/**
 * The dimensions `lv2-measure.mjs`'s hosting pass measures: one run of the native measurer per
 * plugin, under the interposer, writes all three.
 */
export const HOSTING_PASS_DIMENSIONS = ["stability", "rtSafety", "features"] as const satisfies readonly (typeof MEASUREMENT_DIMENSIONS)[number][];

/** One measurable dimension. */
export type MeasurementDimension = (typeof MEASUREMENT_DIMENSIONS)[number];

/** `value` as a dimension, or `undefined` when it is not one. */
export function readDimension(value: unknown): MeasurementDimension | undefined {
  const text = nonEmptyString(value);
  return MEASUREMENT_DIMENSIONS.find((d) => d === text);
}

/**
 * The four ratings a verdict speaks (`lv2-measurement-interchange.md` §3b): the contract's
 * MEASUREMENT_VERDICT_RATINGS. The rating vocabulary (`rating.ts`) derives its type from it, so
 * the document and the classifier can never disagree on a word.
 */
export const VERDICT_RATINGS = MEASUREMENT_VERDICT_RATINGS_WORDS;
export type VerdictRating = (typeof VERDICT_RATINGS)[number];

/** How a host runs its plugins: the contract's RESOURCE_HOST_ISOLATIONS. */
export const HOST_ISOLATIONS = RESOURCE_HOST_ISOLATIONS_WORDS;
export type HostIsolation = (typeof HOST_ISOLATIONS)[number];

/** Whether a host aligns on a plugin's reported latency (`compensated`) or only passes it on: the contract's RESOURCE_HOST_LATENCY_HANDLING. */
export const HOST_LATENCY_HANDLING = RESOURCE_HOST_LATENCY_HANDLING_WORDS;
export type HostLatencyHandling = (typeof HOST_LATENCY_HANDLING)[number];

/**
 * Where the number of notes an instrument's cost was measured with came from: `declared` is the voice
 * capacity the plugin declares (CLAP's voice-info, read after activate at that rate); `probe` is a count
 * the caller gave (`--probe-notes`, the console's `SYNTH_VOICE_PROBE_NOTES`), used when the plugin declares
 * none or when the caller asked for that count whatever it declares.
 */
export const VOICE_BASES = MEASUREMENT_VOICE_BASES_WORDS;
export type VoiceBasis = (typeof VOICE_BASES)[number];

export function isVoiceBasis(value: unknown): value is VoiceBasis {
  return VOICE_BASES.some((b) => b === value);
}
