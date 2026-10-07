// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * What a run is going to do, decided before it starts.
 *
 * Two questions, and #342 answers both in the same breath: *"Measure at least the rates this
 * installation can actually use … but it must not silently fall back to a rate it does not
 * use"*, and *"show progress"* — which needs a duration, which nobody can honestly produce
 * for a machine they have never seen.
 *
 * ## Rates are data, not a constant
 *
 * There is no default rate list in this module and there must never be one. A console that
 * runs 48 k and 96 k does not need 192 k figures; a console whose driver only offers 44.1 k
 * must not be handed a 48 k measurement wearing its label. The plan is derived from what the
 * installation reports — its live rate and its device's supported list — and a request for a
 * rate the hardware does not offer is DROPPED and reported, never honoured.
 *
 * A plan with no rates is a legitimate outcome: it means nobody has told us what this
 * installation runs at, and the correct behaviour is to refuse and say so rather than pick
 * 48 000 because it is a common number.
 *
 * ## Duration is an estimate or it is nothing
 *
 * {@link estimateRunSeconds} scales a REFERENCE run's measured wall time by the work the new
 * plan asks for. With no reference run — or a reference that never recorded its own duration
 * — it returns `undefined`. There is no fallback constant: "about 15 minutes" measured on a
 * Core Ultra 9 is not an estimate for a NUC, and a wrong progress estimate is how an operator
 * ends up cancelling a run that was nearly done.
 */

import { type MeasurementDimension, MEASUREMENT_DIMENSIONS } from "./vocabulary.js";
import type { MeasurementDocument, MeasurementRun } from "./format.js";

/** What the installation knows about its own clock, as far as the plan is concerned. */
export interface InstallationRates {
  /** The rate the graph is running at right now, when the console knows it. */
  readonly liveRate?: number;
  /** Rates the active device actually offers. Empty/absent = the console has not probed. */
  readonly supportedRates?: readonly number[];
  /** Rates the operator asked for. Absent = "whatever this installation can use". */
  readonly requestedRates?: readonly number[];
}

/** The rates a run will measure at, and what was left out on the way there. */
export interface RatePlan {
  /** Rates to measure, ascending. Empty when nothing could be resolved. */
  readonly rates: readonly number[];
  /**
   * Rates the operator asked for that the installation does not offer. Reported, not
   * measured — a figure at a rate the rig cannot run is a figure nobody will ever use, and
   * quietly measuring it would make the run longer for nothing.
   */
  readonly dropped: readonly number[];
  /**
   * Set when {@link rates} is empty: `no-rates-known`. The console could name neither a
   * live rate nor a supported list, so there is nothing to measure and no safe guess.
   */
  readonly problem?: string;
}

/**
 * Resolve the rates a local run should measure at.
 *
 * The live rate is always included when known — a console must have figures for the rate it
 * is running at, whatever else the operator asked for. Beyond that: the requested rates
 * intersected with what the device offers, or, absent a request, the whole supported list.
 */
export function ratesForInstallation(input: InstallationRates): RatePlan {
  const supported = [...new Set((input.supportedRates ?? []).filter((r) => Number.isFinite(r) && r > 0))];
  const live = input.liveRate !== undefined && Number.isFinite(input.liveRate) && input.liveRate > 0
    ? input.liveRate
    : undefined;
  // What this installation can actually use: the device list, plus the rate it is demonstrably
  // running at (a live rate absent from the probed list is the device telling us the list is
  // incomplete, not the other way round).
  const usable = new Set(supported);
  if (live !== undefined) usable.add(live);

  const requested = input.requestedRates?.filter((r) => Number.isFinite(r) && r > 0);
  if (requested === undefined || requested.length === 0) {
    const rates = [...usable].sort((a, b) => a - b);
    return rates.length > 0
      ? { rates, dropped: [] }
      : { rates: [], dropped: [], problem: "no-rates-known" };
  }

  const wanted = new Set(requested);
  if (live !== undefined) wanted.add(live);
  const rates = [...wanted].filter((r) => usable.has(r)).sort((a, b) => a - b);
  const dropped = [...wanted].filter((r) => !usable.has(r)).sort((a, b) => a - b);
  return rates.length > 0
    ? { rates, dropped }
    : { rates: [], dropped, problem: "no-rates-known" };
}

/** A run, fully specified, before anything is probed. */
export interface MeasurementPlan {
  readonly rates: readonly number[];
  readonly dimensions: readonly MeasurementDimension[];
  /** Rates asked for and dropped as unusable here — carried through so the UI can say so. */
  readonly droppedRates: readonly number[];
  /** How many plugins the run will visit, when a scan has already told us. */
  readonly pluginCount?: number;
  /** Set when the plan cannot run: `no-rates-known` / `no-dimensions`. */
  readonly problem?: string;
}

