// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The measurers as built, on plugins whose memory is known: a large block at activate, a per-block leak, a per-voice
 * allocation, each read and each judged, beside a plain plugin that holds next to nothing. On CI a missing build is a
 * failure; elsewhere the tests skip, saying how to build.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { addressSpaceLimited, directOutcome, isSanitizerBuild, MEMORY_LIMIT_EXCEEDED } from "./direct-limit.js";
import { HOSTING_CODE } from "./hosting-codes.js";
import { OPENMIXER_CONSOLE_PROFILE, type HostProfile } from "./host-profiles.js";
import { DEFAULT_HOSTING_POLICY, hostingMemoryReasons, soakFindings } from "./hosting-suitability.js";
import { readMemoryFootprint, readSoakAtRate, type MemoryFootprint } from "./measurement/format.js";
import { firstInstanceKb, perInstanceKb } from "./memory-budget.js";

const BUILD = join(dirname(fileURLToPath(import.meta.url)), "..", "native", "build");
const PROBER = join(BUILD, "clap-qualify");
const MEASURE = join(BUILD, "lv2_measure");
const INTERPOSER = join(BUILD, "rt_interpose.so");
const FIXTURES = join(BUILD, "fixtures");
const FAULTY = join(BUILD, "fixtures-faulty");
const LV2_PATH = `${join(FIXTURES, "lv2")}:${join(FAULTY, "lv2")}`;
const BUILT = [PROBER, MEASURE, INTERPOSER, join(FAULTY, "hogs-memory.clap"), join(FAULTY, "synth-voice-memory.clap"), join(FAULTY, "lv2", "leaks.lv2", "gain.so"), join(FAULTY, "lv2", "large-activate.lv2", "gain.so")].every((p) => existsSync(p));

function live(name: string, body: () => void): void {
  it(name, (ctx) => {
    if (!BUILT) {
      if (process.env["CI"]) throw new Error("native/build is missing: CI builds it with make -C native deps all");
      ctx.skip("native/build is missing: make -C native deps all");
    }
    body();
  }, 120_000);
}

const MIB = 1024;
const RATE = 48000;
const QUANTUM = 256;

function clapMemory(file: string, ...extra: string[]): MemoryFootprint {
  const r = spawnSync(PROBER, ["--rates", String(RATE), "--block", String(QUANTUM), "--blocks", "16", ...extra, file], { encoding: "utf8", env: { ...process.env, LD_PRELOAD: INTERPOSER } });
  expect(r.status, r.stderr).toBe(0);
  const line = JSON.parse(r.stdout.split("\n")[0]!);
  return readMemoryFootprint(line.cost.perRate[String(RATE)].memory)!;
}

function lv2Line(uri: string, env: Record<string, string> = {}, args: string[] = [String(RATE), String(QUANTUM), "1", "1"]) {
  const r = spawnSync(MEASURE, [uri, ...args], { encoding: "utf8", env: { ...process.env, LV2_PATH, ...env } });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout.split("\n")[0]!);
}
const lv2Memory = (uri: string, env: Record<string, string> = {}): MemoryFootprint => readMemoryFootprint(lv2Line(uri, env).cost.perRate[String(RATE)].memory)!;

/** A host whose budget is this many MiB for an instance, at this test's cell. */
const budgeted = (mib: number): HostProfile => ({
  ...OPENMIXER_CONSOLE_PROFILE,
  cost: { ...OPENMIXER_CONSOLE_PROFILE.cost, rate: RATE, quantum: QUANTUM, memory: { perInstanceKb: mib * MIB, perConsoleKb: 16 * 1024 * MIB } },
});
const judged = (f: MemoryFootprint, mib: number) => hostingMemoryReasons({ perRateQuantum: { [`${String(RATE)}/${String(QUANTUM)}`]: f } }, budgeted(mib))[0]!;

describe("a large block at activate", () => {
  live("CLAP: nothing at instantiate, the block at activate and at rest, in the second instance too; above a budget below it, within one above", () => {
    const m = clapMemory(join(FAULTY, "hogs-memory.clap"));
    expect(m.afterInstantiateKb!).toBeLessThan(8 * MIB);
    expect(m.afterActivateKb!).toBeGreaterThanOrEqual(64 * MIB);
    expect(m.atRestKb!).toBeGreaterThanOrEqual(64 * MIB);
    expect(m.secondInstanceKb!).toBeGreaterThanOrEqual(64 * MIB);
    expect(judged(m, 32)).toMatchObject({ rating: "unsuitable", code: HOSTING_CODE.memoryAboveCeiling, params: { figure: "perInstance" } });
    expect(judged(m, 128)).toMatchObject({ rating: "suitable", code: HOSTING_CODE.memoryWithinCeiling });
  });

  live("LV2: the same", () => {
    const m = lv2Memory("urn:plugin-qualify:fixture:lv2-large-activate");
    expect(m.afterInstantiateKb!).toBeLessThan(8 * MIB);
    expect(m.afterActivateKb!).toBeGreaterThanOrEqual(64 * MIB);
    expect(m.secondInstanceKb!).toBeGreaterThanOrEqual(64 * MIB);
    expect(judged(m, 32).code).toBe(HOSTING_CODE.memoryAboveCeiling);
  });

  live("a plain plugin holds next to nothing, both formats, and within a small budget", () => {
    for (const m of [clapMemory(join(FIXTURES, "rt-safe.clap")), lv2Memory("urn:plugin-qualify:fixture:lv2-rt-safe")]) {
      expect(firstInstanceKb(m)!).toBeLessThan(4 * MIB);
      expect(perInstanceKb(m)!).toBeLessThan(MIB);
      expect(judged(m, 8).rating).toBe("suitable");
    }
  });
});

