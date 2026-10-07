// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * **Shipped defaults, overridden by local measurement** (issue #342) — and the operator can
 * always see which is which.
 *
 * The rule is one sentence: *what we ship is a sensible default; a local run overrides it.*
 * Everything below is what that sentence costs once you refuse to lie about the result.
 *
 * ## Why the merge is per plugin per DIMENSION, and not per rate
 *
 * The tempting rule — "take the local figure wherever there is one, rate by rate" — would
 * produce a plugin whose 48 kHz cost came from the customer's NUC and whose 96 kHz cost came
 * from our reference laptop. The scaling class then gets fitted across two machines, and the
 * ratio between the two rates, the one thing per-rate data exists to express, becomes an
 * artefact of the hardware difference. It would look like data and behave like noise.
 *
 * So a local run REPLACES a plugin's whole dimension or none of it. A rate the local run did
 * not cover comes back as MISSING, not as the shipped number wearing a local label
 * ({@link MergedMeasurements.missingRates}) — which is exactly what #342 asks for when the
 * operator later adds a rate: *"the affected figures are missing rather than wrong — surface
 * that, and offer to measure the new rate rather than quietly interpolating."*
 *
 * ## Why a failed local probe does NOT override
 *
 * A local run that crashed on a plugin has learned nothing about that plugin's latency. If
 * the failure overrode, one segfault would delete a good shipped figure and the operator's
 * catalogue would get worse the more they measured. So the vocabulary's `kind` decides
 * ({@link ../vocabulary.unmeasuredKind}):
 *
 * - `nothing-to-measure` (no audio in, no audio out, silent) — a property of the PLUGIN, as
 *   portable as a measurement. It overrides.
 * - `probe-failed` (crashed, timed out, refused, non-finite) — a property of THIS RUN. The
 *   shipped figure stands, and the local failure is still reported
 *   ({@link MergedPluginMeasurement.localProbeFailed}) so the operator sees that their
 *   machine could not reproduce it.
 * - `not-attempted` — a partial run. Not a finding at all.
 *
 * An UNKNOWN reason code from a third-party document resolves to `probe-failed`: a word we
 * cannot interpret must never be allowed to delete a real measurement.
 */

import type {
  CostMeasurement,
  FeaturesMeasurement,
  LatencyMeasurement,
  MeasurementDocument,
  MeasuredPlugin,
  MeasurementRun,
  RtSafetyMeasurement,
  StabilityMeasurement,
} from "./format.js";
import { type MeasurementDimension, MEASUREMENT_DIMENSIONS, unmeasuredKind } from "./vocabulary.js";

/** Where a figure came from. Two words, because the operator only ever has two questions. */
export type FigureSource = "local" | "shipped";

/** Every source, in the order precedence resolves them (highest first). */
export const FIGURE_SOURCES: readonly FigureSource[] = ["local", "shipped"];

/** One dimension's resolved figure, with the run that produced it named. */
export interface ResolvedFigure<T> {
  readonly source: FigureSource;
  /** {@link MeasurementRun.id} of the run this came from. */
  readonly runId: string;
  /** The run's host, denormalised so a surface can label a figure without a second lookup. */
  readonly host: string;
  readonly measuredAt: string;
  readonly value: T;
  /** Rates this figure actually covers, ascending. */
  readonly rates: readonly number[];
}

/** One plugin as the merged view sees it. */
export interface MergedPluginMeasurement {
  readonly uri: string;
  /** Best available identity — the local run's, falling back to the shipped one's. */
  readonly plugin: MeasuredPlugin;
  readonly latency?: ResolvedFigure<LatencyMeasurement>;
  readonly cost?: ResolvedFigure<CostMeasurement>;
  readonly stability?: ResolvedFigure<StabilityMeasurement>;
  readonly rtSafety?: ResolvedFigure<RtSafetyMeasurement>;
  readonly features?: ResolvedFigure<FeaturesMeasurement>;
  /**
   * Dimensions where the LOCAL run tried and failed (crashed, timed out, refused), keyed
   * by dimension with the reason code. The shipped figure is still in use for these —
   * that is the point — but the operator is told their machine could not reproduce it.
   */
  readonly localProbeFailed?: Readonly<Partial<Record<MeasurementDimension, string>>>;
  /** Present only on a plugin installed here that the shipped catalogue never saw. */
  readonly localOnly?: true;
}

