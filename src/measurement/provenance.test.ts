// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Provenance is read, never assumed.
 *
 * The rule `CPU_COST_PROVENANCE.md` states in prose — *"recorded as `false` rather than
 * assumed"* — becomes two testable properties here: a `/sys` file that will not open leaves
 * its field ABSENT (not defaulted to a plausible value), and the two privilege facts are
 * always present because their `false` is itself a finding.
 */
import { describe, expect, it } from "vitest";

import {
  buildRun,
  collectHostFacts,
  costMethodFromProbeProvenance,
  hostFromProbeProvenance,
  LATENCY_ONLY_NOTE,
  RELATIVE_RANKING_NOTE,
  type HostProbes,
} from "./provenance.js";

function probes(files: Readonly<Record<string, string>>): HostProbes {
  return {
    hostname: () => "nuc",
    kernelRelease: () => "7.1.5",
    osName: () => "Linux",
    cpuModel: () => "Intel N100",
    cpuCount: () => 4,
    readSystemFile: (path) => files[path],
  };
}

describe("collecting host facts", () => {
  it("records what the machine answered", () => {
    const host = collectHostFacts(
      { pinnedCpu: 2, realtimePriority: false, memoryLocked: false, toolchain: { python: "3.14.6" } },
      probes({
        "/sys/devices/system/cpu/cpu2/cpufreq/scaling_governor": "performance",
        "/sys/devices/system/cpu/cpu2/cpufreq/cpuinfo_max_freq": "3400000",
        "/sys/devices/system/cpu/intel_pstate/no_turbo": "0",
      }),
    );
    expect(host).toMatchObject({
      hostname: "nuc",
      kernel: "7.1.5",
      cpuModel: "Intel N100",
      cpuCount: 4,
      pinnedCpu: 2,
      governor: "performance",
      pinnedCpuMaxKHz: 3400000,
      turboEnabled: true,
      toolchain: { python: "3.14.6" },
    });
  });

  it("OMITS a field whose file would not open, rather than guessing", () => {
    const host = collectHostFacts({ pinnedCpu: 2, realtimePriority: false, memoryLocked: false }, probes({}));
    expect(host).not.toHaveProperty("governor");
    expect(host).not.toHaveProperty("turboEnabled");
    expect(host).not.toHaveProperty("pinnedCpuMaxKHz");
  });

  it("keeps the privilege facts even when they are false", () => {
    const host = collectHostFacts({ realtimePriority: false, memoryLocked: false }, probes({}));
    expect(host.realtimePriority).toBe(false);
    expect(host.memoryLocked).toBe(false);
  });

  it("reads no cpufreq file at all when nothing was pinned", () => {
    const host = collectHostFacts(
      { realtimePriority: true, memoryLocked: true },
      probes({ "/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor": "powersave" }),
    );
    expect(host).not.toHaveProperty("governor");
    expect(host).not.toHaveProperty("pinnedCpu");
  });

  it("reads turbo as disabled when the kernel says no_turbo=1", () => {
    const host = collectHostFacts(
      { realtimePriority: false, memoryLocked: false },
      probes({ "/sys/devices/system/cpu/intel_pstate/no_turbo": "1" }),
    );
    expect(host.turboEnabled).toBe(false);
  });
});

describe("reading benchmark.py's own provenance file", () => {
  const file = {
    proberVersion: "cost/1",
    measuredAt: "2026-07-28T18:03:03+0200",
    host: "ref-desk",
    kernel: "7.1.5-200.fc44.x86_64",
    python: "3.14.6",
    cpuModel: "Intel(R) Core(TM) Ultra 9 275HX",
    cpuCount: 24,
    pinnedCpu: 7,
    pinnedCpuKind: "performance",
    pinnedCpuMaxKHz: 5300000,
    governor: "performance",
    turboEnabled: true,
    realtimePriority: false,
    memoryLocked: false,
    blockFrames: 512,
    warmupBlocks: 64,
    maxTimedBlocks: 512,
    minTimedBlocks: 64,
    targetSecondsPerPlugin: 0.25,
    percentile: 95.0,
    stimulus: "sustained 1000 Hz sine at 0.5 full-scale on every audio input",
    controls: "lv2:default on every control input",
    timingFloorNsPerBlock: 32.5,
  };

  it("maps the committed reference file onto the format's host block", () => {
    expect(hostFromProbeProvenance(file)).toEqual({
      hostname: "ref-desk",
      kernel: "7.1.5-200.fc44.x86_64",
      cpuModel: "Intel(R) Core(TM) Ultra 9 275HX",
      cpuCount: 24,
      pinnedCpu: 7,
      pinnedCpuKind: "performance",
      pinnedCpuMaxKHz: 5300000,
      governor: "performance",
      turboEnabled: true,
      realtimePriority: false,
      memoryLocked: false,
      toolchain: { python: "3.14.6" },
    });
  });

  it("maps the method block, keeping the percentile as data", () => {
    expect(costMethodFromProbeProvenance(file)).toMatchObject({
      method: "block-time-percentile",
      blockFrames: 512,
      warmupBlocks: 64,
      percentile: 95,
      timingFloorNsPerBlock: 32.5,
    });
  });

  it("treats absent privilege flags as not-privileged — the safe reading", () => {
    const { realtimePriority: _rt, memoryLocked: _ml, ...rest } = file;
    expect(hostFromProbeProvenance(rest)).toMatchObject({ realtimePriority: false, memoryLocked: false });
  });

  it("returns undefined for anything that is not a provenance record", () => {
    expect(hostFromProbeProvenance(undefined)).toBeUndefined();
    expect(hostFromProbeProvenance({ nothing: true })).toBeUndefined();
    expect(costMethodFromProbeProvenance({ blockFrames: 512 })).toBeUndefined();
  });
});

describe("building the run record", () => {
  const host = { hostname: "nuc", realtimePriority: false, memoryLocked: false };
  const base = {
    id: "run-1",
    measuredAt: "2026-08-01T10:00:00+02:00",
    rates: [96000, 48000],
    tool: { name: "lv2-measure", version: "0.1.0" },
    host,
  };

  it("claims relative-ranking-only exactly when it carries cost figures", () => {
    expect(buildRun({ ...base, dimensions: ["cost"] }).relativeRankingOnly).toBe(true);
    expect(buildRun({ ...base, dimensions: ["latency"] }).relativeRankingOnly).toBe(false);
  });

  it("attaches the caveat each dimension deserves", () => {
    expect(buildRun({ ...base, dimensions: ["cost"] }).note).toBe(RELATIVE_RANKING_NOTE);
    expect(buildRun({ ...base, dimensions: ["latency"] }).note).toBe(LATENCY_ONLY_NOTE);
    expect(buildRun({ ...base, dimensions: ["latency", "cost"] }).note).toContain(RELATIVE_RANKING_NOTE);
    expect(buildRun({ ...base, dimensions: ["latency", "cost"] }).note).toContain(LATENCY_ONLY_NOTE);
  });

  it("sorts the rates so two runs compare equal", () => {
    expect(buildRun({ ...base, dimensions: ["cost"] }).rates).toEqual([48000, 96000]);
  });
});