describe("an allocation per voice", () => {
  live("nothing at rest, all of it with notes held: 8 notes of 4 MiB, the basis named, and judged by what the voices come to", () => {
    const m = clapMemory(join(FAULTY, "synth-voice-memory.clap"), "--hold", "8");
    expect(m.atRestKb!).toBeLessThan(4 * MIB);
    expect(m.notesHeldKb! - m.atRestKb!).toBeGreaterThanOrEqual(8 * 4 * MIB);
    expect(m.basis).toBe("probe");
    expect(perInstanceKb(m)!).toBeGreaterThanOrEqual(8 * 4 * MIB);
    expect(judged(m, 16)).toMatchObject({ rating: "unsuitable", code: HOSTING_CODE.memoryAboveCeiling });
    expect(judged({ ...m, notesHeldKb: undefined as never }, 16).rating).toBe("suitable");
  });

  live("an instrument with no count of notes to hold has no such figure and says why, so it is not read as fitting", () => {
    const m = clapMemory(join(FIXTURES, "synth.clap"));
    expect(m.notesHeldKb).toBeUndefined();
    expect(m.unmeasuredReason).toBe("voices-unknown");
    expect(judged(m, 16)).toMatchObject({ rating: "unknown", code: HOSTING_CODE.memoryUnmeasured, params: { unmeasuredReason: "voices-unknown" } });
  });

  live("LV2 reads notes held at the probe count, and says why with none", () => {
    expect(lv2Memory("urn:plugin-qualify:fixture:lv2-synth", { OMX_PROBE_NOTES: "8" })).toMatchObject({ basis: "probe", notesHeldKb: expect.any(Number) });
    expect(lv2Memory("urn:plugin-qualify:fixture:lv2-synth").unmeasuredReason).toBe("voices-unknown");
  });
});

describe("a leak per block, over a soak (LV2: the CLAP prober has no continuous render)", () => {
  const soak = (uri: string) => {
    const line = lv2Line(uri, { OMX_SOAK_SECONDS: "12" }, [String(RATE), "1024"]);
    return readSoakAtRate(line.soak)!;
  };
  const findings = (at: ReturnType<typeof soak>) => soakFindings({ sweptParams: true, perRate: { [String(RATE)]: at } }, DEFAULT_HOSTING_POLICY)!;

  live("64 KiB a block at 48000/1024 is about 180 MB a minute of audio: it reads leaks, with the figure and the ceiling", () => {
    const at = soak("urn:plugin-qualify:fixture:lv2-leaks");
    expect(at.rssAfterWarmupKb).toBeGreaterThan(at.rssStartKb!);
    expect(at.rssMidKb).toBeGreaterThan(at.rssAfterWarmupKb!);
    const [f] = findings(at).failed;
    expect(f?.kind).toBe("leaks");
    expect(Number(f?.params?.["growthKbPerMin"])).toBeGreaterThan(100 * MIB);
    expect(f?.params?.["ceilingKbPerMin"]).toBe(DEFAULT_HOSTING_POLICY.memoryGrowthKbPerMinCeiling);
  });

  live("the same gain with no leak: flat, nothing failed", () => {
    expect(findings(soak("urn:plugin-qualify:fixture:lv2-rt-safe")).failed).toEqual([]);
  });
});

