// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The pins file `plugin-qualify --pins <file>` writes and plugin-hostd loads (`pin_file` in its settings, or its
 * pin store's import): one line per qualified plugin, the SAME line as hostd's `pin_set` verb, with the
 * qualification verdict as a last word.
 *
 *     pin_set <uri> <path>=<sha256>[,<path>=<sha256>...] <scheme>:<sha256> [verdict=<word>]
 *
 * The digests and the layout are the prober's, raw (`IntegrityMeasurement`); nothing here computes a hash. A plugin
 * whose run took no whole pin has no line: a pins file never holds a partial pin. The grammar is plugin-hostd's
 * (`include/plugin-hostd/protocol.h`, PHD_PIN_*); `parsePinLine` reads a line back with the daemon's rules, so a
 * writer that drifts from them is a red test and not a refused add.
 */
import { resolve } from "node:path";

import type { RtSafetyDocument } from "./clap-qualify.js";
import type { IntegrityMeasurement, MeasuredPlugin } from "./measurement/format.js";
import type { QualifyVerdict } from "./qualify-cli.js";
import type { SuitabilityRating } from "./rating.js";

/** The verb the line starts with in a pins file, hostd's `PHD_VERB_PIN_SET`. */
export const PIN_VERB = "pin_set";

/** The key of the verdict word, hostd's `PHD_PIN_VERDICT_KEY`. */
export const PIN_VERDICT_KEY = "verdict=";

/** The verdict words hostd knows (`PHD_PIN_VERDICTS`). */
export const PIN_VERDICTS = ["in-process", "isolated", "refused"] as const;
export type PinVerdict = (typeof PIN_VERDICTS)[number];

/**
 * What a rating says about where the plugin may run, in hostd's words. `suitable` is qualified for a worker that other
 * plugins share. `conditional` loads and is isolated. `unsuitable` is measured to fail and is `refused`. `unknown` is no
 * opinion: no verdict word, and hostd treats the plugin as not qualified.
 */
export function pinVerdictOf(rating: SuitabilityRating): PinVerdict | undefined {
  switch (rating) {
    case "suitable":
      return "in-process";
    case "conditional":
      return "isolated";
    case "unsuitable":
      return "refused";
    case "unknown":
      return undefined;
  }
}

/** One pin: what hostd's `pin_set` takes, and the verdict of the run that took it. */
export interface PinEntry {
  /** hostd's uri: `clap:<path of the .clap>#<id>`, or an LV2 plugin's own URI. */
  readonly uri: string;
  readonly integrity: IntegrityMeasurement;
  readonly verdict?: PinVerdict;
}

/** The line of one pin, or `undefined` when the integrity block is not a whole pin. */
export function pinLine(entry: PinEntry): string | undefined {
  const { files, layout } = entry.integrity;
  if (files === undefined || files.length === 0 || layout === undefined) return undefined;
  const list = files.map((f) => `${f.path}=${f.sha256}`).join(",");
  const verdict = entry.verdict === undefined ? "" : ` ${PIN_VERDICT_KEY}${entry.verdict}`;
  return `${PIN_VERB} ${entry.uri} ${list} ${layout.scheme}:${layout.sha256}${verdict}`;
}

/** hostd's uri of a CLAP plugin the prober loaded: its file as it was handed, made absolute, and its id. */
export function clapPinUri(binaryPath: string, pluginUri: string): string {
  const id = pluginUri.startsWith("urn:clap:") ? pluginUri.slice("urn:clap:".length) : pluginUri;
  return `clap:${resolve(binaryPath)}#${id}`;
}

/** What went into a pins file and what did not. */
export interface PinsFile {
  readonly text: string;
  /** The uris written. */
  readonly written: readonly string[];
  /** The uris of plugins that took no whole pin: they have no line. */
  readonly skipped: readonly string[];
}

/**
 * The file: a comment that says where it came from, then one line per plugin, sorted by uri. A uri given twice keeps
 * the entry whose verdict is the worse one (`refused` over `isolated` over `in-process`, no word over all), so a
 * plugin found twice is never pinned more kindly than its worst measurement.
 */
