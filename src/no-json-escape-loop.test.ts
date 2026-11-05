// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The JSON string literals of the native tools are spelled by omx-contract's one writer,
 * `<omxcontract/omx_json_write.h>` (omx_json_escape_byte, omx_json_write_string, omx_json_string; RFC 8259:
 * a quote and a backslash backslashed, a byte below 0x20 as \b \t \n \f \r or \u00XX, everything else as it
 * is). No file under `native/` carries an escape loop of its own: a `\u%04x` format, a \u00 escape written
 * byte by byte or as a literal, the writer's switch copied (a `case '"':` that writes a backslash), or a copy
 * of the writer's functions under their names. Five such loops once lived here, one per tool, and drifted
 * (clap-qualify escaped 0x7f, the others did not).
 *
 * A text scan, so the negative is preceded by a positive control: each shape of loop planted in a scratch
 * tree must be red, and a reader's switch (which writes the byte an escape stands for) must not be.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const NATIVE = join(dirname(fileURLToPath(import.meta.url)), "..", "native");
const HEADER = "omxcontract/omx_json_write.h";

/** What only a JSON escape loop of its own holds: the pattern and the name of what it spells. */
const MARKS: [RegExp, string][] = [
  [/\\\\u%0?\d*[xX]/, "a \\u%04x format: a JSON escape spelled with printf"],
  [/"\\\\u00/, "a \\u00 literal: a JSON escape typed by hand"],
  [/'\\\\'[^\n]{0,80}'u'/, "a \\u escape written byte by byte"],
  [/case\s+'"'\s*:[^\n]{0,80}[=(]\s*'\\\\'/, "the writer's switch copied (case '\"' writing a backslash)"],
  [/\bomx_json_(escape_byte|write_string|string)\s*\([^;]*\)\s*\{/, "a copy of the writer's functions"],
];

/** `<file>:<line>: <what>` for every mark in the sources given as `{ file: text }`. */
function loops(src: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [file, text] of Object.entries(src)) {
    if (file.endsWith(HEADER)) continue;
    for (const [rx, what] of MARKS) {
      const m = rx.exec(text);
      if (m) out.push(`${file}:${text.slice(0, m.index).split("\n").length}: ${what}`);
    }
  }
  return out;
}

/** every C file and header under native/ (the fixtures' plugins among them), as `{ file: text }` */
function sources(dir = NATIVE, rel = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name !== "deps" && entry.name !== "build") Object.assign(out, sources(path, name));
    } else if (/\.[ch]$/.test(entry.name)) out[name] = readFileSync(path, "utf8");
  }
  return out;
}

/** the shapes that must be red: the loops the tools carried, and the copies that could come back */
const PLANTS: [string, string, string][] = [
  [
    "old-json-str.c",
    "the fprintf loop lv2-measure.c carried",
    'static void json_str(FILE *out, const char *s) {\n  fputc(\'"\', out);\n  for (const char *p = s; p && *p; p++) {\n' +
      '    if (*p == \'"\' || *p == \'\\\\\') fprintf(out, "\\\\%c", *p);\n    else if ((unsigned char)*p < 0x20) fprintf(out, "\\\\u%04x", *p);\n' +
      "    else fputc(*p, out);\n  }\n  fputc('\"', out);\n}\n",
  ],
  [
    "old-put-string.c",
    "the loop clap-qualify.c carried, 0x7f escaped",
    'static void put_string(const unsigned char *p) {\n  while (*p) {\n    if (*p < 0x20 || *p == 0x7F) fprintf(g_out, "\\\\u%04X", *p);\n' +
      '    else if (*p == \'"\' || *p == \'\\\\\') fprintf(g_out, "\\\\%c", *p);\n    else fputc_out(*p);\n    p++;\n  }\n}\n',
  ],
  [
    "by-byte.c",
    "a \\u escape written byte by byte",
    "static size_t esc(unsigned char c, char *out) {\n  out[0] = '\\\\'; out[1] = 'u'; out[2] = '0'; out[3] = '0';\n  return 6;\n}\n",
  ],
  ["literal.h", "a \\u00 literal", 'static inline void ctl(FILE *f, unsigned c) { fputs("\\\\u00", f); fprintf(f, "%02x", c); }\n'],
  [
    "switch-copy.c",
    "the writer's switch copied",
    "static size_t esc(unsigned char c, char *out) {\n  switch (c) {\n  case '\"': out[0] = '\\\\'; out[1] = '\"'; return 2;\n" +
      "  case '\\\\': out[0] = '\\\\'; out[1] = '\\\\'; return 2;\n  default: out[0] = (char)c; return 1;\n  }\n}\n",
  ],
  [
    "writer-copy.h",
    "a copy of the writer's functions",
    "static inline int omx_json_write_string(FILE *f, const char *s) {\n  return fputs(s, f);\n}\n",
  ],
];

/** a reader's switch: it writes the byte an escape stands for, and spells no JSON */
const NOT_A_MARK =
  "static const char *read_string(const char *p, out_t *o) {\n  switch (*p) {\n  case '\"': case '\\\\': case '/': put(o, p, 1); break;\n" +
  '  case \'n\': put(o, "\\n", 1); break;\n  }\n  return p;\n}\n';

describe(`native JSON string literals are spelled by <${HEADER}>`, () => {
  for (const [file, what, text] of PLANTS)
    it(`positive control: ${what}, planted as ${file}, is red`, () => {
      expect(loops({ [file]: text }).map((l) => l.split(":")[0])).toEqual([file]);
    });

  it("a reader's switch is not a mark", () => {
    expect(loops({ "reader.c": NOT_A_MARK })).toEqual([]);
  });

  it("the writer's own header is not a mark", () => {
    expect(loops({ [`deps/omx-contract/include/${HEADER}`]: PLANTS[5]![2] })).toEqual([]);
  });

  it("native/**/*.{c,h} carries no JSON escape loop of its own", () => {
    const src = sources();
    expect(Object.keys(src).length).toBeGreaterThan(10);
    expect(loops(src)).toEqual([]);
  });
});
