// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Where the package's own tools live, resolved from this module so it follows the package
 * wherever it is installed (a checkout, an RPM's bundled node_modules, a pnpm store). The
 * tools are shipped RUNTIME artefacts, not dev scripts.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CLAP_QUALIFY_TOOL_NAME, NATIVE_TOOL_DIRS, RT_INTERPOSE_NAME } from "./qualify-declarations.js";

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

/** The package's own build of the native tools (`make -C native`). */
function nativeBuildDir(): string {
  return fileURLToPath(new URL("../native/build/", import.meta.url));
}

/** The package's own build of the CLAP prober (`make -C native`). */
export function clapQualifyToolPath(): string {
  return join(nativeBuildDir(), CLAP_QUALIFY_TOOL_NAME);
}

/** The package's own build of the interposer the CLAP prober runs under. */
export function rtInterposePath(): string {
  return join(nativeBuildDir(), RT_INTERPOSE_NAME);
}

/** Where a native tool is looked for when no setting names it, in order: the installed directories, then the own build. */
export function nativeToolCandidates(name: string): string[] {
  return [...NATIVE_TOOL_DIRS, nativeBuildDir()].map((dir) => join(dir, name));
}
