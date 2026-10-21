// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * omx-clap-core declares the hosting codes once (its two TypeScript modules); omx-contract
 * declares the measurement words once; plugin-qualify reads them. This file turns red on any
 * hosting.* code or measurement word plugin-qualify writes or reads that its owner lacks, and on
 * any word list here that is not the contract's.
 *
 * The hosting codes are found by scanning every tracked text file for `hosting.<...>` tokens.
 * The measurement words are found where they are written: the unmeasured reasons, the methods and
 * the scaling laws, each by the shape its writer uses (TypeScript, C and Python alike).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as contract from "@openmixer/omx-contract";
import { describe, expect, it } from "vitest";
import { HOSTING_CODE, clapCoreTsDirCandidates, isHostingTableName } from "./hosting-codes.js";
import {
  EXCLUSION_TERMS,
  HOST_ISOLATIONS,
  HOST_LATENCY_HANDLING,
  MEASUREMENT_DIMENSIONS,
  METHOD_TERMS,
  SCALING_NOTE_TERMS,
  SCALING_TERMS,
  UNMEASURED_TERMS,
  VERDICT_RATINGS,
  VOICE_BASES,
} from "./measurement/vocabulary.js";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "src/contract-vocabulary-conformance.test.ts";

/** omx-clap-core's two TypeScript modules, read independently of `hosting-codes.ts`'s own loader. */
const CLAP_CORE_TS_MODULES = ["omx-clap-core-vocabulary.js", "omx-clap-core-hosting.js"] as const;

function locateClapCoreTsDir(): string {
  const dir = clapCoreTsDirCandidates().find((d) => CLAP_CORE_TS_MODULES.every((m) => existsSync(join(d, m))));
  if (dir === undefined) throw new Error("omx-clap-core's TypeScript modules were not found for the conformance test");
  return dir;
}

/** Every code omx-clap-core declares, across both its modules' hosting tables. */
async function loadContractCodes(): Promise<ReadonlySet<string>> {
  const dir = locateClapCoreTsDir();
  const codes = new Set<string>();
  for (const name of CLAP_CORE_TS_MODULES) {
    const mod: Record<string, unknown> = await import(pathToFileURL(join(dir, name)).href);
    for (const [exportName, table] of Object.entries(mod)) {
      if (!isHostingTableName(exportName)) continue;
      for (const entry of Object.values(table as Record<string, { readonly code: string }>)) codes.add(entry.code);
    }
  }
  return codes;
}

const CONTRACT_CODES: ReadonlySet<string> = await loadContractCodes();

/** `hosting.<dimension>` for every dimension a contract code names: a family, not a code. */
const CONTRACT_FAMILIES: ReadonlySet<string> = new Set(
  [...CONTRACT_CODES].map((code) => code.split(".").slice(0, 2).join(".")),
);

/** `hosting.`-tokens that are not codes. */
const NOT_CODES: Readonly<Record<string, string>> = {
  "hosting.jsonl": "the hosting sweep's output file",
  "hosting.rating": "the verdict's rating field, written as a path",
};

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "deps", "__pycache__", ".pytest_cache"]);
const TEXT = /\.(ts|mts|mjs|js|json|py|c|h|md|txt|sh|spec|ya?ml)$|^(README|BUILDING|changelog|Containerfile|Makefile)/;

function trackedTextFiles(dir = PKG): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) out.push(...trackedTextFiles(path));
    else if (st.isFile() && TEXT.test(name) && st.size < 4_000_000) out.push(relative(PKG, path));
  }
  return out.sort();
}

/** The `hosting.<...>` tokens in `text`, with a regular expression's `\.` read as a dot. */
function hostingTokens(text: string): string[] {
  const plain = text.replaceAll("\\.", ".");
  return [...plain.matchAll(/(?<![\w.$-])hosting(?:\.[a-z0-9][a-z0-9-]*[a-z0-9])+/g)].map((m) => m[0]);
}

/** Each token in `files` the contract does not declare, as `file: token`. */
function undeclared(files: readonly string[], read: (rel: string) => string): string[] {
  const out: string[] = [];
  for (const rel of files) {
    if (rel === SELF) continue; // its tokens are the sabotages' fixtures
    for (const token of hostingTokens(read(rel))) {
      if (token in NOT_CODES) continue;
      if (!CONTRACT_CODES.has(token) && !CONTRACT_FAMILIES.has(token)) out.push(`${rel}: ${token}`);
    }
  }
  return [...new Set(out)];
}

const readPkg = (rel: string): string => readFileSync(join(PKG, rel), "utf8");