/** Counts a Setup screen can render without walking the catalogue itself. */
export interface MergeSummary {
  readonly plugins: number;
  /** Plugins whose figure for this dimension came from each source. */
  readonly bySource: Readonly<Record<MeasurementDimension, Readonly<Record<FigureSource, number>>>>;
  /** Plugins with no figure at all for this dimension, from either source. */
  readonly unresolved: Readonly<Record<MeasurementDimension, number>>;
  /** Plugins present locally and absent from the shipped catalogue. */
  readonly localOnly: number;
  /** Plugins the local run tried and failed on, per dimension. */
  readonly localProbeFailures: Readonly<Record<MeasurementDimension, number>>;
}

/** One dimension's block, whatever the dimension. */
type AnyMeasurement =
  | LatencyMeasurement
  | CostMeasurement
  | StabilityMeasurement
  | RtSafetyMeasurement
  | FeaturesMeasurement;

/** Each dimension's block type, so a resolved figure keeps the type of the block it holds. */
interface MeasurementOf {
  readonly latency: LatencyMeasurement;
  readonly cost: CostMeasurement;
  readonly stability: StabilityMeasurement;
  readonly rtSafety: RtSafetyMeasurement;
  readonly features: FeaturesMeasurement;
}

function dimensionOf<D extends MeasurementDimension>(
  plugin: MeasuredPlugin,
  dimension: D,
): MeasurementOf[D] | undefined {
  const blocks: { readonly [K in MeasurementDimension]: MeasurementOf[K] | undefined } = {
    latency: plugin.latency,
    cost: plugin.cost,
    stability: plugin.stability,
    rtSafety: plugin.rtSafety,
    features: plugin.features,
  };
  return blocks[dimension];
}

/** A merged entry's resolved figure for one dimension. */
function resolvedOf<D extends MeasurementDimension>(
  entry: MergedPluginMeasurement | undefined,
  dimension: D,
): ResolvedFigure<MeasurementOf[D]> | undefined {
  if (entry === undefined) return undefined;
  const figures: { readonly [K in MeasurementDimension]: ResolvedFigure<MeasurementOf[K]> | undefined } = {
    latency: entry.latency,
    cost: entry.cost,
    stability: entry.stability,
    rtSafety: entry.rtSafety,
    features: entry.features,
  };
  return figures[dimension];
}

/** Rates a measurement actually carries, ascending. Excluded readings still count as
 *  covered: the rate WAS measured, and the exclusion is the finding. A soak covers the rates
 *  it rendered, an interposer count the one rate it ran at, and a feature list no rate at all. */
function ratesOf(measurement: AnyMeasurement): number[] {
  const keys =
    "perRate" in measurement
      ? Object.keys(measurement.perRate)
      : "soak" in measurement && measurement.soak !== undefined
        ? Object.keys(measurement.soak.perRate)
        : "rate" in measurement && measurement.rate !== undefined
          ? [String(measurement.rate)]
          : [];
  return keys
    .map(Number)
    .filter((rate) => Number.isFinite(rate))
    .sort((a, b) => a - b);
}

/**
 * True when a measurement carries a READING rather than only a reason. Per dimension, because
 * what a reading is differs: latency and cost need a rate; a stability block needs its
 * lifecycle, an rt-safety block all three counts, a features block its required list.
 */
function hasReadings(dimension: MeasurementDimension, measurement: AnyMeasurement | undefined): boolean {
  if (measurement === undefined) return false;
  switch (dimension) {
    case "latency":
    case "cost":
      return "perRate" in measurement && Object.keys(measurement.perRate).length > 0;
    case "stability":
      return "lifecycle" in measurement && measurement.lifecycle !== undefined;
    case "rtSafety":
      return (
        "allocationsInRun" in measurement &&
        measurement.allocationsInRun !== undefined &&
        "locksInRun" in measurement &&
        measurement.locksInRun !== undefined &&
        "syscallsInRun" in measurement &&
        measurement.syscallsInRun !== undefined
      );
    case "features":
      return "required" in measurement && measurement.required !== undefined;
  }
}

function figure<T extends AnyMeasurement>(
  source: FigureSource,
  run: MeasurementRun,
  value: T,
): ResolvedFigure<T> {
  return {
    source,
    runId: run.id,
    host: run.host.hostname,
    measuredAt: run.measuredAt,
    value,
    rates: ratesOf(value),
  };
}

