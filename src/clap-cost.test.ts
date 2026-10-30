// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The CLAP prober's cost arm (#78). An instrument costs nothing until a voice plays, so it is timed
 * holding notes down: as many as the voice capacity it declares (basis `declared`), or the caller's
 * probe count when it declares none (basis `probe`). The live tests run the built prober against the
 * fixture synth, whose every voice costs a sine per sample, so the figure must grow with the notes
 * held; the rest reads lines by hand. On CI a missing build is a failure; elsewhere the live tests skip.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  clapCostPerRate,
  isClapCostFigure,
  parseClapQualifyLine,
  proberOffer,
  qualifiedPluginOfClapLine,
  rtSafetyDocument,
  type ClapCostAtRate,
  type ClapCostFigure,
} from "./clap-qualify.js";
import { classifyPluginHosting } from "./hosting-suitability.js";
import { HOSTING_CODE } from "./hosting-codes.js";
import { OMX_CLAP_HOST_PROFILE, OPENMIXER_CONSOLE_PROFILE } from "./host-profiles.js";
import { DEFAULT_HOSTING_POLICY } from "./qualify-declarations.js";
import { qualifyClap } from "./direct-prober.support.js";
import { OMX_CLAP_HOST_EXTENSIONS } from "./host-profiles.js";
import { QUALIFY_RATES } from "./qualify-declarations.js";
import { clapQualifyToolPath, rtInterposePath } from "./tool-paths.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "native", "build", "fixtures");
const SYNTH = join(FIXTURES, "synth.clap");
const SYNTH_VOICES = join(FIXTURES, "synth-voices.clap");
const SYNTH_NO_VOICES = join(FIXTURES, "synth-no-voices.clap");
const SYNTH_MIDI = join(FIXTURES, "synth-midi.clap");
const SYNTH_INPUT = join(FIXTURES, "synth-input.clap");
const SYNTH_ALLOC = join(FIXTURES, "synth-alloc.clap");
const SAFE = join(FIXTURES, "rt-safe.clap");
const BUILT = [clapQualifyToolPath(), rtInterposePath(), SYNTH, SYNTH_VOICES, SYNTH_NO_VOICES, SYNTH_MIDI, SYNTH_INPUT, SYNTH_ALLOC, SAFE].every((p) => existsSync(p));

function live(name: string, body: () => void): void {
  it(name, (ctx) => {
    if (!BUILT) {
      if (process.env["CI"]) throw new Error("native/build is missing: CI builds it with make -C native deps all");
      ctx.skip("native/build is missing: make -C native deps all");
    }
    body();
  });
}

const RATE = QUALIFY_RATES[0]!;

function figure(at: ClapCostAtRate | undefined): ClapCostFigure {
  if (at === undefined || !isClapCostFigure(at)) throw new Error(`no figure: ${JSON.stringify(at)}`);
  return at;
}