/** Build a plan from resolved rates and the dimensions the operator chose. */
export function measurementPlan(
  ratePlan: RatePlan,
  dimensions: readonly MeasurementDimension[],
  pluginCount?: number,
): MeasurementPlan {
  const wanted = MEASUREMENT_DIMENSIONS.filter((d) => dimensions.includes(d));
  const problem = ratePlan.problem ?? (wanted.length === 0 ? "no-dimensions" : undefined);
  return {
    rates: ratePlan.rates,
    dimensions: wanted,
    droppedRates: ratePlan.dropped,
    ...(pluginCount === undefined ? {} : { pluginCount }),
    ...(problem === undefined ? {} : { problem }),
  };
}

/** True when a plan has enough to run: at least one rate and at least one dimension. */
export function isRunnablePlan(plan: MeasurementPlan): boolean {
  return plan.problem === undefined && plan.rates.length > 0 && plan.dimensions.length > 0;
}

/**
 * The unit of work a plan represents: plugins × rates × dimensions.
 *
 * Crude on purpose. A convolution reverb costs more than a gain, but the prober caps each
 * plugin's wall time, so over a whole catalogue the product is close enough to scale a
 * measured duration by — and a more elaborate model would imply a precision the estimate
 * does not have.
 */
export function planWorkUnits(plan: MeasurementPlan): number | undefined {
  if (plan.pluginCount === undefined) return undefined;
  return plan.pluginCount * plan.rates.length * plan.dimensions.length;
}

/** A duration estimate, with the run it was extrapolated from named. */
export interface RunEstimate {
  readonly seconds: number;
  /** The reference run's id, host and duration — everything needed to render "on <host>,
   *  <n> plugins took <t>", so the operator can judge the extrapolation themselves. */
  readonly basis: {
    readonly runId: string;
    readonly host: string;
    readonly seconds: number;
    readonly workUnits: number;
  };
}

/** The work a completed run represents, from its own document. */
function runWorkUnits(document: MeasurementDocument): number | undefined {
  const units = document.plugins.length * document.run.rates.length * document.run.dimensions.length;
  return units > 0 ? units : undefined;
}

/**
 * How long this plan is likely to take, extrapolated from a run that actually happened.
 *
 * `undefined` whenever it cannot be derived — no reference document, the reference never
 * recorded `elapsedSeconds`, or the plan does not yet know its plugin count. An unknown
 * duration is reported as unknown; there is no constant to fall back on and inventing one
 * would be the exact dishonesty the provenance discipline exists to prevent.
 *
 * When the reference ran on ANOTHER machine the estimate is still only an order of
 * magnitude — which is why {@link RunEstimate.basis} names the host rather than hiding it.
 */
export function estimateRunSeconds(
  plan: MeasurementPlan,
  reference: MeasurementDocument | undefined,
): RunEstimate | undefined {
  if (reference === undefined) return undefined;
  const elapsed = reference.run.elapsedSeconds;
  if (elapsed === undefined || !(elapsed > 0)) return undefined;
  const referenceUnits = runWorkUnits(reference);
  const planUnits = planWorkUnits(plan);
  if (referenceUnits === undefined || planUnits === undefined || planUnits === 0) return undefined;
  return {
    seconds: (elapsed * planUnits) / referenceUnits,
    basis: {
      runId: reference.run.id,
      host: reference.run.host.hostname,
      seconds: elapsed,
      workUnits: referenceUnits,
    },
  };
}

/**
 * Rates a completed run covers that the installation no longer cares about, and rates the
 * installation now uses that the run never covered.
 *
 * The second list is #342's rate-change case: the operator moved the rig to 96 kHz, so the
 * figures for 96 kHz are MISSING rather than wrong, and the console should offer to measure
 * them instead of interpolating across a boundary 19 nonconforming plugins prove cannot be
 * interpolated across.
 */
export interface RateCoverage {
  readonly covered: readonly number[];
  readonly missing: readonly number[];
  readonly extra: readonly number[];
}

/** Compare a run's rates against the rates an installation now uses. */
export function rateCoverage(run: MeasurementRun | undefined, needed: readonly number[]): RateCoverage {
  const have = new Set(run?.rates ?? []);
  const want = [...new Set(needed)].sort((a, b) => a - b);
  return {
    covered: want.filter((rate) => have.has(rate)),
    missing: want.filter((rate) => !have.has(rate)),
    extra: [...have].filter((rate) => !want.includes(rate)).sort((a, b) => a - b),
  };
}
