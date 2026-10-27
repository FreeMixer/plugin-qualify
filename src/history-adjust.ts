// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * What the running history may do to a measured verdict (the grouping-planner design note, How plugin-qualify uses it).
 * A pure function of the measured verdict, the reasons behind it, one history record and the clock: it moves a pin
 * verdict one step toward safer, or promotes `isolated` to `in-process` for a steady plugin whose only fault was a cost
 * reason, or leaves the measured verdict alone. It never changes the measurement, and it never lifts a verdict that is a
 * fact about the plugin (real-time safety, a missing feature, a crash in the prober, an `unknown`), nor a `refused`.
 *
 * The thresholds are the note's starting values, declared once in {@link HISTORY_POLICY}; the benchmark tunes them.
 * The summaries (`crashed`, `raises-xruns`) are plugin-hostd's `history_get` rules, read here from the file because
 * plugin-qualify runs without a daemon.
 */
import type { HostProfile } from "./host-profiles.js";
import type { HistoryRecord } from "./history-file.js";
import { PIN_VERDICTS, type PinVerdict } from "./pins-file.js";

export const HISTORY_POLICY = {
  /** plugin-hostd's PHD_HISTORY_KEEP_DAYS: a crash older than this is not read. */
  keepDays: 30,
  /** plugin-hostd's PHD_HISTORY_MIN_WINDOWS: grouped windows before an xrun share is read. */
  minWindows: 30,
  /** plugin-hostd's PHD_HISTORY_XRUN_MARGIN_PCT: percentage points the grouped xrun share may exceed the solo one by. */
  xrunMarginPct: 5,
  /** Solo crashes, on this binary and class within `keepDays`, that demote `isolated` to `refused`. */
  crashedAloneCount: 3,
  /** Windows run alone before a promotion is read: 360 windows of 60 s are six hours. */
  steadyWindowsSolo: 360,
} as const;

const SECONDS_PER_DAY = 86_400;

/** The codes of the second verdict. Codes, never prose. */
export const HISTORY_REASON = {
  crashed: "history.crashed",
  xrunsGrouped: "history.xruns-grouped",
  crashedAlone: "history.crashed-alone",
  steady: "history.steady",
  /** History has no line for this plugin binary on this host class: the measured verdict stands. */
  noRecord: "history.no-record",
  /** The record was read and no rule moves this verdict. */
  noChange: "history.no-change",
  /** The record would promote, but the measured verdict is a fact about the plugin and history does not lift it. */
  notLiftable: "history.not-liftable",
} as const;
export type HistoryReasonCode = (typeof HISTORY_REASON)[keyof typeof HISTORY_REASON];

export type HistoryMove = "demote" | "promote" | "none";

/** What the daemon's `history_get` summary says of a record at `now` (UTC seconds). */
export interface HistorySummary {
  /** A crash was counted and the latest one is within `keepDays`. */
  readonly crashed: boolean;
  /** The grouped windows' share of xruns exceeds the solo share by the margin, over at least `minWindows` grouped windows. */
  readonly raisesXruns: boolean;
}

export function summariseHistory(r: HistoryRecord, now: number): HistorySummary {
  const last = Math.max(r.lastCrash, r.lastCrashGrouped);
  const crashed = r.crashesSolo + r.crashesGrouped > 0 && now - last <= HISTORY_POLICY.keepDays * SECONDS_PER_DAY;
  const wg = r.windowsGrouped;
  const xg = r.xrunWindowsGrouped;
  const ws = r.windowsSolo;
  const xs = r.xrunWindowsSolo;
  const m = HISTORY_POLICY.xrunMarginPct;
  // xg/wg > xs/ws + m/100, cross-multiplied so no division is rounded
  const raisesXruns = wg < HISTORY_POLICY.minWindows ? false : ws === 0 ? 100 * xg > m * wg : 100 * xg * ws > 100 * xs * wg + m * wg * ws;
  return { crashed, raisesXruns };
}

/** One reason of the measured verdict, as the record holds it. */
export interface MeasuredReason {
  readonly code: string;
  /** The rating the reason contributed to the verdict. */
  readonly rating: string;
}

