// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The measurement grid (#193): the cells, each one rate and one quantum, a plugin is measured at, and the runs of the
 * probe runner that measure them. A host is judged at its own cell, so the grid a run takes is chosen from the hosts it
 * judges; README "The measurement grid" states the three ways of choosing it and the order the cells are taken in.
 *
 * Pure: no file, no process. `probe-runner.ts` runs what `runnerInvocations` plans.
 */
import { GRID_CONTINUITY_QUANTUM } from "./qualify-declarations.js";

/** One cell of the grid. */
export interface GridCell {
  readonly rate: number;
  readonly quantum: number;
}

/** How the grid is chosen: the hosts' cells, the full product of the rates and quanta, or the cells named. */
export type GridSpec = { readonly kind: "hosts" } | { readonly kind: "full" } | { readonly kind: "cells"; readonly cells: readonly GridCell[] };

export const GRID_HOSTS: GridSpec = { kind: "hosts" };
export const GRID_FULL: GridSpec = { kind: "full" };

export const cellKey = (c: GridCell): string => `${String(c.rate)}/${String(c.quantum)}`;

const positive = (t: string): number | undefined => {
  const n = Number(t);
  return /^\d+$/.test(t) && Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

/** `hosts`, `full`, or `<rate>/<quantum>,...`; anything else is refused with what was wrong. */
export function parseGridSpec(text: string): { ok: true; spec: GridSpec } | { ok: false; error: string } {
  const t = text.trim();
  if (t === "hosts") return { ok: true, spec: GRID_HOSTS };
  if (t === "full") return { ok: true, spec: GRID_FULL };
  const cells: GridCell[] = [];
  for (const part of t.split(",").map((p) => p.trim())) {
    const m = /^(\d+)\/(\d+)$/.exec(part);
    const rate = m === null ? undefined : positive(m[1]!);
    const quantum = m === null ? undefined : positive(m[2]!);
    if (rate === undefined || quantum === undefined) {
      return { ok: false, error: `the grid is hosts, full, or cells as <rate>/<quantum>, comma-separated; "${part}" is none of them` };
    }
    cells.push({ rate, quantum });
  }
  return { ok: true, spec: { kind: "cells", cells: unique(cells) } };
}

function unique(cells: readonly GridCell[]): GridCell[] {
  const seen = new Set<string>();
  return cells.filter((c) => (seen.has(cellKey(c)) ? false : (seen.add(cellKey(c)), true)));
}

const byRateThenQuantum = (a: GridCell, b: GridCell): number => a.rate - b.rate || a.quantum - b.quantum;

/**
 * The cells of a grid, in the order they are taken: for `hosts`, each host's own cell in the order the hosts are given,
 * then `GRID_CONTINUITY_QUANTUM` at every rate; for `full`, those cells first as well, then the rest of the product by
 * rate and quantum; for named cells, as named. A cell is listed once.
 */
export function gridCells(
  spec: GridSpec,
  context: { readonly rates: readonly number[]; readonly quanta: readonly number[]; readonly hosts: readonly GridCell[] },
): GridCell[] {
  if (spec.kind === "cells") return unique(spec.cells);
  const continuity = [...context.rates].sort((a, b) => a - b).map((rate) => ({ rate, quantum: GRID_CONTINUITY_QUANTUM }));
  const lead = unique([...context.hosts, ...continuity]);
  if (spec.kind === "hosts") return lead;
  const product = context.rates.flatMap((rate) => context.quanta.map((quantum) => ({ rate, quantum }))).sort(byRateThenQuantum);
  const inProduct = new Set(product.map(cellKey));
  // the full grid is the product: a host's cell outside --rates x --quanta is not part of it
  return unique([...lead.filter((c) => inProduct.has(cellKey(c))), ...product]);
}

/** The cells a host is judged at: the one its cost is read at, then the others its memory budget says it runs. */
export function hostCells(profile: { readonly cost: GridCell & { readonly memory?: { readonly cells?: readonly GridCell[] } } }): GridCell[] {
  return unique([{ rate: profile.cost.rate, quantum: profile.cost.quantum }, ...(profile.cost.memory?.cells ?? [])]);
}

/** The first `budget` cells, or every one when the budget is absent or 0. */
export function budgetCells(cells: readonly GridCell[], budget: number | undefined): GridCell[] {
  return budget === undefined || budget === 0 ? [...cells] : cells.slice(0, budget);
}

/** One run of the probe runner: the rates it is given, its quantum, and the cells it stands for. */
export interface RunnerInvocation {
  readonly rates: readonly number[];
  readonly quantum: number;
  readonly cells: readonly GridCell[];
}

/**
 * The runs that measure `cells`. A CLAP plugin is run once per quantum, at every rate of the grid at that quantum (the
 * prober takes a list of rates and one block size). An LV2 plugin is run once per cell: plugin-hostd's runner measures
 * an LV2 plugin at one rate a run, the highest of the rates it is given, so a list would measure only that one.
 */
export function runnerInvocations(format: string, cells: readonly GridCell[]): RunnerInvocation[] {
  if (format !== "clap") return cells.map((c) => ({ rates: [c.rate], quantum: c.quantum, cells: [c] }));
  const byQuantum = new Map<number, GridCell[]>();
  for (const c of cells) byQuantum.set(c.quantum, [...(byQuantum.get(c.quantum) ?? []), c]);
  return [...byQuantum.entries()].map(([quantum, at]) => ({ rates: [...new Set(at.map((c) => c.rate))].sort((a, b) => a - b), quantum, cells: at }));
}
