// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The dB conversions of the native tools are omx-dsp's (`omx_lin_to_db_d` in `<omxdsp/omx_units.h>`):
 * a hand-written `log10(...)` or `pow(10, ...)` in `native/*.c` is a second copy of the library's
 * maths (#87). Each line left is named below with the reason it stays, and an entry whose line is
 * gone fails too, so the list never outlives what it excuses.
 *
 * A text scan, so the negative is preceded by a positive control that proves the pattern sees a hit.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const NATIVE = join(dirname(fileURLToPath(import.meta.url)), "..", "native");

/** A call of log10/log10f, or pow/powf with base 10. */
const DB_COPY = /\blog10f?\s*\(|\bpowf?\s*\(\s*10(?:\.0*)?f?\s*,/;

/** `<file>: <the line, trimmed>` -> why it stays. */
const ALLOWED: Record<string, string> = {
  "lv2-host-probe.c: const double hot = pow(10.0, HOT_EXCESS_DB / 20.0);":
    "dB to linear in double: omx-dsp has omx_db_to_lin in float only, which is not bit-identical; stays until a double twin exists (#87)",
};

function hits(src: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [file, text] of Object.entries(src))
    for (const line of text.split("\n")) {
      const code = line.replace(/\/\*.*?\*\/|\/\/.*$/g, "");
      if (DB_COPY.test(code)) out.push(`${file}: ${line.trim()}`);
    }
  return out;
}

const sources = (): Record<string, string> =>
  Object.fromEntries(
    readdirSync(NATIVE)
      .filter((n) => n.endsWith(".c"))
      .map((n) => [n, readFileSync(join(NATIVE, n), "utf8")]),
  );

describe("native dB conversions come from omx-dsp", () => {
  it("positive control: the pattern sees a hand-written log10 and pow(10, ...), not a comment", () => {
    expect(
      hits({
        "x.c": "  return 20.0 * log10(mag);\n  float g = powf(10.0f, db / 20.0f);\n  /* 20 * log10(x) */\n  double y = pow(2.0, 3.0);\n",
      }),
    ).toEqual(["x.c: return 20.0 * log10(mag);", "x.c: float g = powf(10.0f, db / 20.0f);"]);
  });

  it("native/*.c has no log10 or pow(10, ...) but the allowlisted lines", () => {
    const found = hits(sources());
    expect(found.filter((h) => !(h in ALLOWED))).toEqual([]);
  });

  it("every allowlisted line is still there, so the list excuses nothing gone", () => {
    const found = new Set(hits(sources()));
    expect(Object.keys(ALLOWED).filter((k) => !found.has(k))).toEqual([]);
  });
});
