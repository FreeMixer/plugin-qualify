// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The `plugin-qualify` CLI's OPTIONS, declared once (`docs/design/specs/2026-09-25-plugin-qualify.md`
 * §5). The parser, `--help` and the tests all read this table; every default is a declaration
 * from `declarations.ts`, never a literal here.
 */
import { QUALIFY_QUANTA, QUALIFY_RATES } from "./qualify-declarations.js";
import { HOST_PROFILES, OPENMIXER_CONSOLE_PROFILE } from "./host-profiles.js";

/** How the result is printed. `text` = plugin, verdict, the reason that decided it. */
export const OUTPUT_FORMATS = ["json", "text"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** The exit codes, as the spec states them. */
export const EXIT_CODE = {
  /** Every named plugin rated `suitable`. */
  allQualified: 0,
  /** At least one plugin measured and rated below `suitable`. */
  someNotQualified: 1,
  /** A plugin could not be measured, or the arguments/targets could not be resolved. */
  couldNotMeasure: 2,
} as const;

export interface QualifyOption {
  /** `--rates`; a positional is not an option. */
  readonly flag: string;
  /** The value's name when the option takes one. */
  readonly value?: string;
  readonly describe: string;
  /** The declared default, printed by `--help` — absent for a switch. */
  readonly default?: string;
}

export const QUALIFY_OPTIONS: readonly QualifyOption[] = [
  { flag: "--all", describe: "every plugin lilv finds (LV2_PATH honoured)" },
  { flag: "--rates", value: "list", describe: "sample rates to measure at, comma-separated", default: QUALIFY_RATES.join(",") },
  { flag: "--quanta", value: "list", describe: "quanta (frames) to rate cost at, comma-separated", default: QUALIFY_QUANTA.join(",") },
  { flag: "--out", value: "dir", describe: "write one interchange JSON document per run into this directory" },
  { flag: "--format", value: OUTPUT_FORMATS.join("|"), describe: "json = the verdicts as JSON; text = plugin, verdict, deciding reason", default: "text" },
  { flag: "--isolate", describe: "a fresh worker per plugin, so a crash or hang takes only that plugin" },
  { flag: "--no-host-sweep", describe: "offline lilv measurement only; no mod-host hosting sweep" },
  {
    flag: "--host-profile",
    value: "file|id",
    describe: `judge against this host (${HOST_PROFILES.map((p) => p.id).join(", ")}, or a profile JSON file); repeat or comma-separate for one verdict per profile`,
    default: OPENMIXER_CONSOLE_PROFILE.id,
  },
  { flag: "--help", describe: "this text" },
];
