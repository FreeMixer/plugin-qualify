// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The stage-2 proof: a verdict read from a probe output equals the verdict read from today's
 * document, line by line and profile by profile, and two quanta of different cost give two
 * different cost reasons.
 */
import { describe, expect, it } from "vitest";

import { rtSafetyDocument, rtSafetyVerdict, type ClapQualifyLine } from "./clap-qualify.js";
import { HOSTING_CODE } from "./hosting-codes.js";
import {
  JALV_PROFILE,
  OMX_CLAP_HOST_PROFILE,
  OMX_CLAP_HOST_EXTENSIONS,
  OPENMIXER_CONSOLE_PROFILE,
  type HostProfile,
} from "./host-profiles.js";
import { clapLineFromProbeOutput, judgeProbeOutput } from "./probe-judge.js";
import { readProbeOutput, type ProbeOutput } from "./probe-output.js";
import { clapLineFixture, fixtureJson, probeOutputOfLine, readFixture } from "./probe-output-fixtures.js";

const withGui = [...OMX_CLAP_HOST_EXTENSIONS, "clap.gui"];
const OWN_GUI: HostProfile = { ...OPENMIXER_CONSOLE_PROFILE, id: "own-gui", clapExtensions: withGui };

/** Every shape of line the existing tests of the CLAP arm exercise, each with the profiles it is judged under. */
const CASES: { name: string; line: ClapQualifyLine; profiles: HostProfile[]; expected: string }[] = [
  { name: "a clean effect", line: clapLineFixture(), profiles: [OPENMIXER_CONSOLE_PROFILE, OMX_CLAP_HOST_PROFILE, JALV_PROFILE, OWN_GUI], expected: "suitable" },
  { name: "an allocation", line: clapLineFixture({ rtSafety: { allocationsInRun: 3 } }), profiles: [OPENMIXER_CONSOLE_PROFILE], expected: "unsuitable" },
  { name: "a lock", line: clapLineFixture({ rtSafety: { locksInRun: 1 } }), profiles: [OPENMIXER_CONSOLE_PROFILE], expected: "unsuitable" },
  { name: "a syscall", line: clapLineFixture({ rtSafety: { syscallsInRun: 3 } }), profiles: [OPENMIXER_CONSOLE_PROFILE], expected: "unsuitable" },
  { name: "a thread violation", line: clapLineFixture({ clap: { threadViolations: 1 } }), profiles: [OPENMIXER_CONSOLE_PROFILE], expected: "unsuitable" },
  { name: "a process error", line: clapLineFixture({ clap: { processErrors: 2 } }), profiles: [OPENMIXER_CONSOLE_PROFILE], expected: "unsuitable" },
  { name: "a sweep that ran nothing", line: clapLineFixture({ clap: { processCalls: 0 } }), profiles: [OPENMIXER_CONSOLE_PROFILE], expected: "unknown" },
  { name: "no interposer", line: clapLineFixture({ rtSafety: { interposer: false } }), profiles: [OPENMIXER_CONSOLE_PROFILE], expected: "unknown" },
  { name: "controls not swept", line: clapLineFixture({ rtSafety: { swept: false } }), profiles: [OPENMIXER_CONSOLE_PROFILE], expected: "unknown" },
  { name: "a plugin with no parameter", line: clapLineFixture({ rtSafety: { swept: false, sweepApplicable: false } }), profiles: [OPENMIXER_CONSOLE_PROFILE], expected: "suitable" },
  {
    name: "other host extensions than the profile's",
    line: clapLineFixture({ hostExtensions: withGui }),
    profiles: [OPENMIXER_CONSOLE_PROFILE, OWN_GUI],
    expected: "unknown",
  },
  {
    name: "a played instrument, clean",
    line: clapLineFixture({
      clap: { noteInputs: 1 },
      noteSweep: { applicable: true, dialect: "clap", blocks: 512, blockFrames: 512, noteEvents: 40, processErrors: 0, nonFinite: false, interposer: true, allocationsInRun: 0, locksInRun: 0, syscallsInRun: 0, events: [] },
    }),
    profiles: [OPENMIXER_CONSOLE_PROFILE],
    expected: "suitable",
  },
  {
    name: "a played instrument that allocates, in the midi dialect",
    line: clapLineFixture({
      clap: { noteInputs: 1 },
      noteSweep: { applicable: true, dialect: "midi", blocks: 512, blockFrames: 512, noteEvents: 40, processErrors: 0, nonFinite: false, interposer: true, allocationsInRun: 5, locksInRun: 0, syscallsInRun: 0, events: [] },
    }),
    profiles: [OPENMIXER_CONSOLE_PROFILE],
    expected: "unsuitable",
  },
  {
    name: "an instrument played with a syscall",
    line: clapLineFixture({
      clap: { noteInputs: 1 },
      noteSweep: { applicable: true, dialect: "clap", blocks: 512, blockFrames: 512, noteEvents: 40, processErrors: 0, nonFinite: false, interposer: true, allocationsInRun: 0, locksInRun: 0, syscallsInRun: 2, events: [] },
    }),
    profiles: [OPENMIXER_CONSOLE_PROFILE],
    expected: "unsuitable",
  },
  {
    name: "an instrument that could not be played",
    line: clapLineFixture({ clap: { noteInputs: 1 }, noteSweep: { applicable: false } }),
    profiles: [OPENMIXER_CONSOLE_PROFILE],
    expected: "unknown",
  },
  {
    name: "an instrument played with no interposer",
    line: clapLineFixture({
      clap: { noteInputs: 1 },
      rtSafety: { interposer: false },
      noteSweep: { applicable: true, dialect: "clap", blocks: 512, blockFrames: 512, noteEvents: 40, processErrors: 0, nonFinite: false, interposer: false },
    }),
    profiles: [OPENMIXER_CONSOLE_PROFILE],
    expected: "unknown",
  },
];