describe("a memory-only run (plugin-qualify-sync --memory-only)", () => {
  const ONLY = { OMX_PROBE_MEMORY_ONLY: "1" };
  const clapLine = (file: string, env: Record<string, string> = {}) => {
    const r = spawnSync(PROBER, ["--rates", String(RATE), "--block", String(QUANTUM), file], { encoding: "utf8", env: { ...process.env, LD_PRELOAD: INTERPOSER, ...ONLY, ...env } });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout.split("\n")[0]!);
  };
  const lv2Only = (uri: string, env: Record<string, string> = {}) => lv2Line(uri, { ...ONLY, ...env }, [String(RATE), String(QUANTUM)]);

  live("CLAP: the footprint as an ordinary run takes it, and nothing else ran: no process call, no cost, no count", () => {
    const line = clapLine(join(FAULTY, "hogs-memory.clap"));
    const at = line.cost.perRate[String(RATE)];
    const m = readMemoryFootprint(at.memory)!;
    expect(m.afterActivateKb!).toBeGreaterThanOrEqual(64 * MIB);
    expect(m.secondInstanceKb!).toBeGreaterThanOrEqual(64 * MIB);
    expect(at.unmeasuredReason).toBe("not-attempted");
    expect(at.nsPerSampleMedian).toBeUndefined();
    expect(line.clap.processCalls).toBe(0);
    expect(line.rtSafety.interposer).toBe(false);
  });

  live("LV2: the same: no lifecycle, no sweep, no latency", () => {
    const line = lv2Only("urn:plugin-qualify:fixture:lv2-large-activate");
    const at = line.cost.perRate[String(RATE)];
    expect(readMemoryFootprint(at.memory)!.afterActivateKb!).toBeGreaterThanOrEqual(64 * MIB);
    expect(at.unmeasuredReason).toBe("not-attempted");
    expect(line.instantiated).toBe(true);
    expect(line.lifecycle).toBeUndefined();
    expect(line.rtSafety).toBeUndefined();
    expect(line.latency).toBeUndefined();
  });

  live("an instrument holds the count it is given, on both formats, and its notes are read: 16 notes of 4 MiB", () => {
    const m = readMemoryFootprint(clapLine(join(FAULTY, "synth-voice-memory.clap"), { OMX_PROBE_NOTES: "16" }).cost.perRate[String(RATE)].memory)!;
    expect(m.basis).toBe("probe");
    expect(m.notesHeldKb! - m.atRestKb!).toBeGreaterThanOrEqual(16 * 4 * MIB);
    expect(readMemoryFootprint(lv2Only("urn:plugin-qualify:fixture:lv2-synth", { OMX_PROBE_NOTES: "16" }).cost.perRate[String(RATE)].memory)).toMatchObject({ basis: "probe", notesHeldKb: expect.any(Number) });
  });

  live("without the variable an ordinary run is untouched: its cost is timed", () => {
    expect(clapMemory(join(FIXTURES, "rt-safe.clap")).atRestKb).toEqual(expect.any(Number));
    const r = spawnSync(PROBER, ["--rates", String(RATE), "--block", String(QUANTUM), "--blocks", "16", join(FIXTURES, "rt-safe.clap")], { encoding: "utf8", env: { ...process.env, LD_PRELOAD: INTERPOSER } });
    expect(JSON.parse(r.stdout.split("\n")[0]!).cost.perRate[String(RATE)].nsPerSampleMedian).toEqual(expect.any(Number));
  });
});

describe("the limit on a direct spawn", () => {
  live("past RLIMIT_AS the child ends with the bound's status, and that is the recorded outcome with the limit", () => {
    const limit = 48 * 2 ** 20;
    const spawned = addressSpaceLimited(PROBER, ["--rates", String(RATE), "--block", String(QUANTUM), "--blocks", "16", join(FAULTY, "hogs-memory.clap")], limit, false);
    const r = spawnSync(spawned.command, [...spawned.args], { encoding: "utf8", env: { ...process.env, ...spawned.env, LD_PRELOAD: INTERPOSER } });
    expect(directOutcome(r.status, spawned)).toEqual({ outcome: MEMORY_LIMIT_EXCEEDED, memoryLimit: { bytes: limit, mechanism: "rlimit-as" } });
  });

  live("the plain gain runs to its end under a limit that holds it", () => {
    const spawned = addressSpaceLimited(PROBER, ["--rates", String(RATE), "--block", String(QUANTUM), "--blocks", "16", join(FIXTURES, "rt-safe.clap")], 2 ** 30, false);
    const r = spawnSync(spawned.command, [...spawned.args], { encoding: "utf8", env: { ...process.env, ...spawned.env, LD_PRELOAD: INTERPOSER } });
    expect(r.status, r.stderr).toBe(0);
    expect(directOutcome(r.status, spawned)).toBeUndefined();
  });

  it("a sanitizer build runs with no limit, since it reserves far more than it uses, and no exit is read as the limit", () => {
    const spawned = addressSpaceLimited("/bin/true", ["x"], 2 ** 30, true);
    expect(spawned).toEqual({ command: "/bin/true", args: ["x"], env: {} });
    expect(directOutcome(121, spawned)).toBeUndefined();
  });

  it("a sanitizer build is told by its own init symbol, in the file", () => {
    expect(isSanitizerBuild("x", () => Buffer.from("....__asan_init...."))).toBe(true);
    expect(isSanitizerBuild("x", () => Buffer.from("....__tsan_init...."))).toBe(true);
    expect(isSanitizerBuild("x", () => Buffer.from("plain"))).toBe(false);
    expect(isSanitizerBuild("x", () => { throw new Error("gone"); })).toBe(false);
  });
});
