// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Reading what the measuring host (`lv2_measure`) prints. Pure functions: the runner spawns,
 * these decide.
 */
import { isRecord } from "./measurement/guards.js";

/**
 * Where `text` stops being JSON, scanning ONE value from `i`; returns the index just past the
 * value, or `-(failing index) - 1` when it is not (negative means failure). A tolerant reader
 * has to know the exact offset of the first bad character, which `JSON.parse` does not report
 * portably.
 */
function scanValue(t: string, i: number): number {
  const ws = (k: number): number => {
    while (k < t.length && (t[k] === " " || t[k] === "\t" || t[k] === "\r" || t[k] === "\n")) k++;
    return k;
  };
  i = ws(i);
  const c = t[i];
  if (c === "{" || c === "[") {
    const close = c === "{" ? "}" : "]";
    let k = ws(i + 1);
    if (t[k] === close) return k + 1;
    for (;;) {
      if (c === "{") {
        if (t[k] !== '"') return -k - 1;
        const key = scanValue(t, k);
        if (key < 0) return key;
        k = ws(key);
        if (t[k] !== ":") return -k - 1;
        k++;
      }
      const v = scanValue(t, k);
      if (v < 0) return v;
      k = ws(v);
      if (t[k] === close) return k + 1;
      if (t[k] !== ",") return -k - 1;
      k = ws(k + 1);
    }
  }
  if (c === '"') {
    let k = i + 1;
    while (k < t.length) {
      if (t[k] === "\\") k += 2;
      else if (t[k] === '"') return k + 1;
      else if (t[k] === "\n") return -k - 1;
      else k++;
    }
    return -t.length - 1;
  }
  const lit = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(t.slice(i, i + 40));
  return lit === null ? -i - 1 : i + lit[0].length;
}

/**
 * The tool's one JSON record out of a stdout a plugin has also printed on (Guitarix:
 * `using block size: 0`, `convolver disabled`, written by the plugin into the middle of the
 * tool's own buffered line). The record is the last `{`-leading line that repairs to one valid
 * object: wherever the text stops being JSON, drop through the end of that line — the
 * plugin's banner — and join what follows. `undefined` when nothing repairs: the caller
 * reports a `parse-error`, never a death.
 */
export function extractJsonRecord(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.split("\n");
  let offset = 0;
  const starts: number[] = [];
  for (const line of lines) {
    if (line.startsWith("{")) starts.push(offset);
    offset += line.length + 1;
  }
  for (const start of starts.reverse()) {
    let text = stdout.slice(start);
    for (let repairs = 0; repairs < 64; repairs++) {
      const end = scanValue(text, 0);
      if (end >= 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(0, end));
          return isRecord(parsed) ? parsed : undefined;
        } catch {
          break;
        }
      }
      const bad = -end - 1;
      const eol = text.indexOf("\n", bad);
      if (eol < 0) break;
      text = text.slice(0, bad) + text.slice(eol + 1);
    }
  }
  return undefined;
}