describe("every hosting.* code plugin-qualify names is omx-clap-core's", () => {
  const files = trackedTextFiles();

  it("the scan reaches the sources, the tools, the native measurers and the docs — positive control", () => {
    for (const rel of ["src/hosting-suitability.ts", "tools/benchmark.py", "README.md"]) expect(files).toContain(rel);
    expect(files.some((f) => f.startsWith("native/") && f.endsWith(".c"))).toBe(true);
    expect(hostingTokens(readPkg("README.md")).length).toBeGreaterThan(0);
  });

  it("no file names a hosting code the contract lacks", () => {
    expect(undeclared(files, readPkg)).toEqual([]);
  });

  it("an invented code is seen — sabotage control", () => {
    const sabotaged = (rel: string) =>
      rel === "src/hosting-suitability.ts" ? `${readPkg(rel)}\nconst x = "hosting.features.invented-here";` : readPkg(rel);
    expect(undeclared(files, sabotaged)).toContain("src/hosting-suitability.ts: hosting.features.invented-here");
  });

  it("a code the batch removed is seen if it leaks back in — sabotage control", () => {
    const sabotaged = (rel: string) =>
      rel === "README.md" ? `${readPkg(rel)}\n\`hosting.features.required-not-provided\`` : readPkg(rel);
    expect(undeclared(files, sabotaged)).toContain("README.md: hosting.features.required-not-provided");
  });

  it("a code inside a regular expression is read as the code", () => {
    expect(hostingTokens("/hosting\\.worker\\.nonconforming/")).toEqual(["hosting.worker.nonconforming"]);
  });

  it("every not-a-code token is still named somewhere: an exclusion nothing uses is a hole", () => {
    const all = new Set(files.flatMap((rel) => hostingTokens(readPkg(rel))));
    for (const token of Object.keys(NOT_CODES)) expect(all.has(token), token).toBe(true);
  });
});

describe("HOSTING_CODE is omx-clap-core's hosting tables, in full", () => {
  it("every code in HOSTING_CODE is the contract's, and every contract code is in it", () => {
    const ours = new Set<string>(Object.values(HOSTING_CODE));
    expect([...ours].sort()).toEqual([...CONTRACT_CODES].sort());
  });

  it("the fact a host refuses for a missing feature is hosting.features.missing", () => {
    const code: "hosting.features.missing" = HOSTING_CODE.featuresMissing;
    expect(code).toBe("hosting.features.missing");
  });
});

/** The words of a contract item, in its order. */
const words = (name: string): readonly string[] => (contract as unknown as Record<string, readonly string[]>)[`${name}_WORDS`]!;
const codes = (terms: readonly { readonly code: string }[]): string[] => terms.map((t) => t.code);

describe("every measurement word list is the contract's, in its order", () => {
  it.each([
    ["UNMEASURED_TERMS", () => codes(UNMEASURED_TERMS), words("MEASUREMENT_UNMEASURED_REASONS")],
    ["SCALING_TERMS", () => codes(SCALING_TERMS), words("MEASUREMENT_LATENCY_SCALING")],
    ["SCALING_NOTE_TERMS", () => codes(SCALING_NOTE_TERMS), words("MEASUREMENT_LATENCY_SCALING_NOTES")],
    ["EXCLUSION_TERMS", () => codes(EXCLUSION_TERMS), words("MEASUREMENT_LATENCY_EXCLUSIONS")],
    [
      "METHOD_TERMS",
      () => codes(METHOD_TERMS),
      [...words("MEASUREMENT_LATENCY_METHODS"), ...words("MEASUREMENT_COST_METHODS")],
    ],
    ["MEASUREMENT_DIMENSIONS", () => [...MEASUREMENT_DIMENSIONS], words("MEASUREMENT_DIMENSIONS")],
    ["VERDICT_RATINGS", () => [...VERDICT_RATINGS], words("MEASUREMENT_VERDICT_RATINGS")],
    ["VOICE_BASES", () => [...VOICE_BASES], words("MEASUREMENT_VOICE_BASES")],
    ["HOST_ISOLATIONS", () => [...HOST_ISOLATIONS], words("RESOURCE_HOST_ISOLATIONS")],
    ["HOST_LATENCY_HANDLING", () => [...HOST_LATENCY_HANDLING], words("RESOURCE_HOST_LATENCY_HANDLING")],
  ] as const)("%s", (_name, ours, theirs) => {
    expect(theirs.length).toBeGreaterThan(0);
    expect(ours()).toEqual([...theirs]);
  });

  it("each unmeasured reason's kind is the contract's group", () => {
    const groups = Object.fromEntries(
      Object.values(contract.MEASUREMENT_UNMEASURED_REASONS).map((r) => [r.word, r.group as string]),
    );
    for (const term of UNMEASURED_TERMS) expect(term.kind, term.code).toBe(groups[term.code]);
  });

  it("METHOD_TERMS knows note-onset, the latency method plugin-hostd writes for an instrument", () => {
    expect(codes(METHOD_TERMS)).toContain("note-onset");
  });

  it("every term has a description", () => {
    for (const term of [...UNMEASURED_TERMS, ...SCALING_TERMS, ...SCALING_NOTE_TERMS, ...EXCLUSION_TERMS, ...METHOD_TERMS]) {
      expect(term.description.length, term.code).toBeGreaterThan(0);
    }
  });
});