export interface AdjustInput {
  /** The measured pin verdict of the host, or `undefined` for an `unknown` rating (no verdict word). */
  readonly measured: PinVerdict | undefined;
  /** The reasons of the measured verdict, all of them. */
  readonly reasons: readonly MeasuredReason[];
  /** The record of this plugin binary on the host class, or `undefined` when the history has none. */
  readonly record: HistoryRecord | undefined;
  /** The host the verdict is for; its cost ceiling is the budget a promotion is read against. */
  readonly profile: HostProfile;
  /** UTC seconds. */
  readonly now: number;
}

export interface Adjustment {
  readonly measured: PinVerdict | null;
  readonly adjusted: PinVerdict | null;
  readonly move: HistoryMove;
  readonly reason: HistoryReasonCode;
  /** For `history.not-liftable`: why the measured verdict is not history's to lift: `refused`, `unknown`, or the codes of the reasons that are not cost reasons. */
  readonly blockedBy?: readonly string[];
}

const COST_PREFIX = "hosting.cost.";

/**
 * Why the measured verdict cannot be promoted by history, or an empty list when it can: the verdict must be `isolated`
 * (conditional), and every reason that is not `suitable` must be a cost reason. A reason of any other dimension
 * (real-time safety, features, stability, latency, topology) is a measurement of the plugin, not of this machine.
 */
function blockers(measured: Exclude<PinVerdict, "in-process"> | undefined, reasons: readonly MeasuredReason[]): string[] {
  if (measured === undefined) return ["unknown"];
  if (measured === "refused") return ["refused"];
  const deciding = reasons.filter((r) => r.rating !== "suitable");
  const notCost = deciding.filter((r) => !r.code.startsWith(COST_PREFIX)).map((r) => r.code);
  if (notCost.length > 0) return notCost;
  // an isolated verdict that no reason explains is not one history can vouch for
  return deciding.length === 0 ? ["no-deciding-reason"] : [];
}

function stay(measured: PinVerdict | undefined, reason: HistoryReasonCode, blockedBy?: readonly string[]): Adjustment {
  return { measured: measured ?? null, adjusted: measured ?? null, move: "none", reason, ...(blockedBy === undefined ? {} : { blockedBy }) };
}

function move(measured: PinVerdict, adjusted: PinVerdict, reason: HistoryReasonCode): Adjustment {
  const demote = PIN_VERDICTS.indexOf(adjusted) > PIN_VERDICTS.indexOf(measured);
  return { measured, adjusted, move: demote ? "demote" : "promote", reason };
}

/** Whether the record shows a plugin that has run alone long enough, without a crash or a restart, under the host's cost budget. */
function steady(r: HistoryRecord, profile: HostProfile, summary: HistorySummary): boolean {
  const budgetPct = profile.cost.coreFractionCeiling * 100;
  return (
    r.windowsSolo >= HISTORY_POLICY.steadyWindowsSolo &&
    r.crashesSolo + r.crashesGrouped === 0 &&
    r.restartsGrouped === 0 &&
    !summary.raisesXruns &&
    r.cpuP95Solo < budgetPct
  );
}

/** The second verdict beside the measured one. Demotions are read first and promotions last; a demotion is one step. */
export function adjustVerdict(input: AdjustInput): Adjustment {
  const { measured, reasons, record, profile, now } = input;
  if (record === undefined) return stay(measured, HISTORY_REASON.noRecord);
  const summary = summariseHistory(record, now);
  if (measured === "in-process") {
    if (summary.crashed) return move(measured, "isolated", HISTORY_REASON.crashed);
    if (summary.raisesXruns) return move(measured, "isolated", HISTORY_REASON.xrunsGrouped);
    return stay(measured, HISTORY_REASON.noChange);
  }
  if (measured === "isolated") {
    const aloneCrashed = record.crashesSolo >= HISTORY_POLICY.crashedAloneCount && now - record.lastCrash <= HISTORY_POLICY.keepDays * SECONDS_PER_DAY;
    if (aloneCrashed) return move(measured, "refused", HISTORY_REASON.crashedAlone);
  }
  if (!steady(record, profile, summary)) return stay(measured, HISTORY_REASON.noChange);
  const blocked = blockers(measured, reasons);
  if (blocked.length > 0) return stay(measured, HISTORY_REASON.notLiftable, blocked);
  return move("isolated", "in-process", HISTORY_REASON.steady);
}
