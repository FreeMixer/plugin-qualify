// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * `tools/_declarations.py` IS GENERATED FROM `COST_REFERENCE_RATE` 
 * AND `QUANTUM_FRAMES` and every other figure the Python tools read (`src/qualify-declarations.ts`) — the 2026-09-17 declare-derive audit's F8.
 *
 * `benchmark.py` cannot import a TS module, so it kept its own hand-typed `COST_REFERENCE_RATE =
 * 96000` and `DEFAULT_BLOCK = 1024` — a mirror `rate-quantum-declaration-conformance.test.ts`
 * named but, until this file, never ratcheted (a declared exclusion is still a gap). This proves
 * `tools/_declarations.py` is byte-identical to `tools/gen-python-declarations.mjs`'s
 * output, on the same committed-and-verified footing `omx_contract_limits.h` and
 * `rta-resolution-line-gen.mjs` already stand on.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { declarationsFile } from '../tools/gen-python-declarations.mjs';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DECLARATIONS_PY = join(PKG, 'tools/_declarations.py');

describe('tools/_declarations.py is generated, verbatim', () => {
  it('the generator produces a non-trivial module naming both figures — positive control', () => {
    const content = declarationsFile();
    expect(content).toContain('COST_REFERENCE_RATE = 96000');
    expect(content).toContain('QUANTUM_FRAMES = 1024');
  });

  it('a stale, hand-typed COST_REFERENCE_RATE is NOT what the file states — sabotage control', () => {
    const content = readFileSync(DECLARATIONS_PY, 'utf8');
    expect(content).not.toContain('COST_REFERENCE_RATE = 48000');
    expect(content).not.toContain('COST_REFERENCE_RATE = 192000');
  });

  it('_declarations.py is byte-identical to the generator output', () => {
    const content = readFileSync(DECLARATIONS_PY, 'utf8');
    expect(content, 'stale — run: node tools/gen-python-declarations.mjs --write').toBe(
      declarationsFile(),
    );
  });
});
