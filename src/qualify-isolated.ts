// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The steps of one plugin's pass, and the last of them: `verdict=isolated` means the plugin was seen running alone in a
 * worker of its own (plugin-qualify#249). A plugin the RT-safety step finds unsafe takes the isolated step in the same
 * pass, and so does one that crashed or hung in the probe. The step runs on a private JACK server at the host's rate and
 * quantum, under a plugin-hostd of its own: the plugin is added alone, `worker_list` must show it alone, and a sine plays
 * through it for a window. Only a plugin that was added, stayed alive and gave finite, non-silent output is isolated. A
 * machine that could not run the step decides nothing about the plugin: no verdict word, and the sync tries it again.
 *
 * Every record says which steps judged it. {@link missingSteps} is what the sync refuses a record by; a record from before
 * the steps has no `run` at all, owes the isolated step if its outcome calls for one, and a completion adds it
 * ({@link completeIsolated}), measuring nothing else.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { ADAPTER_PASS_CELLS, startPrivateJack, type JackStarter } from "./qualify-adapter-pass.js";
import type { GridCell } from "./measurement-grid.js";
import type { PinEntry } from "./pins-file.js";
import { PROBE_OK, readProbeOutput } from "./probe-output.js";
import type { IsolatedFigures, QualificationRecord, RunBlock, RunStep } from "./qualification-record.js";
import { ISOLATED_SIGNAL_TOOL_ENV, ISOLATED_SIGNAL_TOOL_NAME } from "./qualify-declarations.js";
import { locateNativeTool, toolsDir } from "./tool-paths.js";
import { writeFileWhole } from "./whole-file.js";

/** The steps of a pass, in the order they run. */
export const RUN_STEP = { scan: "scan", describe: "describe", probe: "probe", rtSafety: "rt-safety", isolated: "isolated" } as const;

export const ISOLATED_RESULT = { isolated: "isolated", refused: "refused", notRun: "not-run" } as const;

/** Why the step refused a plugin, or why it could not run. */
export const ISOLATED_CODE = {
  crashed: "isolated.crashed",
  notAdded: "isolated.not-added",
  noWorker: "isolated.no-worker",
  notAlone: "isolated.not-alone",
  nonFinite: "isolated.non-finite-output",
  silent: "isolated.silent-output",
  noServer: "isolated.no-private-server",
  noHost: "isolated.no-host",
} as const;

/** The outcomes of a probe that take the isolated step as well: the plugin never reached a verdict in-process. */
const PROBE_FAILED_HARD = new Set(["probe.crashed", "probe.timeout"]);

/** What one run of the step saw. A run that never reached the plugin says `started: false`, and `problem`. */
export interface IsolatedRunFacts {
  readonly started: boolean;
  readonly problem?: string;
  readonly added?: boolean;
  /** How many workers `worker_list` showed, and how many instances the plugin's holds. */
  readonly workers?: number;
  readonly instancesInWorker?: number;
  readonly alive?: boolean;
  readonly latencyFrames?: number;
  readonly cpuPercent?: number;
  readonly xruns?: number;
  readonly finite?: boolean;
  readonly silent?: boolean;
}

export type IsolatedRunner = (uri: string, cell: GridCell, env: Readonly<Record<string, string | undefined>>) => IsolatedRunFacts;

/** The decision table of the step, with the figures it took. Pure. */
export function judgeIsolatedRun(run: IsolatedRunFacts): RunStep {
  const step = (result: string, code?: string, detail?: string): RunStep => ({
    step: RUN_STEP.isolated,
    result,
    ...(code === undefined ? {} : { code }),
    ...(detail === undefined ? {} : { detail }),
    ...(figuresOf(run) === undefined ? {} : { figures: figuresOf(run)! }),
  });
  if (!run.started) return step(ISOLATED_RESULT.notRun, ISOLATED_CODE.noHost, run.problem);
  if (run.added !== true) return step(ISOLATED_RESULT.refused, ISOLATED_CODE.notAdded, run.problem);
  if (run.alive !== true) return step(ISOLATED_RESULT.refused, ISOLATED_CODE.crashed, run.problem);
  if ((run.workers ?? 0) < 1) return step(ISOLATED_RESULT.refused, ISOLATED_CODE.noWorker);
  if (run.workers !== 1 || run.instancesInWorker !== 1) return step(ISOLATED_RESULT.refused, ISOLATED_CODE.notAlone);
  if (run.finite !== true) return step(ISOLATED_RESULT.refused, ISOLATED_CODE.nonFinite);
  if (run.silent !== false) return step(ISOLATED_RESULT.refused, ISOLATED_CODE.silent);
  return step(ISOLATED_RESULT.isolated);
}

function figuresOf(run: IsolatedRunFacts): IsolatedFigures | undefined {
  if (run.latencyFrames === undefined && run.cpuPercent === undefined && run.xruns === undefined) return undefined;
  return {
    ...(run.latencyFrames === undefined ? {} : { latencyFrames: run.latencyFrames }),
    ...(run.cpuPercent === undefined ? {} : { cpuPercent: run.cpuPercent }),
    ...(run.xruns === undefined ? {} : { xruns: run.xruns }),
  };
}

/** Whether a record's outcome calls for the isolated step: rated `conditional` by some host, or a probe that crashed or hung. */
export function owesIsolated(record: QualificationRecord): boolean {
  return PROBE_FAILED_HARD.has(record.probe.outcome) || record.verdicts.some((v) => v.measured && v.rating === "conditional");
}

/** Whether the isolated step saw this plugin running alone. A record's word alone never says so. */
export function provenAlone(record: QualificationRecord): boolean {
  return record.run?.steps.some((s) => s.step === RUN_STEP.isolated && s.result === ISOLATED_RESULT.isolated) === true;
}

/** The steps a record's outcome calls for. */
export function stepsCalledFor(record: QualificationRecord): readonly string[] {
  return [
    RUN_STEP.scan,
    RUN_STEP.describe,
    RUN_STEP.probe,
    ...(record.probe.outcome === PROBE_OK ? [RUN_STEP.rtSafety] : []),
    ...(owesIsolated(record) ? [RUN_STEP.isolated] : []),
  ];
}

/** The steps a record that carries a `run` lacks, for the sync to refuse it by. A record from before the steps has none to lack. */
export function missingSteps(record: QualificationRecord): readonly string[] {
  if (record.run === undefined) return [];
  const had = new Set(record.run.steps.map((s) => s.step));
  return stepsCalledFor(record).filter((s) => !had.has(s));
}

/** The steps every record has by the time it is written, from what it says of them. Pure. */
export function baseSteps(record: QualificationRecord, describeProblem?: string): RunStep[] {
  const measured = record.measurements.grid.some((p) => p.rtSafety !== undefined);
  return [
    { step: RUN_STEP.scan, result: "ok" },
    describeProblem === undefined ? { step: RUN_STEP.describe, result: "ok" } : { step: RUN_STEP.describe, result: "failed", detail: describeProblem },
    { step: RUN_STEP.probe, result: record.probe.outcome },
    ...(record.probe.outcome === PROBE_OK
      ? [{ step: RUN_STEP.rtSafety, result: !measured ? "not-measured" : record.verdicts.some((v) => v.rating === "conditional") ? "unsafe" : "safe" }]
      : []),
  ];
}

/** How long the sine plays, and what a step may take beyond it: the host's start and its answers. */
const ISOLATED_WINDOW_MS = 3000;
const ISOLATED_STEP_SLACK_MS = 90000;

/** The step as it runs on a device: a private server at the cell, and `tools/isolated-step.mjs` under it. */
export function spawnedIsolatedRunner(jack: JackStarter = startPrivateJack): IsolatedRunner {
  return (uri, cell, env) => {
    const signal = locateNativeTool(ISOLATED_SIGNAL_TOOL_NAME, env, existsSync).path;
    if (signal === undefined) return { started: false, problem: `no ${ISOLATED_SIGNAL_TOOL_NAME}` };
    const server = jack(cell);
    if (server === undefined) return { started: false, problem: `${ISOLATED_CODE.noServer} at ${String(cell.rate)}/${String(cell.quantum)}` };
    try {
      const r = spawnSync(process.execPath, [join(toolsDir(), "isolated-step.mjs"), uri, String(ISOLATED_WINDOW_MS)], {
        encoding: "utf8",
        timeout: ISOLATED_WINDOW_MS + ISOLATED_STEP_SLACK_MS,
        killSignal: "SIGKILL",
        env: { ...env, JACK_DEFAULT_SERVER: server.name, [ISOLATED_SIGNAL_TOOL_ENV]: signal },
      });
      if (r.error !== undefined || r.status !== 0) return { started: false, problem: `isolated-step: ${r.error?.message ?? `exit ${String(r.status)}`}: ${(r.stderr ?? "").trim()}` };
      return JSON.parse(r.stdout) as IsolatedRunFacts;
    } finally {
      server.stop();
    }
  };
}

/** The cell the step runs at: the rate and quantum the host's cost was judged at, else the first cell a Pi runs. */
export function isolatedCell(record: QualificationRecord, host: string): GridCell {
  const at = record.cost.find((c) => c.host === host) ?? record.cost[0];
  return at === undefined ? ADAPTER_PASS_CELLS[0]! : { rate: at.rate, quantum: at.quantum };
}

/** The pin once the step has spoken: its verdict word follows the step, and a step that could not run leaves none. Pure. */
export function pinAfterStep(pin: PinEntry | undefined, step: RunStep): PinEntry | undefined {
  if (pin === undefined) return undefined;
  const { verdict: _had, ...rest } = pin;
  if (step.result === ISOLATED_RESULT.isolated) return { ...rest, verdict: "isolated" };
  if (step.result === ISOLATED_RESULT.refused) return { ...rest, verdict: "refused" };
  return rest;
}

/** The run id of a record from before the steps: its probe output's, read from the copy beside it. */
function runIdOf(record: QualificationRecord, dir: string): string | undefined {
  if (record.run !== undefined) return record.run.id;
  if (record.rejudged !== undefined) return record.rejudged.figures.runId;
  try {
    const read = readProbeOutput(readFileSync(join(dir, basename(record.probe.file)), "utf8"));
    return read.ok ? read.output.run.id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The missing isolated step of a record already judged: the run keeps its id and gains the step, and nothing else is
 * measured. `undefined` when it owes none, or has no run id to extend. Writes the record whole.
 */
export function completeIsolated(path: string, record: QualificationRecord, uri: string, cell: GridCell, runner: IsolatedRunner, env: Readonly<Record<string, string | undefined>>): { readonly record: QualificationRecord; readonly step: RunStep } | undefined {
  if (!owesIsolated(record) || record.run?.steps.some((s) => s.step === RUN_STEP.isolated) === true) return undefined;
  const id = runIdOf(record, join(path, ".."));
  if (id === undefined) return undefined;
  const step = judgeIsolatedRun(runner(uri, cell, env));
  const run: RunBlock = { id, steps: [...(record.run?.steps ?? baseSteps(record)), step] };
  const next = { ...record, run };
  writeFileWhole(path, `${JSON.stringify(next, null, 2)}\n`);
  return { record: next, step };
}
