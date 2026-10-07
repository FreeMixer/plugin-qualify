// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Where a run happened, and under what settings — assembled from what the machine will
 * actually tell us.
 *
 * The discipline this module enforces is the one `data/CPU_COST_PROVENANCE.md` states in
 * prose: *"realtime priority / mlock — no, both need privileges the benchmark must not
 * require; recorded as `false` rather than assumed."* Every fact here is READ at run time
 * or omitted. Nothing is defaulted, nothing is inferred from the platform, and a `/sys`
 * file that will not open produces an absent field rather than a plausible value.
 *
 * The two `false`s are the exception and they are required fields: `realtimePriority` and
 * `memoryLocked` say "we did not run with this", which is a finding a comparison needs,
 * and leaving them absent would let a reader assume the good case.
 */

import { hostname as osHostname, cpus as osCpus, release as osRelease, type as osType } from "node:os";
import { readFileSync } from "node:fs";

import type { CostMethod, LatencyMethod, MeasurementHost, MeasurementRun } from "./format.js";
import { booleanValue, finiteNumber, isRecord, nonEmptyString, optional } from "./guards.js";
import { type MeasurementDimension, MEASUREMENT_DIMENSIONS } from "./vocabulary.js";

/** The machine facts this module reads, injectable so the collector is testable. */
export interface HostProbes {
  hostname(): string;
  kernelRelease(): string;
  osName(): string;
  cpuModel(): string | undefined;
  cpuCount(): number;
  /** Contents of a `/sys` or `/proc` file, or `undefined` when it cannot be read. */
  readSystemFile(path: string): string | undefined;
}

/** The real machine. */
export const SYSTEM_HOST_PROBES: HostProbes = {
  hostname: () => osHostname(),
  kernelRelease: () => osRelease(),
  osName: () => osType(),
  cpuModel: () => osCpus()[0]?.model,
  cpuCount: () => osCpus().length,
  readSystemFile: (path) => {
    try {
      return readFileSync(path, "utf8").trim();
    } catch {
      return undefined;
    }
  },
};

/** Facts the caller knows that the machine cannot be asked for. */
export interface HostFactInput {
  /** The core the prober pinned to, when it pinned. */
  readonly pinnedCpu?: number;
  /** Whether the prober ran with realtime scheduling — a claim the caller must make. */
  readonly realtimePriority: boolean;
  /** Whether the prober's pages were locked. */
  readonly memoryLocked: boolean;
  /** Versions of what did the probing, e.g. `{ python: "3.14.6" }`. */
  readonly toolchain?: Readonly<Record<string, string>>;
}

/**
 * Read the governor, the max frequency and the turbo state for a core, plus the CPU model
 * and count. Any file that will not open yields an absent field.
 *
 * `pinnedCpuKind` deliberately reports what the kernel exposes rather than a classification
 * of our own: on a hybrid CPU the two `cpuinfo_max_freq` populations are what distinguishes
 * a performance core from an efficiency one, so the frequency IS the evidence and the label
 * is only offered when the split is unambiguous.
 */
export function collectHostFacts(input: HostFactInput, probes: HostProbes = SYSTEM_HOST_PROBES): MeasurementHost {
  const cpu = input.pinnedCpu;
  const base = cpu === undefined ? undefined : `/sys/devices/system/cpu/cpu${cpu}/cpufreq`;
  const governor = base === undefined ? undefined : nonEmptyString(probes.readSystemFile(`${base}/scaling_governor`));
  const maxKHzText = base === undefined ? undefined : probes.readSystemFile(`${base}/cpuinfo_max_freq`);
  const maxKHz = maxKHzText === undefined ? undefined : finiteNumber(Number(maxKHzText));
  const noTurbo = probes.readSystemFile("/sys/devices/system/cpu/intel_pstate/no_turbo");
  const turboEnabled = noTurbo === undefined ? undefined : noTurbo.trim() === "0";
  const cpuCount = probes.cpuCount();

  return {
    hostname: probes.hostname(),
    realtimePriority: input.realtimePriority,
    memoryLocked: input.memoryLocked,
    ...optional("kernel", nonEmptyString(probes.kernelRelease())),
    ...optional("os", nonEmptyString(probes.osName())),
    ...optional("cpuModel", nonEmptyString(probes.cpuModel())),
    ...optional("cpuCount", cpuCount > 0 ? cpuCount : undefined),
    ...optional("pinnedCpu", cpu),
    ...optional("pinnedCpuMaxKHz", maxKHz),
    ...optional("governor", governor),
    ...optional("turboEnabled", turboEnabled),
    ...optional("toolchain", input.toolchain),
  };
}

/**
 * The host block from `benchmark.py --cost-provenance`'s JSON, or `undefined`.
 *
 * That file is the model this format generalises, so the mapping is mostly renaming. The
 * one judgement: its `realtimePriority` / `memoryLocked` are already explicit booleans, and
 * a file that omits them is treated as not having run privileged — the safe reading, and
 * the one that matches what the prober can actually do without privileges.
 */
