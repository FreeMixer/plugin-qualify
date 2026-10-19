// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * `plugin-qualify judge <probe-output>...`: judge probe outputs already written (by
 * `plugin-hostd-probe run`, by plugin-hostd's `judge_cmd`, or by hand) and write the qualification
 * record beside a byte copy of each. `bin/plugin-qualify.mjs` only reads argv and prints.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { HostProfile } from "./host-profiles.js";
import { judgeProbeOutput, judgmentVerdicts } from "./probe-judge.js";
import { readProbeOutput } from "./probe-output.js";
import { writeQualification } from "./qualification-record.js";
import type { QualifyVerdict } from "./qualify-cli.js";
import { EXIT_CODE, OUTPUT_FORMATS, type OutputFormat } from "./qualify-options.js";
import { OPENMIXER_CONSOLE_PROFILE } from "./host-profiles.js";

export interface JudgeArgs {
  readonly files: readonly string[];
  readonly hostProfiles: readonly string[];
  readonly qualificationDir?: string;
  readonly format: OutputFormat;
  readonly help: boolean;
}

export type ParseJudgeResult = { ok: true; args: JudgeArgs } | { ok: false; error: string };

const VALUE_FLAGS = ["--host-profile", "--qualification-dir", "--format"];

export function parseJudgeArgs(argv: readonly string[]): ParseJudgeResult {
  const files: string[] = [];
  const specs: string[] = [];
  let dir: string | undefined;
  let format: string = "text";
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      files.push(a);
      continue;
    }
    if (a === "--help") {
      help = true;
      continue;
    }
    if (!VALUE_FLAGS.includes(a)) return { ok: false, error: `unknown option ${a}` };
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) return { ok: false, error: `${a} needs a value` };
    if (a === "--host-profile") specs.push(...v.split(",").map((t) => t.trim()).filter((t) => t !== ""));
    else if (a === "--qualification-dir") dir = v;
    else format = v;
  }
  if (!(OUTPUT_FORMATS as readonly string[]).includes(format)) return { ok: false, error: `--format must be one of ${OUTPUT_FORMATS.join(", ")}` };
  if (!help && files.length === 0) return { ok: false, error: "name at least one probe output" };
  return {
    ok: true,
    args: {
      files,
      hostProfiles: [...new Set(specs.length > 0 ? specs : [OPENMIXER_CONSOLE_PROFILE.id])],
      ...(dir === undefined ? {} : { qualificationDir: dir }),
      format: format as OutputFormat,
      help,
    },
  };
}

export function judgeHelpText(): string {
  return [
    "plugin-qualify judge — judge probe outputs and write the qualification records",
    "",
    "  plugin-qualify judge [options] <probe-output.json>...",
    "",
    "  --host-profile <file|id>      judge against this host; repeat or comma-separate for one verdict per profile",
    `                                (default: ${OPENMIXER_CONSOLE_PROFILE.id})`,
    "  --qualification-dir <dir>     where the records and the copies of the probe outputs go",
    "                                (default: $XDG_STATE_HOME/omx/qualification, else ~/.local/state/omx/qualification)",
    "  --format <json|text>          json = the records; text = plugin, verdict, deciding reason (default: text)",
    "",
    `exit ${EXIT_CODE.allQualified} all qualified / ${EXIT_CODE.someNotQualified} some not / ${EXIT_CODE.couldNotMeasure} something could not be read or judged`,
    "",
  ].join("\n");
}

/** The qualification directory when none is named: the state directory of owner spec section 6.9, per user. */
export function defaultQualificationDir(env: Readonly<Record<string, string | undefined>>, home: string = homedir()): string {
  const state = env["XDG_STATE_HOME"];
  return join(state !== undefined && state !== "" ? state : join(home, ".local", "state"), "omx", "qualification");
}

export interface JudgeFilesResult {
  readonly verdicts: readonly QualifyVerdict[];
  readonly records: readonly { readonly recordPath: string; readonly probePath: string }[];
  /** Each file that was refused or could not be read, with the code or the reason. */
  readonly failures: readonly { readonly file: string; readonly problem: string }[];
}

/** Judge each file under every profile and write its record; a file that does not read is a failure, and the others go on. */
export function judgeFiles(
  files: readonly string[],
  options: { profiles: readonly HostProfile[]; dir: string; read?: (path: string) => Buffer },
): JudgeFilesResult {
  const read = options.read ?? ((p: string) => readFileSync(p));
  const verdicts: QualifyVerdict[] = [];
  const records: { recordPath: string; probePath: string }[] = [];
  const failures: { file: string; problem: string }[] = [];
  for (const file of files) {
    let bytes: Buffer;
    try {
      bytes = read(file);
    } catch (e) {
      failures.push({ file, problem: `cannot read: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    const r = readProbeOutput(bytes.toString("utf8"));
    if (!r.ok) {
      failures.push({ file, problem: `${r.code}: ${r.problem}` });
      continue;
    }
    const judgment = judgeProbeOutput(r.output, options.profiles);
    const w = writeQualification(options.dir, bytes, judgment);
    records.push({ recordPath: w.recordPath, probePath: w.probePath });
    verdicts.push(...judgmentVerdicts(judgment));
  }
  return { verdicts, records, failures };
}

/** 2 when a file could not be judged or a plugin was not measured, else 0 when every verdict qualifies, else 1. */
export function judgeExitCode(result: JudgeFilesResult): number {
  if (result.failures.length > 0 || result.verdicts.length === 0 || result.verdicts.some((v) => !v.measured)) return EXIT_CODE.couldNotMeasure;
  return result.verdicts.every((v) => v.qualified) ? EXIT_CODE.allQualified : EXIT_CODE.someNotQualified;
}
