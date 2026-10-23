// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Spec §2a: the tool reads a record a plugin has printed into.
 * 2026-10-01: Guitarix wrote `using block size: 0` / `convolver disabled` into the middle of
 * lv2_measure's JSON line.
 */
import { describe, expect, it } from "vitest";
import { extractJsonRecord } from "./measure-host.js";

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
