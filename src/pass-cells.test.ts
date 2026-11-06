// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Every Pi matrix carries 96000 beside 48000: the cells the adapter, memory (and so the pool) passes run at, and the
 * host's memory budget, are the Pi's two quanta at both rates.
 */
import { describe, expect, it } from "vitest";

import { HOST_BUDGETS, PI_CELLS } from "./qualify-declarations.js";
import { ADAPTER_PASS_CELLS } from "./qualify-adapter-pass.js";
import { MEMORY_PASS_CELLS } from "./qualify-rejudge.js";

const WANTED = [[48000, 128], [48000, 256], [96000, 128], [96000, 256]].map(([rate, quantum]) => ({ rate, quantum }));

describe("the Pi's pass cells", () => {
  it("are 128 and 256 frames at 48000 and 96000", () => {
    expect(PI_CELLS).toEqual(WANTED);
  });
  it("are the cells of the adapter pass, the memory pass and the Pi hosts' memory budgets", () => {
    expect(ADAPTER_PASS_CELLS).toEqual(WANTED);
    expect(MEMORY_PASS_CELLS).toEqual(WANTED);
    expect(HOST_BUDGETS["openmixer-pi-4gb"].memory.cells).toEqual(WANTED);
    expect(HOST_BUDGETS["openmixer-pi-8gb"].memory.cells).toEqual(WANTED);
  });
});