/** `{ [dimension]: figure }` when there is one, `{}` otherwise. */
function optionalFigure<K extends MeasurementDimension, T>(
  dimension: K,
  value: ResolvedFigure<T> | undefined,
): { [P in K]?: ResolvedFigure<T> } {
  if (value === undefined) return {};
  const out: { [P in K]?: ResolvedFigure<T> } = {};
  out[dimension] = value;
  return out;
}

/**
 * The precedence decision for ONE plugin and ONE dimension, expressed once.
 *
 * Returns the winning figure, plus the local failure reason when the local run tried and
 * could not — the two outputs are independent, because "the shipped figure won" and "your
 * machine crashed on it" are both true at the same time and the operator needs both.
 */
function resolveDimension<T extends AnyMeasurement>(
  dimension: MeasurementDimension,
  local: { readonly run: MeasurementRun; readonly measurement: T | undefined } | undefined,
  shipped: { readonly run: MeasurementRun; readonly measurement: T | undefined } | undefined,
): { readonly resolved?: ResolvedFigure<T>; readonly localFailure?: string } {
  const shippedFigure =
    shipped?.measurement !== undefined && hasReadings(dimension, shipped.measurement)
      ? figure("shipped", shipped.run, shipped.measurement)
      : undefined;

  if (local === undefined || local.measurement === undefined) {
    return shippedFigure === undefined ? {} : { resolved: shippedFigure };
  }
  // The local run covered this dimension and measured this plugin: it wins outright.
  if (hasReadings(dimension, local.measurement)) {
    return { resolved: figure("local", local.run, local.measurement) };
  }
  // No readings locally. What the local run learned depends entirely on WHY.
  const kind = unmeasuredKind(local.measurement.unmeasuredReason);
  if (kind === "nothing-to-measure") {
    // A plugin property, as portable as a measurement — it overrides, with no number.
    return { resolved: figure("local", local.run, local.measurement) };
  }
  if (kind === "probe-failed") {
    return {
      ...(shippedFigure === undefined ? {} : { resolved: shippedFigure }),
      ...(local.measurement.unmeasuredReason === undefined
        ? {}
        : { localFailure: local.measurement.unmeasuredReason }),
    };
  }
  // not-attempted: the local run has no opinion here.
  return shippedFigure === undefined ? {} : { resolved: shippedFigure };
}

/**
 * The merged view an installation reads: shipped defaults with local measurements laid over
 * them, every figure still knowing where it came from.
 *
 * Built once from two documents and then queried — the precedence rule runs at construction,
 * so no consumer can accidentally re-implement half of it. A missing local document is the
 * normal state (nobody has measured yet) and yields a view that is entirely `shipped`.
 */
export class MergedMeasurements {
  private readonly merged: ReadonlyMap<string, MergedPluginMeasurement>;

  constructor(
    private readonly shipped: MeasurementDocument | undefined,
    private readonly local: MeasurementDocument | undefined,
  ) {
    const shippedByUri = new Map((shipped?.plugins ?? []).map((p) => [p.uri, p]));
    const localByUri = new Map((local?.plugins ?? []).map((p) => [p.uri, p]));
    const uris = [...new Set([...shippedByUri.keys(), ...localByUri.keys()])].sort();

    const merged = new Map<string, MergedPluginMeasurement>();
    for (const uri of uris) {
      const shippedPlugin = shippedByUri.get(uri);
      const localPlugin = localByUri.get(uri);
      const identity = localPlugin ?? shippedPlugin;
      if (identity === undefined) continue;

      const resolve = <D extends MeasurementDimension>(dimension: D) =>
        resolveDimension<MeasurementOf[D]>(
          dimension,
          local !== undefined && localPlugin !== undefined
            ? { run: local.run, measurement: dimensionOf(localPlugin, dimension) }
            : undefined,
          shipped !== undefined && shippedPlugin !== undefined
            ? { run: shipped.run, measurement: dimensionOf(shippedPlugin, dimension) }
            : undefined,
        );
      const latency = resolve("latency");
      const cost = resolve("cost");
      const stability = resolve("stability");
      const rtSafety = resolve("rtSafety");
      const features = resolve("features");
      const failures: Partial<Record<MeasurementDimension, string>> = {};
      const outcomes = { latency, cost, stability, rtSafety, features };
      for (const dimension of MEASUREMENT_DIMENSIONS) {
        const failure = outcomes[dimension].localFailure;
        if (failure !== undefined) failures[dimension] = failure;
      }

      merged.set(uri, {
        uri,
        plugin: identity,
        ...optionalFigure("latency", latency.resolved),
        ...optionalFigure("cost", cost.resolved),
        ...optionalFigure("stability", stability.resolved),
        ...optionalFigure("rtSafety", rtSafety.resolved),
        ...optionalFigure("features", features.resolved),
        ...(Object.keys(failures).length > 0 ? { localProbeFailed: failures } : {}),
        ...(shippedPlugin === undefined ? { localOnly: true } : {}),
      });
    }
    this.merged = merged;
  }

