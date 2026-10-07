// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * A moved declaration reaches the Python tools: `_declarations.py` generated from moved
 * COST_REFERENCE_RATE and QUANTUM_FRAMES differs from the committed one, and `benchmark.py`,
 * imported against it, reads the moved figures rather than numbers of its own.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { declarationsFile } from "../tools/gen-python-declarations.mjs";
import * as real from "./qualify-declarations.js";

const TOOLS = join(dirname(fileURLToPath(import.meta.url)), "..", "tools");
const moved = { ...real, COST_REFERENCE_RATE: real.COST_REFERENCE_RATE + 1, QUANTUM_FRAMES: real.QUANTUM_FRAMES * 2 };
const dir = mkdtempSync(join(tmpdir(), "plugin-qualify-py-perturb-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the Python tools follow a moved declaration", () => {
  it("the generator emits the moved figures, not the committed ones", () => {
    expect(declarationsFile(moved)).not.toBe(declarationsFile());
    expect(declarationsFile(moved)).toContain(`COST_REFERENCE_RATE = ${moved.COST_REFERENCE_RATE}\n`);
  });

  it("benchmark.py imports the moved rate and quantum through _declarations.py", () => {
    writeFileSync(join(dir, "_declarations.py"), declarationsFile(moved));
    const out = execFileSync("python3", ["-c",
      `import sys; sys.path.insert(0, ${JSON.stringify(dir)}); sys.path.append(${JSON.stringify(TOOLS)}); `
      + "import benchmark; print(benchmark.COST_REFERENCE_RATE, benchmark.DEFAULT_BLOCK)"], { encoding: "utf8" }).trim();
    expect(out).toBe(`${moved.COST_REFERENCE_RATE} ${moved.QUANTUM_FRAMES}`);
  });
});
