// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The measurement grid (#193), as cells and as runs of the runner: the hosts' grid holds every shipped host's own
 * rate and quantum and 512 at every rate, the full grid every rate at every quantum, and an LV2 plugin is planned
 * on the same cells as a CLAP one, one run a cell.
 */
import { describe, expect, it } from "vitest";

import { HOST_PROFILES } from "./host-profiles.js";
import { budgetCells, cellKey, gridCells, parseGridSpec, runnerInvocations, GRID_FULL, GRID_HOSTS } from "./measurement-grid.js";
import { GRID_CONTINUITY_QUANTUM, QUALIFY_QUANTA, QUALIFY_RATES } from "./qualify-declarations.js";

const HOSTS = HOST_PROFILES.map((p) => ({ rate: p.cost.rate, quantum: p.cost.quantum }));
const context = { rates: QUALIFY_RATES, quanta: QUALIFY_QUANTA, hosts: HOSTS };
const keys = (cells: readonly { rate: number; quantum: number }[]) => cells.map(cellKey);

describe("the cells of a grid", () => {
  it("hosts: each shipped host's own cell first, in the order named, then 512 at every rate, each once", () => {
    expect(keys(gridCells(GRID_HOSTS, context))).toEqual([
      "96000/1024", // openmixer-console
      "48000/256", // jalv
      "48000/128", // mod-host, and omx-clap-host's is the same cell
      "44100/512",
      "48000/512",
      "96000/512",
      "192000/512",
    ]);
    expect(GRID_CONTINUITY_QUANTUM).toBe(512);
  });

  it("full: every rate at every quantum, sixteen cells, the hosts' cells first", () => {
    const full = gridCells(GRID_FULL, context);
    expect(full).toHaveLength(QUALIFY_RATES.length * QUALIFY_QUANTA.length);
    expect(full).toHaveLength(16);
    expect(new Set(keys(full)).size).toBe(16);
    for (const rate of QUALIFY_RATES) for (const quantum of QUALIFY_QUANTA) expect(keys(full)).toContain(`${rate}/${quantum}`);
    expect(keys(full).slice(0, 3)).toEqual(["96000/1024", "48000/256", "48000/128"]);
  });

  it("every declared host's cell is in the hosts' grid and in the full one", () => {
    for (const spec of [GRID_HOSTS, GRID_FULL]) for (const h of HOSTS) expect(keys(gridCells(spec, context))).toContain(cellKey(h));
  });

  it("named cells are taken as named, each once; anything else is refused with what was wrong", () => {
    const r = parseGridSpec("48000/128, 96000/1024,48000/128");
    expect(r.ok && keys(gridCells(r.spec, context))).toEqual(["48000/128", "96000/1024"]);
    expect(parseGridSpec("hosts")).toEqual({ ok: true, spec: GRID_HOSTS });
    expect(parseGridSpec("full")).toEqual({ ok: true, spec: GRID_FULL });
    for (const bad of ["", "48000", "48000x128", "0/128", "48000/-1", "all"]) {
      const b = parseGridSpec(bad);
      expect(b.ok, bad).toBe(false);
    }
  });

  it("a budget keeps the first cells of the order; 0 keeps them all", () => {
    const hosts = gridCells(GRID_HOSTS, context);
    expect(keys(budgetCells(hosts, 3))).toEqual(["96000/1024", "48000/256", "48000/128"]);
    expect(budgetCells(hosts, 0)).toEqual(hosts);
    expect(budgetCells(hosts, undefined)).toEqual(hosts);
  });
});

describe("the runs of the runner that measure a grid", () => {
  const full = gridCells(GRID_FULL, context);

  it("a CLAP plugin: one run per quantum, at every rate of the grid at that quantum", () => {
    const runs = runnerInvocations("clap", full);
    expect(runs.map((r) => r.quantum).sort((a, b) => a - b)).toEqual([...QUALIFY_QUANTA].sort((a, b) => a - b));
    for (const r of runs) expect(r.rates).toEqual([...QUALIFY_RATES].sort((a, b) => a - b));
    expect(runs.flatMap((r) => keys(r.cells)).sort()).toEqual(keys(full).sort());
  });

  it("an LV2 plugin: one run per cell, one rate each, on the same cells as a CLAP plugin", () => {
    const runs = runnerInvocations("lv2", full);
    expect(runs).toHaveLength(16);
    for (const r of runs) expect(r.rates).toHaveLength(1);
    expect(runs.flatMap((r) => keys(r.cells)).sort()).toEqual(runnerInvocations("clap", full).flatMap((r) => keys(r.cells)).sort());
  });
});