export function pinsFile(entries: readonly PinEntry[]): PinsFile {
  const byUri = new Map<string, string>();
  const verdictOf = new Map<string, PinVerdict | undefined>();
  const skipped: string[] = [];
  const rank = (v: PinVerdict | undefined): number => (v === undefined ? 4 : { "in-process": 1, isolated: 2, refused: 3 }[v]);
  for (const entry of entries) {
    const line = pinLine(entry);
    if (line === undefined) {
      skipped.push(entry.uri);
      continue;
    }
    if (byUri.has(entry.uri) && rank(verdictOf.get(entry.uri)) >= rank(entry.verdict)) continue;
    byUri.set(entry.uri, line);
    verdictOf.set(entry.uri, entry.verdict);
  }
  const uris = [...byUri.keys()].sort();
  const text = [
    "# written by plugin-qualify --pins; plugin-hostd reads it with pin_file",
    ...uris.map((u) => byUri.get(u)!),
    "",
  ].join("\n");
  return { text, written: uris, skipped: skipped.filter((u) => !byUri.has(u)) };
}

/**
 * The entries of a CLAP pass for one host: each document of that host's profile with its pin and the verdict its
 * rating says. The documents of other profiles are ignored; a pins file is for one host.
 */
export function clapPinEntries(documents: readonly RtSafetyDocument[], host: string): PinEntry[] {
  return documents
    .filter((d) => d.console === host)
    .map((d) => {
      const verdict = pinVerdictOf(d.verdict.rating);
      return {
        uri: clapPinUri(d.plugin.binary.path, d.plugin.uri),
        integrity: d.measured.integrity,
        ...(verdict === undefined ? {} : { verdict }),
      };
    });
}

/**
 * The entries of an LV2 run: each measured plugin with a pin and the verdict row of that host. A plugin with no verdict
 * row for the host is pinned without a verdict word.
 */
export function measuredPinEntries(
  plugins: readonly MeasuredPlugin[],
  verdicts: readonly QualifyVerdict[],
  host: string,
): PinEntry[] {
  return plugins.flatMap((p) => {
    if (p.integrity === undefined) return [];
    const row = verdicts.find((v) => v.uri === p.uri && v.host === host);
    const verdict = row === undefined || !row.measured ? undefined : pinVerdictOf(row.rating);
    return [{ uri: p.uri, integrity: p.integrity, ...(verdict === undefined ? {} : { verdict }) }];
  });
}

/** A line read back with hostd's rules. */
export interface ParsedPin {
  readonly uri: string;
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
  readonly layout: { readonly scheme: string; readonly sha256: string };
  readonly verdict?: PinVerdict;
}

const HEX = /^[0-9a-f]{64}$/;

/**
 * hostd's grammar for a pin line, the verb optional; `undefined` for a blank or comment line, and a thrown Error for a
 * line the daemon would refuse (a path holding a separator, a path that climbs out of the bundle, a digest that is not
 * 64 lowercase hex digits, a layout without a scheme, a verdict outside the vocabulary, a path named twice).
 */
export function parsePinLine(line: string): ParsedPin | undefined {
  const words = line.trim().split(/\s+/).filter((w) => w !== "");
  if (words.length === 0 || words[0]!.startsWith("#")) return undefined;
  if (words[0] === PIN_VERB) words.shift();
  if (words.length !== 3 && words.length !== 4) throw new Error(`a pin line has 3 or 4 words, not ${words.length}`);
  const [uri, list, layout, verdictWord] = words as [string, string, string, string | undefined];
  const files = list.split(",").map((item) => {
    const eq = item.lastIndexOf("=");
    if (eq < 0) throw new Error(`${item}: no =`);
    const path = item.slice(0, eq);
    const sha256 = item.slice(eq + 1);
    if (path === "" || path.startsWith("/") || path.split("/").some((part) => part === "" || part === "..")) {
      throw new Error(`${path}: not a path inside the bundle`);
    }
    if (!HEX.test(sha256)) throw new Error(`${path}: not a sha256`);
    return { path, sha256 };
  });
  if (new Set(files.map((f) => f.path)).size !== files.length) throw new Error("a path is named twice");
  const colon = layout.lastIndexOf(":");
  if (colon <= 0 || !HEX.test(layout.slice(colon + 1))) throw new Error(`${layout}: not a layout pin`);
  let verdict: PinVerdict | undefined;
  if (verdictWord !== undefined) {
    const word = verdictWord.startsWith(PIN_VERDICT_KEY) ? verdictWord.slice(PIN_VERDICT_KEY.length) : "";
    if (!(PIN_VERDICTS as readonly string[]).includes(word)) throw new Error(`${verdictWord}: not a verdict`);
    verdict = word as PinVerdict;
  }
  return { uri, files, layout: { scheme: layout.slice(0, colon), sha256: layout.slice(colon + 1) }, ...(verdict === undefined ? {} : { verdict }) };
}