function judged(line: ClapQualifyLine, profile: HostProfile) {
  const read = readProbeOutput(JSON.stringify(probeOutputOfLine(line)));
  if (!read.ok) throw new Error(`${read.code}: ${read.problem}`);
  return judgeProbeOutput(read.output, [profile], { noteInputs: line.clap.noteInputs });
}

describe("verdicts from a probe output equal verdicts from today's documents", () => {
  for (const c of CASES) {
    for (const profile of c.profiles) {
      it(`${c.name}, judged for ${profile.id}`, () => {
        const today = rtSafetyDocument(c.line, profile);
        const j = judged(c.line, profile);
        expect(j.hosts).toHaveLength(1);
        expect(j.hosts[0]?.verdict).toEqual(rtSafetyVerdict(today));
        expect(j.hosts[0]?.reasons.map((r) => [r.dimension, r.rating, r.code])).toEqual(
          today.verdict.reasons.map((r) => [r.dimension, r.rating, r.code]),
        );
        expect(j.documents[0]?.verdict.rating).toBe(today.verdict.rating);
        expect(j.documents[0]?.measured.integrity).toEqual(c.line.integrity);
      });
    }
  }

  it("the cases span every rating, so the equality is not three copies of one answer", () => {
    const ratings = new Set(CASES.flatMap((c) => c.profiles.map((p) => rtSafetyDocument(c.line, p).verdict.rating)));
    expect([...ratings].sort()).toEqual(["suitable", "unknown", "unsuitable"]);
    for (const c of CASES) expect(rtSafetyDocument(c.line, c.profiles[0]!).verdict.rating).toBe(c.expected);
  });

  it("a probe output with the counts changed gives the changed verdict (the proof can fail)", () => {
    const line = clapLineFixture();
    const doc = probeOutputOfLine(line);
    doc["grid"][0]["rtSafety"]["allocations"] = 1;
    const read = readProbeOutput(JSON.stringify(doc));
    if (!read.ok) throw new Error(read.problem);
    const j = judgeProbeOutput(read.output, [OPENMIXER_CONSOLE_PROFILE]);
    expect(j.hosts[0]?.verdict).toMatchObject({ rating: "unsuitable", qualified: false, deciding: HOSTING_CODE.rtSafetyViolations });
    expect(j.hosts[0]?.verdict).not.toEqual(rtSafetyVerdict(rtSafetyDocument(line)));
  });
});

