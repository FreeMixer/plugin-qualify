// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The format version and the owner of `perRateQuantum` as the docs state them, against the
 * code that actually writes them (#112).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MEASUREMENT_FORMAT_VERSION } from "./measurement/format.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("the README states the format version this build writes", () => {
  it("README.md names the current MEASUREMENT_FORMAT_VERSION", () => {
    const readme = readFileSync(join(PKG, "README.md"), "utf8");
    expect(readme).toContain(`lv2-plugin-measurements\`, format ${MEASUREMENT_FORMAT_VERSION},`);
  });
});

describe("the cost-grid design note attributes perRateQuantum to the descriptor, not the measurement format", () => {
  it("does not claim format.ts adds perRateQuantum", () => {
    const note = readFileSync(join(PKG, "docs", "design", "probe-isolation-and-cost-grid.md"), "utf8");
    expect(note).not.toMatch(/`format\.ts`[^\n]*\bperRateQuantum\b/);
    expect(note).toContain("`src/hosting-suitability.ts`) adds `perRateQuantum`");
  });
});