describe("clap-qualify, live — an instrument's cost is taken with notes held", () => {
  live("held at the probe count when it declares no voices, at every rate, and it costs more with more notes", () => {
    const [one] = qualifyClap(SYNTH, undefined, { rates: QUALIFY_RATES, probeNotes: 1 });
    const [sixteen] = qualifyClap(SYNTH, undefined, { rates: QUALIFY_RATES, probeNotes: 16 });
    expect(one!.cost?.stimulus).toBe("notes-held");
    for (const rate of QUALIFY_RATES) {
      const low = figure(one!.cost?.perRate[String(rate)]);
      const high = figure(sixteen!.cost?.perRate[String(rate)]);
      expect(low.voices).toEqual({ held: 1, basis: "probe" });
      expect(high.voices).toEqual({ held: 16, basis: "probe" });
      // sixteen sines a sample against one: the median grows with the voices, far past timing noise
      expect(high.nsPerSampleMedian).toBeGreaterThan(3 * low.nsPerSampleMedian);
      expect(high.nsPerSampleP95).toBeGreaterThanOrEqual(high.nsPerSampleMedian);
    }
  });

  live("held at the capacity voice-info declares, basis declared, whatever probe count is given", () => {
    const [l] = qualifyClap(SYNTH_VOICES, undefined, { rates: [RATE], probeNotes: 32 });
    expect(figure(l!.cost?.perRate[String(RATE)]).voices).toEqual({ held: 8, basis: "declared", capacity: 8 });
  });

  live("--hold holds its count over a declared capacity, and says the count was the caller's", () => {
    const [l] = qualifyClap(SYNTH_VOICES, undefined, { rates: [RATE], hold: 2 });
    expect(figure(l!.cost?.perRate[String(RATE)]).voices).toEqual({ held: 2, basis: "probe", capacity: 8 });
  });

  live("an instrument with no count to hold is not timed, and one declaring no voice is not either", () => {
    const [unknown] = qualifyClap(SYNTH, undefined, { rates: [RATE] });
    expect(unknown!.cost?.perRate[String(RATE)]).toMatchObject({ unmeasuredReason: "voices-unknown" });
    const [none] = qualifyClap(SYNTH_NO_VOICES, undefined, { rates: [RATE], probeNotes: 32 });
    expect(none!.cost?.perRate[String(RATE)]).toMatchObject({ unmeasuredReason: "no-voices", voices: { capacity: 0 } });
  });

  live("a synth that reads only MIDI holds its notes in MIDI's dialect", () => {
    const [one] = qualifyClap(SYNTH_MIDI, undefined, { rates: [RATE], probeNotes: 1 });
    const [sixteen] = qualifyClap(SYNTH_MIDI, undefined, { rates: [RATE], probeNotes: 16 });
    expect(figure(sixteen!.cost?.perRate[String(RATE)]).nsPerSampleMedian).toBeGreaterThan(3 * figure(one!.cost?.perRate[String(RATE)]).nsPerSampleMedian);
  });

  live("an instrument with an audio input is still an instrument: it holds notes, its input hearing the noise", () => {
    const [l] = qualifyClap(SYNTH_INPUT, undefined, { rates: [RATE], probeNotes: 16 });
    expect(l!.clap.mainInputChannels).toBe(2);
    expect(l!.cost?.stimulus).toBe("notes-held");
    expect(figure(l!.cost?.perRate[String(RATE)]).voices).toEqual({ held: 16, basis: "probe" });
  });

  live("an effect is timed under the sweep's noise and holds no note", () => {
    const [l] = qualifyClap(SAFE, undefined, { rates: [RATE], probeNotes: 16 });
    expect(l!.cost?.stimulus).toBe("noise");
    expect(figure(l!.cost?.perRate[String(RATE)]).voices).toBeUndefined();
  });

  live("the figure reaches the verdict document and the classifier's cost fields", () => {
    const [l] = qualifyClap(SYNTH, undefined, { rates: [RATE], probeNotes: 4 });
    expect(rtSafetyDocument(l!).measured.cost).toEqual(l!.cost);
    const fields = clapCostPerRate(l!.cost)[String(RATE)]!;
    expect(fields.coreFractionP95).toBeCloseTo((fields.nsPerSampleP95 * RATE) / 1e9, 12);
    expect(fields.voices).toEqual({ held: 4, basis: "probe" });
  });
});

/** A prober line for an instrument, its cost block replaced by `cost`. */
function line(cost: unknown): string {
  return JSON.stringify({
    uri: "urn:clap:x.synth",
    format: "clap",
    id: "x.synth",
    binary: { path: "/x/synth.clap", sha256: "a".repeat(64) },
    hostExtensions: [...OMX_CLAP_HOST_EXTENSIONS],
    clap: {
      mainInputChannels: 0, mainOutputChannels: 2, sidechainInputs: 0, features: ["instrument"], headlessOk: true, noteInputs: 1,
      latency: { "48000": { declaredFrames: 0, measuredFrames: 0 } }, threadViolations: 0, processErrors: 0, processCalls: 512, nonFinite: false,
    },
    rtSafety: { interposer: false },
    noteSweep: { applicable: true, dialect: "clap", blocks: 512, blockFrames: 512, noteEvents: 900, processErrors: 0, nonFinite: false, interposer: false },
    ...(cost === undefined ? {} : { cost }),
    integrity: { version: "1", files: [{ path: "synth.clap", sha256: "a".repeat(64) }], layout: { scheme: "omx-layout/1", sha256: "b".repeat(64) } },
  });
}

const held = {
  nsPerSampleMedian: 40, nsPerSampleP95: 44, nsPerSampleMin: 39, nsPerSampleMax: 90, warmupNsPerSampleMedian: 41, blocks: 512,
  voices: { held: 32, basis: "probe" },
};
const cost = (perRate: object, stimulus = "notes-held") => ({ stimulus, blockFrames: 512, warmupBlocks: 64, percentile: 95, perRate });

