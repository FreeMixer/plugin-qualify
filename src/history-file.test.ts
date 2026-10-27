// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { HISTORY_HEADER, HISTORY_KEY_WORDS, findHistory, historyClasses, readHistory } from "./history-file.js";

const D1 = "a".repeat(64);
const D2 = "b".repeat(64);
const CLASS = "aarch64/4/2400";

/** A line as the daemon writes it (every key, in its order), by hand. */
const FULL =
  `history clap:/usr/lib/clap/fx.clap#org.example.fx ${D1} ${CLASS} first=1790000000 last=1790086400 windows_solo=400 windows_grouped=35 ` +
  "cpu_p95_solo=1.25 cpu_max_solo=2.50 pss_mb_solo=48.5 xrun_windows_solo=2 xrun_windows_grouped=9 crashes_solo=1 crashes_grouped=0 " +
  "restarts_grouped=3 quarantines=1 last_crash=1789900000 last_crash_grouped=0";

const read = (...lines: string[]) => readHistory([HISTORY_HEADER, ...lines, ""].join("\n"));

describe("readHistory, a line inside the grammar", () => {
  it("reads every key of the line as its value", () => {
    const r = read(FULL);
    expect(r).toEqual({
      ok: true,
      ignored: [],
      records: [
        {
          uri: "clap:/usr/lib/clap/fx.clap#org.example.fx",
          digest: D1,
          hostClass: CLASS,
          first: 1790000000,
          last: 1790086400,
          windowsSolo: 400,
          windowsGrouped: 35,
          cpuP95Solo: 1.25,
          cpuMaxSolo: 2.5,
          pssMbSolo: 48.5,
          xrunWindowsSolo: 2,
          xrunWindowsGrouped: 9,
          crashesSolo: 1,
          crashesGrouped: 0,
          restartsGrouped: 3,
          quarantines: 1,
          lastCrash: 1789900000,
          lastCrashGrouped: 0,
          unknownKeys: {},
        },
      ],
    });
  });

  it("reads a key the line leaves out as 0, and reads tabs and CRLF as spaces", () => {
    const r = readHistory(`${HISTORY_HEADER}\r\nhistory\turn:x\t${D1}\t${CLASS}\twindows_solo=7\r\n`);
    expect(r.ok && r.records[0]).toMatchObject({ uri: "urn:x", windowsSolo: 7, windowsGrouped: 0, cpuP95Solo: 0, lastCrash: 0 });
  });

  it("keeps a key it does not know on the record and still reads the known ones", () => {
    const r = read(`history urn:x ${D1} ${CLASS} windows_solo=361 future_key=7.5 crashes_solo=0 other=word`);
    expect(r.ok && r.records).toHaveLength(1);
    expect(r.ok && r.records[0]).toMatchObject({ windowsSolo: 361, crashesSolo: 0, unknownKeys: { future_key: "7.5", other: "word" } });
    expect(r.ok && r.ignored).toEqual([]);
  });

  it("skips blank and comment lines after the header, and an empty file is an empty history", () => {
    const withNotes = read("", "# a note", FULL, "");
    expect(withNotes.ok && withNotes.records).toHaveLength(1);
    expect(readHistory("")).toEqual({ ok: true, records: [], ignored: [] });
    expect(readHistory(`\n\n${HISTORY_HEADER}\n`)).toEqual({ ok: true, records: [], ignored: [] });
  });
});

