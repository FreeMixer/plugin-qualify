// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * What a measured footprint comes to, and whether it fits a host's budget. Pure: the readings come from the measurers, the
 * budget from the host profile, and the verdict's reasons from `hosting-suitability.ts`.
 *
 * Two figures come out of a footprint. `firstInstanceKb` is the most one instance held at any step, with everything its
 * instances share. `perInstanceKb` is what one more instance costs: the second instance's own part and its voices. A host's
 * `perInstanceKb` bounds the second and its `perConsoleKb` the first, so a sampler with a large library shared between
 * instances can fit a small host once and still be read correctly for two.
 *
 * Nothing absent reads as fitting: no figure, or a reason beside the figures, is `unmeasured`.
 */
import type { HostMemoryBudget, MemoryFootprint } from "./measurement/format.js";

/** A plugin's footprints as a verdict reads them: per rate, or per rate and quantum (a probe output's grid). */
export interface MemoryReadings {
  readonly perRate?: Readonly<Record<string, MemoryFootprint>>;
  readonly perRateQuantum?: Readonly<Record<string, MemoryFootprint>>;
}

/** The most one instance held at any step, with everything its instances share. `undefined` for no figure. */
export function firstInstanceKb(f: MemoryFootprint): number | undefined {
  const figures = [f.afterInstantiateKb, f.afterActivateKb, f.atRestKb, f.notesHeldKb].filter((v): v is number => v !== undefined);
  return figures.length === 0 ? undefined : Math.max(...figures);
}

/**
 * What one more instance costs: the second instance's own part and the voices of this one. With no second instance
 * measured, the whole of the first, since nothing separates what it shares.
 */
export function perInstanceKb(f: MemoryFootprint): number | undefined {
  const first = firstInstanceKb(f);
  if (first === undefined) return undefined;
  if (f.secondInstanceKb === undefined) return first;
  const voices = f.notesHeldKb !== undefined && f.atRestKb !== undefined ? Math.max(f.notesHeldKb - f.atRestKb, 0) : 0;
  return f.secondInstanceKb + voices;
}

export type MemoryBudgetRead =
  | { readonly outcome: "within"; readonly perInstanceKb: number; readonly firstInstanceKb: number }
  | { readonly outcome: "above"; readonly figure: "perInstance" | "firstInstance"; readonly kb: number; readonly ceilingKb: number }
  | { readonly outcome: "unmeasured"; readonly unmeasuredReason?: string };

/** A footprint against a budget. A missing figure is `"unmeasured"`, never a fit; a figure above a ceiling is above it whatever else is missing. */
export function memoryWithinBudget(footprint: MemoryFootprint | undefined, budget: HostMemoryBudget): MemoryBudgetRead {
  const first = footprint === undefined ? undefined : firstInstanceKb(footprint);
  const per = footprint === undefined ? undefined : perInstanceKb(footprint);
  if (first !== undefined && first > budget.perConsoleKb) return { outcome: "above", figure: "firstInstance", kb: first, ceilingKb: budget.perConsoleKb };
  if (per !== undefined && per > budget.perInstanceKb) return { outcome: "above", figure: "perInstance", kb: per, ceilingKb: budget.perInstanceKb };
  if (first === undefined || per === undefined || footprint?.unmeasuredReason !== undefined) {
    return { outcome: "unmeasured", ...(footprint?.unmeasuredReason === undefined ? {} : { unmeasuredReason: footprint.unmeasuredReason }) };
  }
  return { outcome: "within", perInstanceKb: per, firstInstanceKb: first };
}
