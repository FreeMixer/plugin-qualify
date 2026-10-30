// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The memory bound of a run (#193). A sampler loading its library can take all of a small machine's memory; unbounded,
 * the kernel's out-of-memory killer ends it (or something else) and the run is a crash nobody can tell from a bug. So
 * every run is bounded: the runner's data limit (`--data-bytes`, `RLIMIT_DATA` on the measuring child), with the
 * interposer told to exit `MEMORY_BOUND_EXIT_STATUS` the moment an allocation is refused under it.
 *
 * A run is out of memory when one of its steps says the child exited with that status, or was killed by a `SIGKILL`
 * the runner did not send (its own deadline kill is `probe.timeout`, never `probe.crashed`): the kernel's killer.
 */
import { totalmem } from "node:os";

import type { ProbeOutput } from "./probe-output.js";
import { MEMORY_BOUND_EXIT_STATUS, MEMORY_LIMIT_RAM_FRACTION } from "./qualify-declarations.js";

/** How the bound is applied: the runner's data limit on the child. */
export const MEMORY_BOUND_MECHANISM = "rlimit-data";

/** How the bound was applied when the runner set it as its cgroup's `memory.max`, which its document says. */
export const MEMORY_CGROUP_MECHANISM = "cgroup-memory-max";

/** The outcome of a run, and of each of its cells, that outgrew the bound. */
export const PROBE_OOM = "probe.oom";

/** The runner's own outcome for a child the kernel killed at its cgroup's `memory.max`. */
export const PROBE_MEMORY_LIMIT = "probe.memory-limit";

/** Whether an outcome says a run outgrew its memory limit, by either bound. */
export const isOutOfMemory = (outcome: string): boolean => outcome === PROBE_OOM || outcome === PROBE_MEMORY_LIMIT;

export interface MemoryBound {
  readonly bytes: number;
  readonly mechanism: typeof MEMORY_BOUND_MECHANISM;
}

const UNITS: Readonly<Record<string, number>> = { "": 1, K: 2 ** 10, M: 2 ** 20, G: 2 ** 30, T: 2 ** 40 };

/** `off`, a number of bytes, or one with a K, M, G or T suffix (powers of two: K is 2 ** 10 bytes). */
export function parseMemoryLimit(text: string): { ok: true; bytes: number | "off" } | { ok: false; error: string } {
  const t = text.trim();
  if (t === "off") return { ok: true, bytes: "off" };
  const m = /^(\d+)([KMGT]?)(?:i?B)?$/i.exec(t);
  const bytes = m === null ? NaN : Number(m[1]) * UNITS[m[2]!.toUpperCase()]!;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return { ok: false, error: `the memory limit is off, or bytes as 2147483648, 2048M or 2G; "${t}" is neither` };
  return { ok: true, bytes };
}

/** The default bound: `MEMORY_LIMIT_RAM_FRACTION` of the machine's RAM. */
export function defaultMemoryLimit(ramBytes: number = totalmem()): number {
  return Math.floor(ramBytes * MEMORY_LIMIT_RAM_FRACTION);
}

/** The bound a setting names: `undefined` (the default), `off`, or a size. */
export function memoryBoundOf(setting: number | "off" | undefined, ramBytes?: number): MemoryBound | undefined {
  if (setting === "off") return undefined;
  return { bytes: setting ?? defaultMemoryLimit(ramBytes), mechanism: MEMORY_BOUND_MECHANISM };
}

/** Whether a run under `bound` ended out of memory: the interposer's exit status, or a SIGKILL that was no deadline's. */
export function outOfMemory(output: ProbeOutput, bound: MemoryBound | undefined): boolean {
  if (output.run.outcome === PROBE_MEMORY_LIMIT || output.steps.some((s) => s.outcome === PROBE_MEMORY_LIMIT)) return true;
  if (bound === undefined) return false;
  return output.steps.some((s) => s.exitStatus === MEMORY_BOUND_EXIT_STATUS || (s.signal === "SIGKILL" && s.outcome === "probe.crashed"));
}