  /** The run behind each source, when that source has a document. */
  runFor(source: FigureSource): MeasurementRun | undefined {
    return source === "local" ? this.local?.run : this.shipped?.run;
  }

  /** Every merged plugin, URI-ascending. */
  all(): MergedPluginMeasurement[] {
    return [...this.merged.values()];
  }

  get(uri: string): MergedPluginMeasurement | undefined {
    return this.merged.get(uri);
  }

  get size(): number {
    return this.merged.size;
  }

  /**
   * Where this plugin's figure for `dimension` came from, or `undefined` when there is no
   * figure at all. THE question a UI asks per row, so it is one call and not a walk.
   */
  sourceOf(uri: string, dimension: MeasurementDimension): FigureSource | undefined {
    return resolvedOf(this.merged.get(uri), dimension)?.source;
  }

  /** Every URI whose `dimension` figure came from `source`, URI-ascending. */
  urisFrom(source: FigureSource, dimension: MeasurementDimension): string[] {
    return this.all()
      .filter((entry) => resolvedOf(entry, dimension)?.source === source)
      .map((entry) => entry.uri);
  }

  /**
   * Rates in `wanted` this plugin has NO figure for, on the dimension asked about.
   *
   * The honest answer to "the rig now runs at 96 kHz too": the rates the resolved figure
   * does not cover are missing, and a surface should offer to measure them rather than
   * project across a boundary the data says cannot be projected across.
   */
  missingRates(uri: string, dimension: MeasurementDimension, wanted: readonly number[]): number[] {
    const resolved = resolvedOf(this.merged.get(uri), dimension);
    if (resolved === undefined) return [...wanted].sort((a, b) => a - b);
    const covered = new Set(resolved.rates);
    return wanted.filter((rate) => !covered.has(rate)).sort((a, b) => a - b);
  }

  /**
   * Plugins whose resolved figure does not cover every rate in `wanted`, per dimension.
   * What a "your local run does not cover 96 kHz" banner counts.
   */
  pluginsMissingRates(dimension: MeasurementDimension, wanted: readonly number[]): string[] {
    return this.all()
      .filter((entry) => {
        const resolved = resolvedOf(entry, dimension);
        // A plugin with nothing to measure is not missing a rate; it has a reason.
        if (resolved !== undefined && resolved.value.unmeasuredReason !== undefined) return false;
        return this.missingRates(entry.uri, dimension, wanted).length > 0;
      })
      .map((entry) => entry.uri);
  }

  /** The counts a Setup screen renders. */
  summary(): MergeSummary {
    const zeroes = (): Record<MeasurementDimension, number> => ({
      latency: 0,
      cost: 0,
      stability: 0,
      rtSafety: 0,
      features: 0,
    });
    const bySource: Record<MeasurementDimension, Record<FigureSource, number>> = {
      latency: { local: 0, shipped: 0 },
      cost: { local: 0, shipped: 0 },
      stability: { local: 0, shipped: 0 },
      rtSafety: { local: 0, shipped: 0 },
      features: { local: 0, shipped: 0 },
    };
    const unresolved = zeroes();
    const localProbeFailures = zeroes();
    let localOnly = 0;

    for (const entry of this.merged.values()) {
      if (entry.localOnly === true) localOnly += 1;
      for (const dimension of MEASUREMENT_DIMENSIONS) {
        const resolved = resolvedOf(entry, dimension);
        if (resolved === undefined) unresolved[dimension] += 1;
        else bySource[dimension][resolved.source] += 1;
        if (entry.localProbeFailed?.[dimension] !== undefined) localProbeFailures[dimension] += 1;
      }
    }
    return { plugins: this.merged.size, bySource, unresolved, localOnly, localProbeFailures };
  }
}

/** Convenience over the constructor, for call sites that read better as a function. */
export function mergeMeasurements(
  shipped: MeasurementDocument | undefined,
  local: MeasurementDocument | undefined,
): MergedMeasurements {
  return new MergedMeasurements(shipped, local);
}

/** Re-exported so a consumer of the merge does not also have to import the format. */
export { dimensionOf as measurementForDimension };
