// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Where the package's own tools live, resolved from this module so it follows the package
 * wherever it is installed (a checkout, an RPM's bundled node_modules, a pnpm store). The
 * tools are shipped RUNTIME artefacts (issue #342), not dev scripts.
 */
import { fileURLToPath } from "node:url";

/**
 * `tools/` — `scan.py`, `benchmark.py`, `lv2-measure.mjs`, `hosting-sweep.mjs`. Resolved when a
 * console asks, never at import: a consumer that only reads this package's declarations from a
 * browser-like module graph (web-ui's conformance suites, `http:` module URLs) must load it.
 */
export function toolsDir(): string {
  return fileURLToPath(new URL("../tools/", import.meta.url));
}

/** The measurement runner a console spawns for Setup > Plugin analysis. */
export function lv2MeasureToolPath(): string {
  return fileURLToPath(new URL("../tools/lv2-measure.mjs", import.meta.url));
}
