// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The hosting sweep directory → ONE interchange document. Shared by `curate.mjs --hosting-sweep`
 * (which writes it into `data/hosting-measurements.json`) and `hosting-report.mjs` (which lands it
 * in memory before it classifies), so the report and the served catalog read the sweep through
 * the same reader and the same door.
 *
 * The directory carries its own run record, `sweep-run.json`: who measured, on what, when, and
 * which JSONL file is which pass. A figure without its conditions is not a measurement.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildMeasurementDocument,
  buildRun,
  measuredPluginsFromSweep,
  parseJsonl,
} from '../dist/measurement/index.js';

/** The dimensions a hosting sweep covers. */
export const HOSTING_DIMENSIONS = ['stability', 'rtSafety', 'features'];

/**
 * Read `<dir>/sweep-run.json` and the passes it names, and build the document.
 * Throws when the run record or the measurements pass is missing — no default run, no guessed file.
 */
export function hostingSweepDocument(dir) {
  const run = JSON.parse(readFileSync(join(dir, 'sweep-run.json'), 'utf8'));
  const passes = run.passes ?? {};
  if (!passes.measurements) throw new Error(`${dir}/sweep-run.json names no measurements pass`);
  const read = (name) => (name ? parseJsonl(readFileSync(join(dir, name), 'utf8')) : undefined);
  const plugins = measuredPluginsFromSweep({
    measurements: read(passes.measurements),
    lifecycle: read(passes.lifecycle),
    soak: read(passes.soak),
  });
  return buildMeasurementDocument(
    buildRun({
      id: run.id,
      measuredAt: run.measuredAt,
      dimensions: HOSTING_DIMENSIONS,
      rates: run.rates,
      tool: run.tool,
      host: run.host,
      ...(run.label ? { label: run.label } : {}),
    }),
    plugins,
  );
}
