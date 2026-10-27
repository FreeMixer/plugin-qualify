// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The running-history file plugin-hostd writes and `plugin-qualify adjust --history` reads (plugin-hostd's `data/history.json`
 * and `src/history.c`): a header line, then one line per plugin binary and host class,
 *
 *     history <uri> <binary digest> <host class> key=value ...
 *
 * The reader keeps the daemon's rules for what it reads: the header must be the one it knows, a line outside the grammar
 * is not read (and counted, so the caller can say so), a second line of one plugin binary on one host class is not read,
 * a value is a whole number or a decimal and never negative. It differs in one place on purpose: a key it does not know
 * is not a reason to skip the line, it is kept on the record (`unknownKeys`) and the known keys are read, so a daemon
 * that grows a key inside history/1 does not blind the qualifier. Nothing here writes the file; only the daemon does.
 */

/** The header line of the format this reader knows, plugin-hostd's `PHD_HISTORY_HEADER`. */
export const HISTORY_HEADER = "# plugin-hostd history/1";

/** The verb a record line starts with, plugin-hostd's `PHD_HISTORY_RECORD`. */
export const HISTORY_RECORD = "history";

/** How a key's value is written: a whole number (`count`, `time`) or a decimal (`decimal`). */
type KeyKind = "count" | "time" | "decimal";

/**
 * PLUGIN_HOSTD_HISTORY_KEYS in the daemon's order, each with the field it fills and how its value is written. The words
 * are plugin-hostd's (`data/history.json`); `history-file.test.ts` holds this table to them.
 */
const KEYS: readonly { readonly word: string; readonly field: keyof HistoryCounters; readonly kind: KeyKind }[] = [
  { word: "first", field: "first", kind: "time" },
  { word: "last", field: "last", kind: "time" },
  { word: "windows_solo", field: "windowsSolo", kind: "count" },
  { word: "windows_grouped", field: "windowsGrouped", kind: "count" },
  { word: "cpu_p95_solo", field: "cpuP95Solo", kind: "decimal" },
  { word: "cpu_max_solo", field: "cpuMaxSolo", kind: "decimal" },
  { word: "pss_mb_solo", field: "pssMbSolo", kind: "decimal" },
  { word: "xrun_windows_solo", field: "xrunWindowsSolo", kind: "count" },
  { word: "xrun_windows_grouped", field: "xrunWindowsGrouped", kind: "count" },
  { word: "crashes_solo", field: "crashesSolo", kind: "count" },
  { word: "crashes_grouped", field: "crashesGrouped", kind: "count" },
  { word: "restarts_grouped", field: "restartsGrouped", kind: "count" },
  { word: "quarantines", field: "quarantines", kind: "count" },
  { word: "last_crash", field: "lastCrash", kind: "time" },
  { word: "last_crash_grouped", field: "lastCrashGrouped", kind: "time" },
];

/** The words of the keys this reader knows, in the daemon's order. */
export const HISTORY_KEY_WORDS: readonly string[] = KEYS.map((k) => k.word);

/** The figures of one record. A key the line did not carry reads as 0, as the daemon's record starts at 0. */
export interface HistoryCounters {
  /** UTC seconds of the first and the last window. */
  readonly first: number;
  readonly last: number;
  readonly windowsSolo: number;
  readonly windowsGrouped: number;
  /** Percent of one core. */
  readonly cpuP95Solo: number;
  readonly cpuMaxSolo: number;
  /** MiB. */
  readonly pssMbSolo: number;
  readonly xrunWindowsSolo: number;
  readonly xrunWindowsGrouped: number;
  readonly crashesSolo: number;
  readonly crashesGrouped: number;
  readonly restartsGrouped: number;
  readonly quarantines: number;
  /** UTC seconds of the last crash the plugin was blamed for alone, and in a group. */
  readonly lastCrash: number;
  readonly lastCrashGrouped: number;
}

/** One line of the history: a plugin binary on a host class. */
export interface HistoryRecord extends HistoryCounters {
  /** plugin-hostd's uri: `clap:<path of the .clap>#<id>`, or an LV2 plugin's own URI. */
  readonly uri: string;
  /** The SHA-256 of the first file of the plugin's pin, 64 lowercase hex digits. */
  readonly digest: string;
  /** The machine class the daemon recorded under, `arch/cores/clock`. */
  readonly hostClass: string;
  /** The keys of the line this reader does not know, as written: kept, never read. */
  readonly unknownKeys: Readonly<Record<string, string>>;
}