describe("readHistory, a line outside the grammar is not read", () => {
  const problem = (line: string): string | undefined => {
    const r = read(line);
    if (!r.ok) throw new Error(r.problem);
    expect(r.records).toEqual([]);
    return r.ignored[0]?.problem;
  };

  it("names why, with the line number, for each way a line can be wrong", () => {
    expect(problem(`history urn:x ${D1}`)).toMatch(/uri, a digest and a host class/);
    expect(problem(`pin urn:x ${D1} ${CLASS}`)).toMatch(/uri, a digest and a host class/);
    expect(problem(`history urn:x ${"A".repeat(64)} ${CLASS}`)).toMatch(/not a digest/);
    expect(problem(`history urn:x ${"a".repeat(63)} ${CLASS}`)).toMatch(/not a digest/);
    expect(problem(`history urn:x ${D1} ${CLASS} windows_solo`)).toMatch(/not key=value/);
    expect(problem(`history urn:x ${D1} ${CLASS} windows_solo=-3`)).toMatch(/windows_solo=-3: not a whole number, or negative/);
    expect(problem(`history urn:x ${D1} ${CLASS} windows_solo=1.5`)).toMatch(/not a whole number/);
    expect(problem(`history urn:x ${D1} ${CLASS} windows_solo=+3`)).toMatch(/not a whole number/);
    expect(problem(`history urn:x ${D1} ${CLASS} windows_solo=many`)).toMatch(/not a whole number/);
    expect(problem(`history urn:x ${D1} ${CLASS} cpu_p95_solo=-1`)).toMatch(/not a decimal, or negative/);
    expect(problem(`history urn:x ${D1} ${CLASS} cpu_p95_solo=inf`)).toMatch(/not a decimal/);
    expect(problem(`history urn:x ${D1} ${CLASS} cpu_p95_solo=nan`)).toMatch(/not a decimal/);
    expect(problem(`history urn:x ${D1} ${CLASS} windows_solo=1 windows_solo=2`)).toMatch(/windows_solo: given twice/);
  });

  it("reads the good lines around a bad one and reports the bad one's line number", () => {
    const r = read(`history urn:a ${D1} ${CLASS} windows_solo=1`, `history urn:b ${D1} ${CLASS} windows_solo=-1`, `history urn:c ${D1} ${CLASS} windows_solo=3`);
    expect(r.ok && r.records.map((x) => [x.uri, x.windowsSolo])).toEqual([["urn:a", 1], ["urn:c", 3]]);
    expect(r.ok && r.ignored.map((i) => i.line)).toEqual([3]);
  });

  it("reads the first of two lines of one binary on one class, and both of one binary on two classes", () => {
    const r = read(`history urn:x ${D1} ${CLASS} windows_solo=1`, `history urn:x ${D1} ${CLASS} windows_solo=2`, `history urn:x ${D1} x86_64/8/3600 windows_solo=3`, `history urn:x ${D2} ${CLASS} windows_solo=4`);
    expect(r.ok && r.records.map((x) => x.windowsSolo)).toEqual([1, 3, 4]);
    expect(r.ok && r.ignored).toEqual([{ line: 3, problem: "a second line of one plugin binary on one host class" }]);
    expect(r.ok && historyClasses(r.records)).toEqual([CLASS, "x86_64/8/3600"]);
    expect(r.ok && findHistory(r.records, "urn:x", D2, CLASS)?.windowsSolo).toBe(4);
    expect(r.ok && findHistory(r.records, "urn:x", D2, "x86_64/8/3600")).toBeUndefined();
  });
});

describe("readHistory, the header", () => {
  it("refuses a version it does not know and a file that is not a history, as the daemon blocks them", () => {
    const v2 = readHistory(`# plugin-hostd history/2\nhistory urn:x ${D1} ${CLASS}\n`);
    expect(v2.ok).toBe(false);
    expect(!v2.ok && v2.problem).toMatch(/a version this reader does not know/);
    const other = readHistory(`pin_set urn:x\n`);
    expect(!other.ok && other.problem).toMatch(/not a history file/);
    expect(readHistory(`history urn:x ${D1} ${CLASS}\n`).ok).toBe(false);
  });
});

describe("the keys this reader knows are plugin-hostd's", () => {
  it("are, in order, the words of PLUGIN_HOSTD_HISTORY_KEYS when plugin-hostd's data/history.json is named", (ctx) => {
    const path = process.env["OMX_HISTORY_JSON"];
    if (path === undefined || !existsSync(path)) ctx.skip("OMX_HISTORY_JSON names no plugin-hostd data/history.json");
    const doc = JSON.parse(readFileSync(path!, "utf8")) as { PLUGIN_HOSTD_HISTORY_KEYS: { words: Record<string, { word: string }> } };
    expect(HISTORY_KEY_WORDS).toEqual(Object.values(doc.PLUGIN_HOSTD_HISTORY_KEYS.words).map((w) => w.word));
  });

  it("are fifteen, the daemon's count", () => {
    expect(HISTORY_KEY_WORDS).toHaveLength(15);
    expect(new Set(HISTORY_KEY_WORDS).size).toBe(15);
  });
});
