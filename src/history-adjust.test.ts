// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
import { describe, expect, it } from "vitest";

import { HISTORY_POLICY, HISTORY_REASON, adjustVerdict, summariseHistory, type MeasuredReason } from "./history-adjust.js";
import type { HistoryRecord } from "./history-file.js";
import { JALV_PROFILE, OPENMIXER_CONSOLE_PROFILE } from "./host-profiles.js";

const NOW = 1_800_000_000;
const DAY = 86_400;

/** A steady plugin by default: 400 windows alone, 1 % of a core, no crash, no restart, no xrun. */
function rec(patch: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    uri: "clap:/usr/lib/clap/fx.clap#org.example.fx",
    digest: "a".repeat(64),
    hostClass: "aarch64/4/2400",
    first: NOW - 10 * DAY,
    last: NOW - 60,
    windowsSolo: 400,
    windowsGrouped: 0,
    cpuP95Solo: 1,
    cpuMaxSolo: 2,
    pssMbSolo: 40,
    xrunWindowsSolo: 0,
    xrunWindowsGrouped: 0,
    crashesSolo: 0,
    crashesGrouped: 0,
    restartsGrouped: 0,
    quarantines: 0,
    lastCrash: 0,
    lastCrashGrouped: 0,
    unknownKeys: {},
    ...patch,
  };
}

const COST_ONLY: MeasuredReason[] = [
  { code: "hosting.cost.spiky-tail", rating: "conditional" },
  { code: "hosting.latency.resolved", rating: "suitable" },
];
const CLEAN: MeasuredReason[] = [{ code: "hosting.rt-safety.clean-under-sweep", rating: "suitable" }];

const adjust = (measured: Parameters<typeof adjustVerdict>[0]["measured"], reasons: MeasuredReason[], record: HistoryRecord | undefined, profile = OPENMIXER_CONSOLE_PROFILE) =>
  adjustVerdict({ measured, reasons, record, profile, now: NOW });

describe("the summary is plugin-hostd's history_get rule", () => {
  it("is crashed for a counted crash within thirty days of the latest one, solo or grouped, and not a second later", () => {
    expect(summariseHistory(rec({ crashesSolo: 1, lastCrash: NOW - 30 * DAY }), NOW).crashed).toBe(true);
    expect(summariseHistory(rec({ crashesSolo: 1, lastCrash: NOW - 30 * DAY - 1 }), NOW).crashed).toBe(false);
    expect(summariseHistory(rec({ crashesGrouped: 2, lastCrashGrouped: NOW - DAY }), NOW).crashed).toBe(true);
    // the latest of the two stamps counts
    expect(summariseHistory(rec({ crashesSolo: 1, lastCrash: NOW - 90 * DAY, lastCrashGrouped: NOW - DAY }), NOW).crashed).toBe(true);
    expect(summariseHistory(rec({ crashesSolo: 0, crashesGrouped: 0, lastCrash: NOW }), NOW).crashed).toBe(false);
  });

  it("raises xruns from 30 grouped windows when the grouped share exceeds the solo share by five points, and by five percent with no solo window", () => {
    const grouped = (wg: number, xg: number, ws = 0, xs = 0) => summariseHistory(rec({ windowsGrouped: wg, xrunWindowsGrouped: xg, windowsSolo: ws, xrunWindowsSolo: xs }), NOW).raisesXruns;
    expect(grouped(29, 29)).toBe(false); // too few windows to read
    expect(grouped(100, 5)).toBe(false); // 5 % is the margin, not over it
    expect(grouped(100, 6)).toBe(true);
    expect(grouped(100, 15, 100, 10)).toBe(false); // 15 % against 10 % + 5 points
    expect(grouped(100, 16, 100, 10)).toBe(true);
    expect(grouped(100, 16, 100, 11)).toBe(false);
  });
});

