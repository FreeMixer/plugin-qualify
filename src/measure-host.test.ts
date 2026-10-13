// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Spec §2a: the tool reads a record a plugin has printed into, and a soak's limit is sized.
 * 2026-10-01: Guitarix wrote `using block size: 0` / `convolver disabled` into the middle of
 * lv2_measure's JSON line, and a fixed `timeout 900` cut ZamGEQ31's 51-minute soak.
 */
import { describe, expect, it } from "vitest";
import { extractJsonRecord, soakSweepEnv, soakTimeoutSeconds } from "./measure-host.js";
import { SOAK_SWEEP_DB, SOAK_SWEEP_RATIO, SOAK_TIMEOUT_FLOOR_S, SOAK_TIMEOUT_MARGIN } from "./qualify-declarations.js";

describe("extractJsonRecord", () => {
  const clean = '{"uri":"urn:x","found":true,"rtSafety":{"swept":true,"events":[]}}';

  it("reads a clean line", () => {
    expect(extractJsonRecord(`${clean}\n`)).toEqual(JSON.parse(clean));
  });

  it("reads a record behind a banner and ignores a banner after it", () => {
    expect(extractJsonRecord(`banner\n${clean}\ntrailing banner\n`)).toEqual(JSON.parse(clean));
  });

  it("strips the banners Guitarix printed into the middle of the line and joins it (the 2026-10-01 defect)", () => {
    const torn = '{"uri":"urn:guitarix","found":true,"rate":48000,using block size: 0\nconvolver disabled\n"block":512,"rtSafety":{"swept":true}}\n';
    expect(extractJsonRecord(torn)).toEqual({ uri: "urn:guitarix", found: true, rate: 48000, block: 512, rtSafety: { swept: true } });
  });

  it("repairs a banner torn into a nested object and into the end of a string-free tail", () => {
    const torn = '{"a":{"b":1,using block size: 0\n"c":2},"d":[1,\nconvolver disabled\n2]}\n';
    expect(extractJsonRecord(torn)).toEqual({ a: { b: 1, c: 2 }, d: [1, 2] });
  });

  it("a record that does not repair is undefined — a parse-error for the caller, never a value", () => {
    expect(extractJsonRecord("no json here\n")).toBeUndefined();
    expect(extractJsonRecord('{"uri":"x","found":\n')).toBeUndefined();
    expect(extractJsonRecord("")).toBeUndefined();
  });
});

describe("soakTimeoutSeconds", () => {
  it("is sized from the measured speed and the soak length, not fixed", () => {
    // ZamGEQ31 at 192 kHz: 3 h of audio took 51 min wall = 0.2833 wall s per audio s.
    const wallPerAudio = (51 * 60) / 10_800;
    const t = soakTimeoutSeconds({ wallSeconds: wallPerAudio * 30, audioSeconds: 30 }, 10_800);
    expect(t).toBeGreaterThan(51 * 60);
    expect(t).toBeGreaterThan(900);
    expect(t).toBe(Math.ceil(wallPerAudio * 10_800 * SOAK_TIMEOUT_MARGIN + SOAK_TIMEOUT_FLOOR_S));
  });

  it("a faster plugin gets a shorter limit than a slower one, over the same soak", () => {
    const fast = soakTimeoutSeconds({ wallSeconds: 0.15, audioSeconds: 30 }, 10_800);
    const slow = soakTimeoutSeconds({ wallSeconds: 9, audioSeconds: 30 }, 10_800);
    expect(fast).toBeLessThan(slow);
  });

  it("refuses a calibration that measured nothing rather than guessing a limit", () => {
    expect(() => soakTimeoutSeconds({ wallSeconds: 0, audioSeconds: 30 }, 10_800)).toThrow(/no speed/);
    expect(() => soakTimeoutSeconds({ wallSeconds: 1, audioSeconds: 0 }, 10_800)).toThrow(/no speed/);
  });
});

describe("soakSweepEnv", () => {
  it("hands the host the declared bounds", () => {
    expect(soakSweepEnv()).toEqual({ OMX_SWEEP_DB: String(SOAK_SWEEP_DB), OMX_SWEEP_RATIO: String(SOAK_SWEEP_RATIO) });
  });
});