export type HistoryRead =
  | {
      readonly ok: true;
      readonly records: readonly HistoryRecord[];
      /** The lines that were not read, each with the line number and why: outside the grammar, or a second line of one binary and class. */
      readonly ignored: readonly { readonly line: number; readonly problem: string }[];
    }
  | { readonly ok: false; readonly problem: string };

const HEX = /^[0-9a-f]{64}$/;
const WHOLE = /^[0-9]+$/;
const DECIMAL = /^([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/;

function number(text: string, kind: KeyKind): number | undefined {
  if (kind === "decimal") {
    if (!DECIMAL.test(text)) return undefined;
    const v = Number(text);
    return Number.isFinite(v) ? v : undefined;
  }
  if (!WHOLE.test(text)) return undefined;
  const v = Number(text);
  return Number.isSafeInteger(v) ? v : undefined;
}

/** One record line, or the reason it is outside the grammar. */
function parseRecord(words: readonly string[]): HistoryRecord | string {
  if (words.length < 4 || words[0] !== HISTORY_RECORD) return `not a ${HISTORY_RECORD} line with a uri, a digest and a host class`;
  const [, uri, digest, hostClass] = words as [string, string, string, string];
  if (!HEX.test(digest)) return `${digest}: not a digest of 64 lowercase hex digits`;
  const values: Record<string, number> = {};
  const unknownKeys: Record<string, string> = {};
  const seen = new Set<string>();
  for (const word of words.slice(4)) {
    const eq = word.indexOf("=");
    if (eq < 0) return `${word}: not key=value`;
    const key = word.slice(0, eq);
    const text = word.slice(eq + 1);
    if (seen.has(key)) return `${key}: given twice`;
    seen.add(key);
    const known = KEYS.find((k) => k.word === key);
    if (known === undefined) {
      unknownKeys[key] = text;
      continue;
    }
    const v = number(text, known.kind);
    if (v === undefined) return `${key}=${text}: not ${known.kind === "decimal" ? "a decimal" : "a whole number"}, or negative`;
    values[known.field] = v;
  }
  const counters = Object.fromEntries(KEYS.map((k) => [k.field, values[k.field] ?? 0])) as unknown as HistoryCounters;
  return { uri, digest, hostClass, ...counters, unknownKeys };
}

/**
 * Read the text of a history file. A file whose first line (blank lines apart) is not the header is refused as a whole,
 * as the daemon blocks it: a version this reader does not know is not read by guessing. Comment lines and blank lines
 * after the header are skipped.
 */
export function readHistory(text: string): HistoryRead {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const first = lines.findIndex((l) => l.trim() !== "");
  if (first < 0) return { ok: true, records: [], ignored: [] };
  if (lines[first] !== HISTORY_HEADER) {
    return {
      ok: false,
      problem: lines[first]!.startsWith("# plugin-hostd history/")
        ? `${JSON.stringify(lines[first])} is a version this reader does not know (it reads ${HISTORY_HEADER})`
        : "not a history file: it does not begin with " + HISTORY_HEADER,
    };
  }
  const records: HistoryRecord[] = [];
  const ignored: { line: number; problem: string }[] = [];
  for (let i = first + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "" || line.startsWith("#")) continue;
    const parsed = parseRecord(line.split(/[ \t]+/).filter((w) => w !== ""));
    if (typeof parsed === "string") {
      ignored.push({ line: i + 1, problem: parsed });
    } else if (records.some((r) => r.uri === parsed.uri && r.digest === parsed.digest && r.hostClass === parsed.hostClass)) {
      ignored.push({ line: i + 1, problem: "a second line of one plugin binary on one host class" });
    } else records.push(parsed);
  }
  return { ok: true, records, ignored };
}

/** The record of one plugin binary on one host class, or `undefined`. */
export function findHistory(records: readonly HistoryRecord[], uri: string, digest: string, hostClass: string): HistoryRecord | undefined {
  return records.find((r) => r.uri === uri && r.digest === digest && r.hostClass === hostClass);
}

/** The host classes a history holds a record for, sorted. */
export function historyClasses(records: readonly HistoryRecord[]): string[] {
  return [...new Set(records.map((r) => r.hostClass))].sort();
}