/** One place a measurement word is written: the files, how its words are found, their vocabulary. */
interface Writer {
  readonly what: string;
  readonly files: (rel: string) => boolean;
  /** The words written in one file's text. */
  readonly words: (text: string) => string[];
  readonly vocabulary: readonly string[];
}

/** The first capture of every match of `shape`. */
const captured = (shape: RegExp) => (text: string): string[] => [...text.matchAll(shape)].map((m) => m[1]!);

/** The string literals a top-level Python `def name` returns; its body runs to the next top-level `def`. */
const pythonReturns = (name: string) => (text: string): string[] => {
  const start = text.indexOf(`\ndef ${name}(`);
  if (start < 0) return [];
  const rest = text.slice(start + 1);
  const end = rest.indexOf("\ndef ", 1);
  return captured(/\breturn\s+"([^"]+)"/g)(end < 0 ? rest : rest.slice(0, end));
};

/** A source that writes words; the vocabulary's own description tables are typed by the contract instead. */
const isSource = (rel: string): boolean =>
  /^(src|tools|native|bin)\//.test(rel) &&
  /\.(ts|mjs|py|c)$/.test(rel) &&
  !/(\.test\.|\/test_)/.test(rel) &&
  rel !== "src/measurement/vocabulary.ts";

const WRITERS: readonly Writer[] = [
  {
    what: "unmeasured reason",
    files: isSource,
    // unmeasuredReason: "x" (TS), c->unmeasured = "x" / pin->reason = "x" (C), "unmeasurable": "x" (Python)
    words: captured(/(?:\bunmeasured(?:Reason)?|->reason|"unmeasurable")\s*[:=]\s*"([^"]+)"/g),
    vocabulary: words("MEASUREMENT_UNMEASURED_REASONS"),
  },
  {
    what: "unmeasured reason a probe line maps to",
    files: (rel) => rel === "src/measurement/probe-json.ts",
    words: captured(/\{\s*match:\s*\/[^\n]*\/,\s*code:\s*"([^"]+)"\s*\}/g),
    vocabulary: words("MEASUREMENT_UNMEASURED_REASONS"),
  },
  {
    what: "method",
    files: isSource,
    words: captured(/\bmethod:\s*"([^"]+)"/g),
    vocabulary: [...words("MEASUREMENT_LATENCY_METHODS"), ...words("MEASUREMENT_COST_METHODS")],
  },
  {
    what: "scaling law benchmark.py fits",
    files: (rel) => rel === "tools/benchmark.py",
    words: pythonReturns("_fit_scaling"),
    vocabulary: words("MEASUREMENT_LATENCY_SCALING"),
  },
];

function writtenOutside(files: readonly string[], read: (rel: string) => string): string[] {
  const out: string[] = [];
  for (const w of WRITERS) {
    for (const rel of files.filter(w.files)) {
      for (const word of w.words(read(rel))) if (!w.vocabulary.includes(word)) out.push(`${rel}: ${w.what} ${word}`);
    }
  }
  return out;
}

describe("every measurement word plugin-qualify writes is the contract's", () => {
  const files = trackedTextFiles();

  it("each writer's shape finds words — positive control", () => {
    for (const w of WRITERS) {
      const found = files.filter(w.files).flatMap((rel) => w.words(readPkg(rel)));
      expect(found.length, w.what).toBeGreaterThan(0);
    }
  });

  it("no writer writes a word the contract lacks", () => {
    expect(writtenOutside(files, readPkg)).toEqual([]);
  });

  it("an invented reason in the C measurer is seen — sabotage control", () => {
    const sabotaged = (rel: string) =>
      rel === "native/clap-qualify.c" ? readPkg(rel).replace('c->unmeasured = "no-voices"', 'c->unmeasured = "no-voicez"') : readPkg(rel);
    expect(writtenOutside(files, sabotaged)).toContain("native/clap-qualify.c: unmeasured reason no-voicez");
  });
});