describe("the line a probe output stands for", () => {
  it("sums the interposer's counts over the points that carry them and reads a missing count as unmeasured", () => {
    const doc = probeOutputOfLine(clapLineFixture());
    doc["grid"][1]["rtSafety"] = { ...doc["grid"][0]["rtSafety"], allocations: 2, blocks: 100, threadViolations: 1 };
    const read = readProbeOutput(JSON.stringify(doc));
    if (!read.ok) throw new Error(read.problem);
    const line = clapLineFromProbeOutput(read.output);
    expect(line.rtSafety).toMatchObject({ allocationsInRun: 2, blocks: 612, interposer: true });
    expect(line.clap.threadViolations).toBe(1);
    doc["grid"][1]["rtSafety"]["threadViolations"] = 0;
    delete doc["grid"][1]["rtSafety"]["locks"];
    const again = readProbeOutput(JSON.stringify(doc));
    if (!again.ok) throw new Error(again.problem);
    expect(clapLineFromProbeOutput(again.output).rtSafety.locksInRun).toBeUndefined();
    expect(judgeProbeOutput(again.output, [OPENMIXER_CONSOLE_PROFILE]).hosts[0]?.verdict).toMatchObject({ rating: "unknown", deciding: HOSTING_CODE.rtSafetyUnmeasured });
  });

  it("reads the interposer as absent when any counting point ran without it", () => {
    const doc = probeOutputOfLine(clapLineFixture());
    doc["grid"][1]["rtSafety"] = { interposer: false };
    const read = readProbeOutput(JSON.stringify(doc));
    if (!read.ok) throw new Error(read.problem);
    expect(clapLineFromProbeOutput(read.output).rtSafety).toEqual({ interposer: false });
  });

  it("takes note inputs from the descriptor's fact when given, else from the note sweep", () => {
    const withNotes = probeOutputOfLine(clapLineFixture({ clap: { noteInputs: 1 }, noteSweep: { applicable: true, dialect: "clap", interposer: true, allocationsInRun: 0, locksInRun: 0, syscallsInRun: 0 } }));
    const read = readProbeOutput(JSON.stringify(withNotes));
    if (!read.ok) throw new Error(read.problem);
    expect(clapLineFromProbeOutput(read.output).clap.noteInputs).toBe(1);
    expect(clapLineFromProbeOutput(read.output, { noteInputs: 3 }).clap.noteInputs).toBe(3);
    const none = readFixture("success-msi");
    expect(clapLineFromProbeOutput(none).clap.noteInputs).toBe(0);
  });
});

describe("the fixtures of plugin-hostd", () => {
  it("the success on the reference rig is suitable for omx-clap-host, and unknown for a console it did not offer to", () => {
    const o = readFixture("success-msi");
    const j = judgeProbeOutput(o, [OMX_CLAP_HOST_PROFILE, OPENMIXER_CONSOLE_PROFILE]);
    expect(j.hosts.map((h) => [h.verdict.host, h.verdict.rating, h.hosting])).toEqual([
      ["omx-clap-host", "suitable", "isolated"],
      ["openmixer-console", "unknown", "isolated"],
    ]);
    expect(j.hosts[1]?.verdict.deciding).toBe(HOSTING_CODE.clapExtensionsNotCovered);
    expect(j.hosts[0]?.reasons.map((r) => r.code)).toEqual([HOSTING_CODE.rtSafetyClean]);
    expect(j.documents[0]?.measured.integrity.layout?.sha256).toBe("0a3e01399262321514e05af0575ebb0b207a35567ac262a060fde655ee069805");
  });

  it("a run that crashed is unknown under every profile, the run's outcome the reason, and unmeasured for the exit code", () => {
    const o = readFixture("plugin-crash");
    const j = judgeProbeOutput(o, [OPENMIXER_CONSOLE_PROFILE, OMX_CLAP_HOST_PROFILE]);
    expect(j.hosts.map((h) => h.verdict)).toEqual([
      { uri: "urn:example:zero-path", host: "openmixer-console", measured: false, rating: "unknown", qualified: false, deciding: "probe.crashed" },
      { uri: "urn:example:zero-path", host: "omx-clap-host", measured: false, rating: "unknown", qualified: false, deciding: "probe.crashed" },
    ]);
    expect(j.documents).toEqual([]);
    const refused = judgeProbeOutput(readFixture("memory-limit-refused"), [OPENMIXER_CONSOLE_PROFILE]);
    expect(refused.hosts[0]?.verdict.deciding).toBe("probe.memory-limit");
  });

  it("a grid point that failed under a run that says ok is the failure it records, never a pass that skipped the point", () => {
    const doc = fixtureJson("success-msi");
    doc["grid"][1]["outcome"] = "probe.timeout";
    const read = readProbeOutput(JSON.stringify(doc));
    if (!read.ok) throw new Error(read.problem);
    const j = judgeProbeOutput(read.output, [OMX_CLAP_HOST_PROFILE]);
    expect(j.hosts[0]?.verdict).toMatchObject({ measured: false, rating: "unknown", deciding: "probe.timeout" });
    doc["grid"][1]["outcome"] = "probe.not-attempted";
    doc["grid"][1]["rtSafety"]["allocations"] = 5;
    const skipped = readProbeOutput(JSON.stringify(doc));
    if (!skipped.ok) throw new Error(skipped.problem);
    expect(judgeProbeOutput(skipped.output, [OMX_CLAP_HOST_PROFILE]).hosts[0]?.verdict).toMatchObject({ measured: true, rating: "suitable" });
  });

  it("an LV2 plugin is judged on the interposer's counts, under its URI", () => {
    const doc = fixtureJson("success-msi");
    doc["plugin"] = { format: "lv2", id: "urn:example:plate" };
    delete doc["offer"]["clapExtensions"];
    const read = readProbeOutput(JSON.stringify(doc));
    if (!read.ok) throw new Error(read.problem);
    const clean = judgeProbeOutput(read.output, [OPENMIXER_CONSOLE_PROFILE]);
    expect(clean.hosts[0]?.verdict).toEqual({ uri: "urn:example:plate", host: "openmixer-console", measured: true, rating: "suitable", qualified: true });
    expect(clean.hosts[0]?.hosting).toBe("in-process");
    expect(clean.documents).toEqual([]);
    doc["grid"][1]["rtSafety"]["syscalls"] = 7;
    const dirty = readProbeOutput(JSON.stringify(doc));
    if (!dirty.ok) throw new Error(dirty.problem);
    const j = judgeProbeOutput(dirty.output, [OPENMIXER_CONSOLE_PROFILE]);
    expect(j.hosts[0]?.verdict).toMatchObject({ rating: "unsuitable", deciding: HOSTING_CODE.rtSafetyViolations });
    expect(j.hosts[0]?.reasons[0]?.params).toEqual({ allocations: 0, syscalls: 7, locks: 0 });
  });
});

