// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The ONE declaration of how a cost reading is named on each side of the landing door, and the
 * only reader of those names.
 *
 * The interchange document names the headline cost figure `nsPerSamplePercentile` (the percentile
 * is a property of the run); the classifier's cost gate judges `nsPerSampleP95` and
 * `coreFractionP95`. A hand join that leaves the classifier's fields undefined makes
 * `undefined > ceiling` false, and the gate passes every plugin. So the names live here once,
 * the gate asks {@link costFieldsMissing} before it compares anything, and a reading that lacks
 * a field is REFUSED, never passed by absence.
 */
import type { CostAtRate } from "./measurement/format.js";
import { isRecord } from "./measurement/guards.js";

/** The figures the cost gate judges, per rate: what a plugin's `cpuCost.perRate[rate]` must carry. */
export interface ClassifierCostReading {
  readonly nsPerSampleMedian: number;
  readonly nsPerSampleP95: number;
  readonly coreFractionP95: number;
}

/**
 * Field names, by side. Each side's names are checked against its own type, so renaming a field
 * in the document type or the classifier type is a compile error here, not a silent `undefined`.
 */
export const COST_FIELDS = {
  document: { median: "nsPerSampleMedian", percentile: "nsPerSamplePercentile" },
  classifier: { median: "nsPerSampleMedian", percentile: "nsPerSampleP95", coreFraction: "coreFractionP95" },
} as const satisfies {
  document: Record<string, keyof CostAtRate>;
  classifier: Record<string, keyof ClassifierCostReading>;
};

/** Nanoseconds in one second: the constant every budget figure divides by. */
const NS_PER_SECOND = 1e9;

/**
 * Fraction of one core a cost of `nsPerSample` takes at `rate`. `undefined` for a non-positive
 * rate or a non-finite cost: an unmeasurable cost is never a cheap one.
 */
export function coreFraction(nsPerSample: number, rate: number): number | undefined {
  if (!(rate > 0) || !Number.isFinite(nsPerSample)) return undefined;
  return (nsPerSample * rate) / NS_PER_SECOND;
}

/** The classifier fields `reading` lacks (absent, or not a finite number). Empty = judgeable. */
export function costFieldsMissing(reading: unknown): string[] {
  const record = isRecord(reading) ? reading : {};
  return Object.values(COST_FIELDS.classifier).filter((name) => {
    const v = record[name];
    return typeof v !== "number" || !Number.isFinite(v);
  });
}

/**
 * A document's cost reading as the figures the cost gate judges, or `undefined` when the rate or
 * a figure is unusable. The derived `coreFractionP95` is computed here, from the measured
 * primitive: derived figures are not carried in the document.
 */
export function classifierCostFromDocument(reading: CostAtRate, rate: number): ClassifierCostReading | undefined {
  const median = reading[COST_FIELDS.document.median];
  const p95 = reading[COST_FIELDS.document.percentile];
  const fraction = coreFraction(p95, rate);
  if (fraction === undefined || !Number.isFinite(median)) return undefined;
  return {
    [COST_FIELDS.classifier.median]: median,
    [COST_FIELDS.classifier.percentile]: p95,
    [COST_FIELDS.classifier.coreFraction]: fraction,
  };
}