describe("demoting", () => {
  it("demotes in-process to isolated after a crash, with history.crashed", () => {
    expect(adjust("in-process", CLEAN, rec({ crashesGrouped: 1, lastCrashGrouped: NOW - DAY }))).toEqual({
      measured: "in-process",
      adjusted: "isolated",
      move: "demote",
      reason: "history.crashed",
    });
  });

  it("demotes in-process to isolated for xruns when grouped, with history.xruns-grouped", () => {
    expect(adjust("in-process", CLEAN, rec({ windowsGrouped: 100, xrunWindowsGrouped: 40 }))).toEqual({
      measured: "in-process",
      adjusted: "isolated",
      move: "demote",
      reason: "history.xruns-grouped",
    });
  });

  it("names the crash when both a crash and xruns are there", () => {
    expect(adjust("in-process", CLEAN, rec({ crashesSolo: 1, lastCrash: NOW - 1, windowsGrouped: 100, xrunWindowsGrouped: 40 })).reason).toBe("history.crashed");
  });

  it("leaves an in-process verdict alone on an old crash or a quiet history", () => {
    expect(adjust("in-process", CLEAN, rec({ crashesSolo: 1, lastCrash: NOW - 31 * DAY })).move).toBe("none");
    const quiet = adjust("in-process", CLEAN, rec());
    expect(quiet).toEqual({ measured: "in-process", adjusted: "in-process", move: "none", reason: "history.no-change" });
  });

  it("demotes isolated to refused on three solo crashes within thirty days, with history.crashed-alone", () => {
    expect(adjust("isolated", COST_ONLY, rec({ crashesSolo: 3, lastCrash: NOW - 2 * DAY }))).toEqual({
      measured: "isolated",
      adjusted: "refused",
      move: "demote",
      reason: "history.crashed-alone",
    });
  });

  it("does not refuse on two solo crashes, on three that are old, or on grouped crashes", () => {
    expect(adjust("isolated", COST_ONLY, rec({ crashesSolo: 2, lastCrash: NOW - DAY })).adjusted).toBe("isolated");
    expect(adjust("isolated", COST_ONLY, rec({ crashesSolo: 3, lastCrash: NOW - 31 * DAY })).adjusted).toBe("isolated");
    expect(adjust("isolated", COST_ONLY, rec({ crashesGrouped: 5, lastCrashGrouped: NOW - DAY })).adjusted).toBe("isolated");
  });

  it("is one step: an in-process verdict with three solo crashes goes to isolated, not refused", () => {
    expect(adjust("in-process", CLEAN, rec({ crashesSolo: 3, lastCrash: NOW - DAY })).adjusted).toBe("isolated");
  });

  it("a crashed isolated plugin is not promoted", () => {
    expect(adjust("isolated", COST_ONLY, rec({ crashesSolo: 1, lastCrash: NOW - 100 * DAY })).adjusted).toBe("isolated");
  });
});

describe("promoting", () => {
  it("promotes isolated to in-process for a steady plugin whose only reason is a cost reason, with history.steady", () => {
    expect(adjust("isolated", COST_ONLY, rec())).toEqual({ measured: "isolated", adjusted: "in-process", move: "promote", reason: "history.steady" });
  });

  it("needs 360 windows alone: 359 stays", () => {
    expect(adjust("isolated", COST_ONLY, rec({ windowsSolo: HISTORY_POLICY.steadyWindowsSolo })).adjusted).toBe("in-process");
    expect(adjust("isolated", COST_ONLY, rec({ windowsSolo: HISTORY_POLICY.steadyWindowsSolo - 1 }))).toMatchObject({ adjusted: "isolated", reason: "history.no-change" });
  });

  it("needs cpu_p95_solo under the host's budget, which is the host's ceiling in percent", () => {
    expect(adjust("isolated", COST_ONLY, rec({ cpuP95Solo: 4.99 })).adjusted).toBe("in-process");
    expect(adjust("isolated", COST_ONLY, rec({ cpuP95Solo: 5 })).adjusted).toBe("isolated");
    // jalv's ceiling is a quarter of a core
    expect(adjust("isolated", COST_ONLY, rec({ cpuP95Solo: 24 }), JALV_PROFILE).adjusted).toBe("in-process");
    expect(adjust("isolated", COST_ONLY, rec({ cpuP95Solo: 25 }), JALV_PROFILE).adjusted).toBe("isolated");
  });

  it("needs no crash at any age and no restart", () => {
    expect(adjust("isolated", COST_ONLY, rec({ crashesSolo: 1, lastCrash: NOW - 400 * DAY })).adjusted).toBe("isolated");
    expect(adjust("isolated", COST_ONLY, rec({ crashesGrouped: 1, lastCrashGrouped: NOW - 400 * DAY })).adjusted).toBe("isolated");
    expect(adjust("isolated", COST_ONLY, rec({ restartsGrouped: 1 })).adjusted).toBe("isolated");
  });

  it("does not promote a plugin that raises xruns when grouped", () => {
    expect(adjust("isolated", COST_ONLY, rec({ windowsGrouped: 100, xrunWindowsGrouped: 40 })).adjusted).toBe("isolated");
  });
});