describe("cost at rate and quantum, from the grid of a probe output", () => {
  /** The success fixture with its grid replaced by cost points at one rate and the given quanta. */
  function withCost(points: { quantum: number; p95: number; median: number }[]): ProbeOutput {
    const doc = fixtureJson("success-msi");
    const costOf = (p: { p95: number; median: number }) => ({
      unit: "ns-per-sample",
      median: p.median,
      percentile: { p: 95, value: p.p95 },
      blocks: 1000,
      warmupBlocks: 64,
    });
    doc["grid"] = points.map((p) => ({ rate: 96000, quantum: p.quantum, outcome: "probe.ok", cost: costOf(p), rtSafety: doc["grid"][0]["rtSafety"] }));
    const read = readProbeOutput(JSON.stringify(doc));
    if (!read.ok) throw new Error(read.problem);
    return read.output;
  }
  const small = { ...OPENMIXER_CONSOLE_PROFILE, id: "small-quantum", cost: { ...OPENMIXER_CONSOLE_PROFILE.cost, quantum: 128 } };
  const large = OPENMIXER_CONSOLE_PROFILE;

  it("two quanta of different cost give two different cost reasons", () => {
    const o = withCost([
      { quantum: 128, p95: 800, median: 700 },
      { quantum: large.cost.quantum, p95: 200, median: 180 },
    ]);
    const [a, b] = judgeProbeOutput(o, [small, large]).hosts;
    expect(a?.cost.quantum).toBe(128);
    expect(b?.cost.quantum).toBe(large.cost.quantum);
    expect(a?.cost.reasons.map((r) => [r.code, r.rating, r.params])).toEqual([
      [HOSTING_CODE.costAboveCeiling, "unsuitable", { coreFractionP95: (800 * 96000) / 1e9, ceiling: 0.05 }],
    ]);
    expect(b?.cost.reasons.map((r) => [r.code, r.rating, r.params])).toEqual([
      [HOSTING_CODE.costWithinCeiling, "suitable", { coreFractionP95: (200 * 96000) / 1e9, ceiling: 0.05 }],
    ]);
  });

  it("a quantum the grid does not hold reads unmeasured at that rate and quantum, never the nearest", () => {
    const o = withCost([{ quantum: 128, p95: 800, median: 700 }]);
    const [, b] = judgeProbeOutput(o, [small, large]).hosts;
    expect(b?.cost.reasons.map((r) => [r.code, r.params])).toEqual([[HOSTING_CODE.costUnmeasured, { rate: 96000, quantum: large.cost.quantum }]]);
  });

  it("cost sits beside the verdict and does not change it", () => {
    const o = withCost([{ quantum: 128, p95: 800, median: 700 }]);
    const [a] = judgeProbeOutput(o, [small]).hosts;
    expect(a?.cost.reasons[0]?.rating).toBe("unsuitable");
    expect(a?.verdict.rating).not.toBe("unsuitable");
  });
});