export function hostFromProbeProvenance(value: unknown): MeasurementHost | undefined {
  if (!isRecord(value)) return undefined;
  const host = nonEmptyString(value.host);
  if (host === undefined) return undefined;
  const python = nonEmptyString(value.python);
  return {
    hostname: host,
    realtimePriority: booleanValue(value.realtimePriority) ?? false,
    memoryLocked: booleanValue(value.memoryLocked) ?? false,
    ...optional("kernel", nonEmptyString(value.kernel)),
    ...optional("cpuModel", nonEmptyString(value.cpuModel)),
    ...optional("cpuCount", finiteNumber(value.cpuCount)),
    ...optional("pinnedCpu", finiteNumber(value.pinnedCpu)),
    ...optional("pinnedCpuKind", nonEmptyString(value.pinnedCpuKind)),
    ...optional("pinnedCpuMaxKHz", finiteNumber(value.pinnedCpuMaxKHz)),
    ...optional("governor", nonEmptyString(value.governor)),
    ...optional("turboEnabled", booleanValue(value.turboEnabled)),
    ...optional("toolchain", python === undefined ? undefined : { python }),
  };
}

/** The cost method block from `benchmark.py --cost-provenance`'s JSON, or `undefined`. */
export function costMethodFromProbeProvenance(value: unknown): CostMethod | undefined {
  if (!isRecord(value)) return undefined;
  const blockFrames = finiteNumber(value.blockFrames);
  const warmupBlocks = finiteNumber(value.warmupBlocks);
  const percentile = finiteNumber(value.percentile);
  const stimulus = nonEmptyString(value.stimulus);
  if (blockFrames === undefined || warmupBlocks === undefined || percentile === undefined || stimulus === undefined) {
    return undefined;
  }
  return {
    method: "block-time-percentile",
    blockFrames,
    warmupBlocks,
    percentile,
    stimulus,
    controls: nonEmptyString(value.controls) ?? "lv2:default on every control input",
    ...optional("minTimedBlocks", finiteNumber(value.minTimedBlocks)),
    ...optional("maxTimedBlocks", finiteNumber(value.maxTimedBlocks)),
    ...optional("targetSecondsPerPlugin", finiteNumber(value.targetSecondsPerPlugin)),
    ...optional("timingFloorNsPerBlock", finiteNumber(value.timingFloorNsPerBlock)),
  };
}

/** The caveat that rides on every run carrying cost figures. */
export const RELATIVE_RANKING_NOTE =
  "A RELATIVE ranking measured on one machine, not a guarantee on any other. Different silicon, " +
  "a different governor or a busier machine will produce different absolute figures; what carries " +
  "over is the ORDER and the rough ratios.";

/** The caveat on a run carrying only latency figures — portable, but not unconditionally. */
export const LATENCY_ONLY_NOTE =
  "Latency is mostly algorithmic, so these figures travel between machines better than cost does. " +
  "They are still tied to the PLUGIN VERSIONS recorded here: a new release moves an FFT window and " +
  "the figure becomes wrong without becoming absent.";

/** The caveat on a run carrying the hosting dimensions — survival, RT-safety, features. */
export const HOSTING_NOTE =
  "Whether a plugin survives and keeps run() free of allocations, locks and syscalls was measured " +
  "on the host named here, against its libc, lilv and the plugin builds installed at the time. An " +
  "upgrade of any of them is a different host: carry the figures across and re-judge, never trust.";

/** Everything {@link buildRun} needs that is not read off the machine. */
export interface RunInput {
  readonly id: string;
  readonly measuredAt: string;
  readonly dimensions: readonly MeasurementDimension[];
  readonly rates: readonly number[];
  readonly tool: { readonly name: string; readonly version: string };
  readonly host: MeasurementHost;
  readonly latencyMethod?: LatencyMethod;
  readonly costMethod?: CostMethod;
  readonly elapsedSeconds?: number;
  readonly label?: string;
}

/**
 * Assemble a run record.
 *
 * `relativeRankingOnly` is derived, not passed: it is true exactly when the run carries cost
 * figures, and letting a caller set it would let a caller unset it. The note follows the
 * same rule — a latency-only run gets the version caveat, a cost run gets the machine one,
 * and a run carrying both gets both, because both apply.
 */
export function buildRun(input: RunInput): MeasurementRun {
  const dimensions = MEASUREMENT_DIMENSIONS.filter((d) => input.dimensions.includes(d));
  const hasCost = dimensions.includes("cost");
  const hasLatency = dimensions.includes("latency");
  const hasHosting = dimensions.some((d) => d === "stability" || d === "rtSafety" || d === "features");
  const note = [
    hasCost ? RELATIVE_RANKING_NOTE : undefined,
    hasLatency ? LATENCY_ONLY_NOTE : undefined,
    hasHosting ? HOSTING_NOTE : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" ");
  return {
    id: input.id,
    measuredAt: input.measuredAt,
    dimensions,
    rates: [...input.rates].sort((a, b) => a - b),
    tool: input.tool,
    host: input.host,
    method: {
      ...optional("latency", input.latencyMethod),
      ...optional("cost", input.costMethod),
    },
    relativeRankingOnly: hasCost,
    note: note.length > 0 ? note : RELATIVE_RANKING_NOTE,
    ...optional("elapsedSeconds", input.elapsedSeconds),
    ...optional("label", input.label),
  };
}