describe("what history never lifts", () => {
  const steadyRec = rec();

  it("a real-time-safety verdict, even beside a cost reason", () => {
    const r = adjust("isolated", [{ code: "hosting.rt-safety.violations-in-run", rating: "conditional" }], steadyRec);
    expect(r).toEqual({ measured: "isolated", adjusted: "isolated", move: "none", reason: "history.not-liftable", blockedBy: ["hosting.rt-safety.violations-in-run"] });
    const mixed = adjust("isolated", [...COST_ONLY, { code: "hosting.rt-safety.violations-in-run", rating: "conditional" }], steadyRec);
    expect(mixed).toMatchObject({ adjusted: "isolated", reason: "history.not-liftable", blockedBy: ["hosting.rt-safety.violations-in-run"] });
  });

  it("a missing feature", () => {
    const r = adjust("isolated", [{ code: "hosting.features.missing", rating: "conditional" }], steadyRec);
    expect(r).toMatchObject({ adjusted: "isolated", move: "none", reason: "history.not-liftable", blockedBy: ["hosting.features.missing"] });
  });

  it("a stability reason, which is where a crash in the prober is read", () => {
    const r = adjust("isolated", [{ code: "hosting.stability.crashed-attributed-plugin", rating: "conditional" }], steadyRec);
    expect(r).toMatchObject({ adjusted: "isolated", reason: "history.not-liftable" });
  });

  it("an unknown verdict, which has no pin verdict to lift", () => {
    expect(adjust(undefined, [{ code: "hosting.cost.unmeasured-at-rate-and-quantum", rating: "unknown" }], steadyRec)).toEqual({
      measured: null,
      adjusted: null,
      move: "none",
      reason: "history.not-liftable",
      blockedBy: ["unknown"],
    });
  });

  it("a refused verdict, even one decided by a cost reason", () => {
    expect(adjust("refused", [{ code: "hosting.cost.above-ceiling", rating: "unsuitable" }], steadyRec)).toEqual({
      measured: "refused",
      adjusted: "refused",
      move: "none",
      reason: "history.not-liftable",
      blockedBy: ["refused"],
    });
  });

  it("an isolated verdict that no reason explains", () => {
    expect(adjust("isolated", [], steadyRec)).toMatchObject({ adjusted: "isolated", reason: "history.not-liftable", blockedBy: ["no-deciding-reason"] });
  });

  it("a non-steady history says no-change, not not-liftable, for a verdict it could not lift anyway", () => {
    expect(adjust("refused", [], rec({ windowsSolo: 10 })).reason).toBe("history.no-change");
  });
});

describe("no history", () => {
  it("keeps every measured verdict and says there was no record", () => {
    for (const m of ["in-process", "isolated", "refused", undefined] as const) {
      const r = adjust(m, COST_ONLY, undefined);
      expect(r).toEqual({ measured: m ?? null, adjusted: m ?? null, move: "none", reason: HISTORY_REASON.noRecord });
    }
  });
});
