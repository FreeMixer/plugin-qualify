// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The grid measured and judged (#193). A stand-in runner, spawned as the real one is, records how it was invoked and
 * measures as plugin-hostd's runner does (an LV2 plugin at the highest rate it is given, a CLAP one at every rate), so
 * the test sees what the runner was asked for, not what plugin-qualify meant to ask. Then: the verdict reads the host's
 * cell and names an absent one; a run that allocates past the memory bound is a `probe.oom` cell of a record that is
 * still written. The live tests at the end do the same with the real runner and the built prober, when both are here.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { HOSTING_CODE } from "./hosting-codes.js";
import { HOST_PROFILES, JALV_PROFILE, MOD_HOST_PROFILE, OMX_CLAP_HOST_PROFILE, OPENMIXER_CONSOLE_PROFILE } from "./host-profiles.js";
import type { AdmissionRuns } from "./host-admission.js";
import { GRID_FULL, GRID_HOSTS, cellKey, gridCells } from "./measurement-grid.js";
import { MEMORY_BOUND_MECHANISM, PROBE_OOM, memoryBoundOf, outOfMemory, parseMemoryLimit, defaultMemoryLimit } from "./memory-bound.js";
import { judgeProbeOutput } from "./probe-judge.js";
import { fixtureJson } from "./probe-output-fixtures.js";
import { readProbeOutput } from "./probe-output.js";
import { qualifyTargets, type ProbeRun } from "./probe-runner.js";
import { mergeRunsByRecord, writeQualification } from "./qualification-record.js";
import {
  CLAP_QUALIFY_TOOL_ENV,
  LV2_MEASURE_TOOL_ENV,
  MEMORY_BOUND_EXIT_ENV,
  MEMORY_BOUND_EXIT_STATUS,
  MEMORY_LIMIT_RAM_FRACTION,
  PROBE_RUNNER_ENV,
  QUALIFY_QUANTA,
  QUALIFY_RATES,
  RT_INTERPOSE_ENV,
} from "./qualify-declarations.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const STAND_IN = join(PKG, "src", "grid-probe-runner.support.mjs");
const scratch = mkdtempSync(join(tmpdir(), "grid-runs-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const CLAP = { format: "clap", uri: "urn:clap:org.example.plate", binaryPath: "/p/example-plate.clap" } as const;
const LV2 = { format: "lv2", uri: "urn:example:grid-lv2" } as const;
const HOSTS_ADMIT: AdmissionRuns = {
  modHost: () => ({ installed: true, steps: [{ cmd: "add", resp: 0 }, { cmd: "remove", resp: 0 }] }),
  jalv: () => ({ installed: true, stillRunning: true, status: null, signal: null, stderr: "" }),
};

let log = "";
let n = 0;
beforeEach(() => {
  log = join(scratch, `calls-${String(++n)}.jsonl`);
  appendFileSync(log, "");
});
const env = (extra: Record<string, string> = {}) => ({
  ...process.env,
  [PROBE_RUNNER_ENV]: STAND_IN,
  [CLAP_QUALIFY_TOOL_ENV]: "/t/clap-qualify",
  [RT_INTERPOSE_ENV]: "/t/rt.so",
  [LV2_MEASURE_TOOL_ENV]: "/t/lv2_measure",
  GRID_PROBE_LOG: log,
  ...extra,
});
interface Call {
  plugin: string;
  rates: number[];
  quantum: number;
  blocks?: number;
  dataBytes?: number;
  boundExit: boolean;
}
const calls = (): Call[] => readFileSync(log, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Call);
/** The cells the runner was asked to measure and, as it measures, did. */
const invokedCells = (cs: readonly Call[]) => cs.flatMap((c) => (c.plugin.startsWith("lv2:") ? [Math.max(...c.rates)] : c.rates).map((rate) => `${rate}/${c.quantum}`)).sort();
const FULL = QUALIFY_RATES.flatMap((r) => QUALIFY_QUANTA.map((q) => `${r}/${q}`)).sort();
const exists = () => true;

describe("the runner is invoked at every cell of the grid, an LV2 plugin like a CLAP one", () => {
  for (const target of [CLAP, LV2]) {
    it(`${target.format}: the full grid is sixteen cells asked for and sixteen in the record`, () => {
      const pass = qualifyTargets([target], { rates: QUALIFY_RATES, quanta: QUALIFY_QUANTA, grid: GRID_FULL, profiles: HOST_PROFILES, env: env(), exists, admissions: HOSTS_ADMIT });
      expect(pass.failures).toEqual([]);
      const cs = calls();
      // one run per quantum for a CLAP file (with its two offers), one per cell for an LV2 plugin
      if (target.format === "lv2") expect(cs).toHaveLength(16);
      for (const offerRuns of target.format === "clap" ? [cs.slice(0, 4), cs.slice(4)] : [cs]) expect(invokedCells(offerRuns)).toEqual(FULL);
      for (const run of mergeRunsByRecord(pass.runs)) {
        const w = writeQualification(join(scratch, `q-${String(n)}`), run.bytes, run.judgment);
        expect(w.record.measurements.grid.map(cellKey).sort()).toEqual(FULL);
        expect(w.record.measurements.grid.every((p) => p.outcome === "probe.ok" && p.cost !== undefined)).toBe(true);
        // the byte copy is the merged document, and it reads back to the same grid
        const back = readProbeOutput(readFileSync(w.probePath, "utf8"));
        expect(back.ok && back.output.grid.map(cellKey).sort()).toEqual(FULL);
      }
    });

    it(`${target.format}: the hosts' grid is each host's own cell and 512 at every rate`, () => {
      qualifyTargets([target], { rates: QUALIFY_RATES, quanta: QUALIFY_QUANTA, grid: GRID_HOSTS, profiles: HOST_PROFILES, env: env(), exists, admissions: HOSTS_ADMIT });
      const want = gridCells(GRID_HOSTS, { rates: QUALIFY_RATES, quanta: QUALIFY_QUANTA, hosts: HOST_PROFILES.map((p) => p.cost) }).map(cellKey).sort();
      const cs = calls();
      expect(invokedCells(target.format === "clap" ? cs.slice(0, cs.length / 2) : cs)).toEqual(want);
      for (const h of HOST_PROFILES) expect(want).toContain(`${h.cost.rate}/${h.cost.quantum}`);
    });
  }

  it("a budget measures the first cells alone, and --blocks reaches the CLAP sweep", () => {
    qualifyTargets([CLAP], { rates: QUALIFY_RATES, quanta: QUALIFY_QUANTA, grid: GRID_HOSTS, cellsPerPluginBudget: 3, blocks: 128, profiles: HOST_PROFILES, env: env(), exists, admissions: HOSTS_ADMIT });
    const cs = calls();
    expect(invokedCells(cs.slice(0, cs.length / 2))).toEqual(["48000/128", "48000/256", "96000/1024"]);
    expect(cs.every((c) => c.blocks === 128)).toBe(true);
  });
});

describe("the verdict reads the host's own cell", () => {
  /** A probe output holding 48000/128 (measured), 96000/512 (measured) and 48000/256 (out of memory). */
  function doc() {
    const d = fixtureJson("success-msi");
    const point = d.grid[0];
    delete point.cost.samples;
    d.grid = [
      { ...structuredClone(point), rate: 48000, quantum: 128 },
      { ...structuredClone(point), rate: 96000, quantum: 512 },
      { rate: 48000, quantum: 256, outcome: PROBE_OOM, memoryLimit: { bytes: 2 ** 31, mechanism: MEMORY_BOUND_MECHANISM } },
    ];
    const r = readProbeOutput(JSON.stringify(d));
    if (!r.ok) throw new Error(r.problem);
    return r.output;
  }

  it("a measured cell is read: the host at 48000/128 has a cost reason from its figure, never unmeasured", () => {
    const j = judgeProbeOutput(doc(), [OMX_CLAP_HOST_PROFILE, MOD_HOST_PROFILE]);
    for (const h of j.hosts) {
      expect(h.cost).toMatchObject({ rate: 48000, quantum: 128 });
      expect(h.cost.reasons.map((r) => r.code)).toEqual([HOSTING_CODE.costWithinCeiling]);
    }
  });

  it("an absent cell is named: openmixer-console at 96000/1024, with 96000/512 measured beside it", () => {
    const [h] = judgeProbeOutput(doc(), [OPENMIXER_CONSOLE_PROFILE]).hosts;
    expect(h!.cost.reasons).toEqual([{ dimension: "cost", rating: "unknown", code: HOSTING_CODE.costUnmeasured, params: { rate: 96000, quantum: 1024 } }]);
  });

  it("a cell that outgrew the bound is named by its outcome, with the limit, and leaves the other hosts judged", () => {
    const j = judgeProbeOutput(doc(), [JALV_PROFILE, OMX_CLAP_HOST_PROFILE]);
    const jalv = j.hosts.find((h) => h.verdict.host === "jalv")!;
    expect(jalv.cost.reasons).toEqual([{ dimension: "cost", rating: "unknown", code: PROBE_OOM, params: { rate: 48000, quantum: 256, memoryLimitBytes: 2 ** 31, memoryLimitMechanism: MEMORY_BOUND_MECHANISM } }]);
    expect(jalv.verdict.rating).toBe("unknown");
    expect(jalv.reasons.some((r) => r.dimension === "memory" && r.code === PROBE_OOM)).toBe(true);
    const clapHost = j.hosts.find((h) => h.verdict.host === "omx-clap-host")!;
    expect(clapHost.verdict.measured).toBe(true);
    expect(clapHost.reasons.some((r) => r.code === PROBE_OOM)).toBe(false);
  });
});

describe("the memory bound", () => {
  it("is half of the RAM by default, a size or off when named, and travels as the runner's data limit", () => {
    expect(MEMORY_LIMIT_RAM_FRACTION).toBe(0.5);
    expect(defaultMemoryLimit(4 * 2 ** 30)).toBe(2 * 2 ** 30);
    expect(memoryBoundOf(undefined, 4 * 2 ** 30)).toEqual({ bytes: 2 * 2 ** 30, mechanism: MEMORY_BOUND_MECHANISM });
    expect(memoryBoundOf("off")).toBeUndefined();
    expect(parseMemoryLimit("2G")).toEqual({ ok: true, bytes: 2 * 2 ** 30 });
    expect(parseMemoryLimit("512M")).toEqual({ ok: true, bytes: 512 * 2 ** 20 });
    expect(parseMemoryLimit("off")).toEqual({ ok: true, bytes: "off" });
    expect(parseMemoryLimit("lots").ok).toBe(false);
    qualifyTargets([LV2], { rates: [48000], profiles: [MOD_HOST_PROFILE], memory: memoryBoundOf(256 * 2 ** 20), env: env(), exists, admissions: HOSTS_ADMIT });
    expect(calls()).toEqual([expect.objectContaining({ dataBytes: 256 * 2 ** 20, boundExit: true })]);
  });

  it("the interposer's exit status and setting are the declarations' (native/rt-interpose.h)", () => {
    const h = readFileSync(join(PKG, "native", "rt-interpose.h"), "utf8");
    expect(h).toMatch(new RegExp(`#define OMX_RT_OOM_EXIT_STATUS ${String(MEMORY_BOUND_EXIT_STATUS)}\\b`));
    expect(h).toContain(`#define OMX_RT_OOM_EXIT_ENV "${MEMORY_BOUND_EXIT_ENV}"`);
  });

  for (const boundExit of [true, false]) {
    it(`a run that allocates past the bound is probe.oom${boundExit ? "" : " (killed by the kernel)"}, the other cells are judged and the record is written`, () => {
      // 1000 bytes a hertz: 192000 needs 192 MB, past a 100 MB bound; 48000 needs 48 MB, within it
      const bound = memoryBoundOf(100 * 10 ** 6)!;
      const pass = qualifyTargets([LV2], {
        rates: QUALIFY_RATES,
        quanta: QUALIFY_QUANTA,
        grid: GRID_HOSTS,
        profiles: HOST_PROFILES,
        memory: bound,
        env: env({ GRID_PROBE_HOG_BYTES_PER_HZ: "1000" }),
        exists,
        admissions: HOSTS_ADMIT,
        // the kernel's kill: the stand-in is told no bound's exit was asked for
        ...(boundExit ? {} : { run: noBoundExit }),
      });
      expect(pass.failures).toEqual([]);
      const [run] = mergeRunsByRecord(pass.runs);
      const w = writeQualification(join(scratch, `oom-${String(n)}`), run!.bytes, run!.judgment);
      expect(existsSync(w.recordPath)).toBe(true);
      const at = (key: string) => w.record.measurements.grid.find((p) => cellKey(p) === key);
      expect(at("192000/512")).toMatchObject({ rate: 192000, quantum: 512, outcome: PROBE_OOM, memoryLimit: { bytes: bound.bytes, mechanism: MEMORY_BOUND_MECHANISM } });
      expect(at("48000/128")?.outcome).toBe("probe.ok");
      expect(at("96000/1024")?.outcome).toBe("probe.ok");
      expect(w.record.probe.outcome).toBe("probe.ok");
      // every host's own cell was measured, so every host is judged on its figure
      for (const c of w.record.cost) expect(c.reasons.map((r) => r.code)).not.toContain(PROBE_OOM);
      expect(outOfMemory(run!.judgment.output, bound)).toBe(true);
    });
  }

  it("a plugin every run of which outgrew the bound is unknown, deciding probe.oom, and still has its record", () => {
    const pass = qualifyTargets([CLAP], {
      rates: QUALIFY_RATES,
      quanta: QUALIFY_QUANTA,
      grid: GRID_HOSTS,
      profiles: [OMX_CLAP_HOST_PROFILE],
      memory: memoryBoundOf(10 ** 6)!,
      env: env({ GRID_PROBE_HOG_BYTES_PER_HZ: "1000" }),
      exists,
      admissions: HOSTS_ADMIT,
    });
    expect(pass.verdicts).toEqual([expect.objectContaining({ host: "omx-clap-host", rating: "unknown", deciding: PROBE_OOM })]);
    const [run] = mergeRunsByRecord(pass.runs);
    const w = writeQualification(join(scratch, `oom-all-${String(n)}`), run!.bytes, run!.judgment);
    expect(w.record.probe.outcome).toBe(PROBE_OOM);
    expect(w.record.measurements.grid.length).toBeGreaterThan(0);
    expect(w.record.measurements.grid.every((p) => p.outcome === PROBE_OOM)).toBe(true);
  });
});

/** The default spawn, minus the bound's exit setting, so the stand-in ends as the kernel's killer would end it. */
const noBoundExit: ProbeRun = (tool, args, e) => {
  const { [MEMORY_BOUND_EXIT_ENV]: _drop, ...rest } = e;
  const r = spawnSync(tool, [...args], { encoding: "utf8", env: rest });
  return { status: r.status, signal: r.signal, stderr: r.stderr ?? "" };
};

// --- live: the real runner, the built prober and measurer, the fixture plugins ----------------------------------------

const BUILD = join(PKG, "native", "build");
const pathRunner = (process.env["PATH"] ?? "").split(":").map((d) => join(d, "plugin-hostd-probe")).find((p) => existsSync(p));
const REAL_RUNNER = process.env[PROBE_RUNNER_ENV] || pathRunner;
const LIVE = REAL_RUNNER !== undefined && ["clap-qualify", "lv2_measure", "rt_interpose.so", "fixtures/rt-safe.clap", "fixtures-faulty/hogs-memory.clap"].every((f) => existsSync(join(BUILD, f)));

function live(name: string, body: () => void): void {
  it(name, { timeout: 300_000 }, (ctx) => {
    if (!LIVE) ctx.skip("no plugin-hostd-probe (OMX_PROBE_RUNNER or PATH) or no native/build: make -C native deps all");
    body();
  });
}

const liveEnv = () => {
  const { [CLAP_QUALIFY_TOOL_ENV]: _c, [LV2_MEASURE_TOOL_ENV]: _l, [RT_INTERPOSE_ENV]: _r, ...rest } = process.env;
  return { ...rest, [PROBE_RUNNER_ENV]: REAL_RUNNER!, LV2_PATH: join(BUILD, "fixtures", "lv2") };
};

describe("live: the real runner measures the full grid, an LV2 plugin like a CLAP one", () => {
  const targets = [
    { format: "clap", uri: "urn:clap:org.freemixer.plugin-qualify.fixture.rt-safe", binaryPath: join(BUILD, "fixtures", "rt-safe.clap") },
    { format: "lv2", uri: "urn:plugin-qualify:fixture:lv2-rt-safe" },
  ] as const;
  for (const target of targets) {
    live(`${target.format}: sixteen cells measured, each probe.ok`, () => {
      const pass = qualifyTargets([target], { rates: QUALIFY_RATES, quanta: QUALIFY_QUANTA, grid: GRID_FULL, blocks: 64, profiles: [OPENMIXER_CONSOLE_PROFILE], env: liveEnv(), admissions: HOSTS_ADMIT });
      expect(pass.failures).toEqual([]);
      const consoleCost: string[][] = [];
      for (const run of mergeRunsByRecord(pass.runs)) {
        const w = writeQualification(join(scratch, `live-${target.format}-${String(n)}`), run.bytes, run.judgment);
        expect(w.record.measurements.grid.map(cellKey).sort()).toEqual(FULL);
        expect(w.record.measurements.grid.filter((p) => p.outcome !== "probe.ok")).toEqual([]);
        const c = w.record.cost.find((x) => x.host === "openmixer-console");
        if (c !== undefined) consoleCost.push(c.reasons.map((r) => r.code));
      }
      // the console's own cell is measured, so its cost is read, never unmeasured
      expect(consoleCost.length).toBeGreaterThan(0);
      for (const codes of consoleCost) expect(codes).not.toContain(HOSTING_CODE.costUnmeasured);
    });
  }

  live("a CLAP plugin that takes memory by the rate: 192000 outgrows the bound and is probe.oom, 48000 is measured, the record is written", () => {
    // 64 MiB for every 48000 Hz: 64 MiB at 48000, 256 MiB at 192000, against a 160 MiB data limit
    const bound = memoryBoundOf(160 * 2 ** 20)!;
    const target = { format: "clap", uri: "urn:clap:org.freemixer.plugin-qualify.fixture.hogs-memory", binaryPath: join(BUILD, "fixtures-faulty", "hogs-memory.clap") } as const;
    const pass = qualifyTargets([target], {
      rates: QUALIFY_RATES,
      cells: [{ rate: 48000, quantum: 256 }, { rate: 192000, quantum: 128 }],
      blocks: 64,
      memory: bound,
      profiles: [OMX_CLAP_HOST_PROFILE],
      env: liveEnv(),
      admissions: HOSTS_ADMIT,
    });
    expect(pass.failures).toEqual([]);
    const [run] = mergeRunsByRecord(pass.runs);
    const w = writeQualification(join(scratch, `live-oom-${String(n)}`), run!.bytes, run!.judgment);
    expect(existsSync(w.recordPath)).toBe(true);
    const at = (key: string) => w.record.measurements.grid.find((p) => cellKey(p) === key);
    expect(at("48000/256")?.outcome).toBe("probe.ok");
    expect(at("192000/128")).toMatchObject({ rate: 192000, quantum: 128, outcome: PROBE_OOM, memoryLimit: { bytes: bound.bytes, mechanism: MEMORY_BOUND_MECHANISM } });
    expect(run!.judgment.output.steps.some((s) => s.exitStatus === MEMORY_BOUND_EXIT_STATUS)).toBe(true);
  });
});
