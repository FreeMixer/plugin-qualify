// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Where the package's own tools live, resolved from this module so it follows the package
 * wherever it is installed (a checkout, an RPM's bundled node_modules, a pnpm store). The
 * tools are shipped RUNTIME artefacts, not dev scripts.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLAP_QUALIFY_TOOL_NAME,
  LV2_MEASURE_TOOL_NAME,
  NATIVE_TOOLS,
  NATIVE_TOOL_DIRS,
  RT_INTERPOSE_NAME,
} from "./qualify-declarations.js";

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

/** The package's own build of the LV2 measurer (`make -C native`). */
export function lv2MeasureNativePath(): string {
  return join(nativeBuildDir(), LV2_MEASURE_TOOL_NAME);
}

/**
 * Where the native tools are looked for when no setting names them, in order: the package's own build,
 * then the installed directories. An installed package has no `native/build/`, so its own build first
 * changes nothing there, and in a checkout `make -C native` is never shadowed by an older install.
 */
export function nativeToolDirs(): string[] {
  return [nativeBuildDir(), ...NATIVE_TOOL_DIRS];
}

/** Where one native tool is looked for when no setting names it, in `nativeToolDirs` order. */
export function nativeToolCandidates(name: string): string[] {
  return nativeToolDirs().map((dir) => join(dir, name));
}

function settingOf(name: string): string {
  const setting = NATIVE_TOOLS.find((t) => t.name === name)?.env;
  if (setting === undefined) throw new Error(`${name} is not one of NATIVE_TOOLS`);
  return setting;
}

const isSet = (v: string | undefined): v is string => v !== undefined && v !== "";

/**
 * One of `NATIVE_TOOLS`: its setting when set (and only that), else the first candidate that exists.
 * `path` is absent when none does; `looked` is every place tried, for the refusal to name.
 */
export function locateNativeTool(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  exists: (path: string) => boolean,
): { readonly path?: string; readonly looked: readonly string[]; readonly setting: string } {
  const setting = settingOf(name);
  const v = env[setting];
  const looked = isSet(v) ? [v] : nativeToolCandidates(name);
  const path = looked.find((p) => exists(p));
  return { ...(path === undefined ? {} : { path }), looked, setting };
}

/** One tool of a set `locateNativeTools` located, as `locateNativeTool` reports it. */
export interface LocatedNativeTool {
  readonly name: string;
  readonly path?: string;
  readonly looked: readonly string[];
  readonly setting: string;
}

/**
 * Tools that run together and share an ABI (a prober or the measurer, and the interposer through
 * `rt-interpose.h`): each set one is its setting; the rest come from ONE directory, the first of
 * `nativeToolDirs` holding any of them. When that directory lacks some of them, `halfPopulated`
 * names it and what it lacks, and the run is refused: pairing a tool from one place with its
 * interposer from another would let a version skew corrupt the verdict without an error.
 */
export function locateNativeTools(
  names: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  exists: (path: string) => boolean,
): {
  readonly tools: readonly LocatedNativeTool[];
  readonly halfPopulated?: { readonly dir: string; readonly holds: readonly string[]; readonly lacks: readonly string[] };
} {
  const unset = names.filter((name) => !isSet(env[settingOf(name)]));
  const dir = nativeToolDirs().find((d) => unset.some((name) => exists(join(d, name))));
  const tools = names.map((name): LocatedNativeTool => {
    const setting = settingOf(name);
    const v = env[setting];
    if (isSet(v)) return { name, setting, looked: [v], ...(exists(v) ? { path: v } : {}) };
    const path = dir === undefined ? undefined : join(dir, name);
    return { name, setting, looked: nativeToolCandidates(name), ...(path !== undefined && exists(path) ? { path } : {}) };
  });
  if (dir === undefined) return { tools };
  const lacks = unset.filter((name) => !exists(join(dir, name)));
  if (lacks.length === 0) return { tools };
  return { tools, halfPopulated: { dir, holds: unset.filter((name) => !lacks.includes(name)), lacks } };
}

/** The refusal for a half-populated directory: what it holds, what it lacks, and the settings that would decide. */
export function halfPopulatedRefusal(half: { readonly dir: string; readonly holds: readonly string[]; readonly lacks: readonly string[] }): string {
  const settings = [...half.holds, ...half.lacks].map(settingOf).join(" and ");
  return (
    `${half.dir} holds ${half.holds.join(", ")} but not ${half.lacks.join(", ")}: they share one ABI and are ` +
    `taken from one place, so install or build them together, or set ${settings}`
  );
}