describe("the cost block in the prober's line", () => {
  it("reads a held figure and an unmeasured rate side by side", () => {
    const l = parseClapQualifyLine(line(cost({ "48000": held, "96000": { unmeasuredReason: "voices-unknown", unmeasuredDetail: "no count" } })));
    expect(l.cost?.perRate["48000"]).toEqual(held);
    expect(l.cost?.perRate["96000"]).toEqual({ unmeasuredReason: "voices-unknown", unmeasuredDetail: "no count" });
    expect(Object.keys(clapCostPerRate(l.cost))).toEqual(["48000"]);
  });

  it("a line with no cost block reads, without one", () => {
    expect(parseClapQualifyLine(line(undefined)).cost).toBeUndefined();
  });

  it("refuses an instrument timed without saying what it held, and notes held under noise", () => {
    const { voices: _v, ...bare } = held;
    expect(() => parseClapQualifyLine(line(cost({ "48000": bare })))).toThrow(/without saying what it held/);
    expect(() => parseClapQualifyLine(line(cost({ "48000": held }, "noise")))).toThrow(/fed noise/);
  });

  it("refuses an unknown basis, no note held, a negative figure and a rate that is not one", () => {
    expect(() => parseClapQualifyLine(line(cost({ "48000": { ...held, voices: { held: 4, basis: "guess" } } })))).toThrow(/basis/);
    expect(() => parseClapQualifyLine(line(cost({ "48000": { ...held, voices: { held: 0, basis: "probe" } } })))).toThrow(/no note/);
    expect(() => parseClapQualifyLine(line(cost({ "48000": { ...held, nsPerSampleP95: -1 } })))).toThrow(/nsPerSampleP95/);
    expect(() => parseClapQualifyLine(line(cost({ "48k": held })))).toThrow(/rate 48k/);
    expect(() => parseClapQualifyLine(line(cost({ "48000": { ...held, blocks: 0 } })))).toThrow(/no block/);
  });
});

describe("clap-qualify, live — the full classifier reads the prober's instrument (#79)", () => {
  const rate = OMX_CLAP_HOST_PROFILE.cost.rate;
  /** What the soak would have written for a plugin that held: the prober measures no stability. */
  const soaked = {
    lifecycle: { cycles: DEFAULT_HOSTING_POLICY.cycleFloor, instantiated: DEFAULT_HOSTING_POLICY.cycleFloor, failed: 0 },
    threads: { before: 1, afterFirstInstantiate: 1, afterAllFreed: 1, leaked: 0 },
    crashes: [],
    soak: { sweptParams: true, perRate: { [String(rate)]: { instantiated: true, seconds: DEFAULT_HOSTING_POLICY.soakSeconds, windows: 10_000,
      nonFiniteWindows: 0, silentWindows: 0, firstRmsDbfs: -30, lastRmsDbfs: -30, rssGrowthKb: 0 } } },
    linksGuiToolkit: false,
  };
  const judged = (path: string, profile: typeof OMX_CLAP_HOST_PROFILE) => {
    const [l] = qualifyClap(path, undefined, { rates: [rate], probeNotes: 16, offer: proberOffer(profile) ?? [] });
    return classifyPluginHosting(qualifiedPluginOfClapLine(l!, soaked), { rate, profile });
  };

  live("synth.clap is suitable under omx-clap-host, its latency from a note resolved, and unsuitable under the console", () => {
    const host = judged(SYNTH, OMX_CLAP_HOST_PROFILE);
    expect(host.rating).toBe("suitable");
    expect(host.reasons.map((r) => r.code)).toEqual(expect.arrayContaining([
      HOSTING_CODE.rtSafetyNotesClean, HOSTING_CODE.latencyResolved, HOSTING_CODE.topologyInstrument, HOSTING_CODE.costWithinCeiling,
    ]));
    const console = judged(SYNTH, OPENMIXER_CONSOLE_PROFILE);
    expect(console.rating).toBe("unsuitable");
    expect(console.reasons.map((r) => r.code)).toContain(HOSTING_CODE.clapNoteInput);
  });

  live("the synth that allocates on note on is conditional under omx-clap-host, on the note sweep", () => {
    const v = judged(SYNTH_ALLOC, OMX_CLAP_HOST_PROFILE);
    expect(v).toMatchObject({ rating: "conditional", deciding: { code: HOSTING_CODE.rtSafetyNotesViolations } });
  });
});

