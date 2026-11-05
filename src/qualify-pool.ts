// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The pool step: the one place that grants a plugin the CLAP thread pool. omx-clap-host sizes a pool of helper threads
 * from its worker's cpu set, and plugin-hostd starts a worker with it only for a plugin whose pin says `pool=cores`
 * (plugin-db's `PLUGIN_DB_PIN_POOLS`: "measured real-time safe and faster at the quantum"). That word is the plugin's
 * qualification to give, so nothing writes it but this step.
 *
 * A plugin that does not offer `clap.thread-pool` is never asked: its record says `not-asked` and its pin has no pool
 * word, so it runs serial. A plugin that does is first run by the prober with real helper threads under the interposer
 * (`clap-qualify --pool`, which counts what the plugin's tasks do on a thread that is not the audio thread); one that
 * allocates, locks or makes a system call there is `off`. Then it is run twice in a worker of its own on a private JACK
 * server at the host's rate and quantum, with the same notes held, once under `pool=off` and once under `pool=cores`
 * (`tools/pool-step.mjs`), each mode twice in turn and judged by its best window, because what else runs on the machine can
 * only make a window worse. The pool is granted when, with it on,
 *
 *  - its tasks, run on the helpers under the interposer, allocated nothing, took no lock and made no system call,
 *  - the worker really started with the pool (a daemon that does not apply the word decides nothing),
 *  - the output is finite and not silent, and the worker lived through the window,
 *  - the window took no more xruns than the same window without the pool, and
 *  - the server's DSP load, which is the share of the cycle the plugin's block takes, fell to at most
 *    {@link POOL_GAIN} of the load without the pool and by at least {@link POOL_MIN_GAIN} points of the cycle (a plugin
 *    with next to nothing to do has too little to run in parallel for a ratio to mean anything).
 *
 * A plugin that is measured and fails any of these gets `pool=off`: the word says it was looked at. A machine that could
 * not run the step decides nothing, and the sync tries again.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";

import type { GridCell } from "./measurement-grid.js";
import type { PinEntry, PinPool } from "./pins-file.js";
import type { PoolFigures, QualificationRecord, RunBlock, RunStep } from "./qualification-record.js";
import { ADMIT_STEP_MS_ENV, CLAP_QUALIFY_TOOL_NAME, ISOLATED_SIGNAL_TOOL_ENV, ISOLATED_SIGNAL_TOOL_NAME, RT_INTERPOSE_NAME } from "./qualify-declarations.js";
import { ISOLATED_RESULT, RUN_STEP, baseSteps, pinFromRecord, runIdOf } from "./qualify-isolated.js";
import { startPrivateJack, type JackStarter } from "./qualify-adapter-pass.js";
import { locateNativeTool, toolsDir } from "./tool-paths.js";
import { writeFileWhole } from "./whole-file.js";

/** The name of the step in a record's run. It is not one of `RUN_STEP`: a record is complete without it (a plugin that does not ask for the pool, or a machine that cannot run the step, has none). */
export const POOL_STEP = "pool";

/** The server's DSP load with the pool may be at most this fraction of the load without it. */
export const POOL_GAIN = 0.85;

/**
 * The load must also fall by at least this many points of the cycle. The server's load has a floor of its own (the signal
 * client, the ports, the worker's routing), so a plugin with next to nothing to do can fall by a good ratio of a small
 * difference, and a pool for it would cost the cores it holds.
 */
export const POOL_MIN_GAIN = 3;

/**
 * The pool's helpers must have been on a cpu this many nanoseconds in the busiest window with the pool (20 ms of a 3 s
 * window, across all of them): a worker that holds the pool and whose plugin asks for tasks every block keeps them
 * busy for a good part of it, and a few microseconds is a start-up, not a pool at work.
 */
export const POOL_HELPERS_IDLE_NS = 20_000_000;

export const POOL_RESULT = { cores: "cores", off: "off", notAsked: "not-asked", notRun: "not-run" } as const;

/** Why the step decided what it did, or why it could not run. */
export const POOL_CODE = {
  noHost: "pool.no-host",
  noServer: "pool.no-private-server",
  notAdded: "pool.not-added",
  windowFailed: "pool.window-failed",
  unwatched: "pool.not-watched",
  notRtSafe: "pool.not-rt-safe",
  notApplied: "pool.not-applied",
  crashed: "pool.crashed-with-pool",
  unsafeOutput: "pool.unsafe-output",
  xruns: "pool.more-xruns",
  notFaster: "pool.not-faster",
  helpersIdle: "pool.helpers-idle",
} as const;

/** What one window saw, with the pool as the word set it. */
export interface PoolWindowFacts {
  readonly problem?: string;
  readonly alive?: boolean;
  readonly workers?: number;
  /** hostd's `worker_list` field for the worker: `on` for a worker started with the pool. */
  readonly poolOfWorker?: string;
  readonly xruns?: number;
  readonly finite?: boolean;
  readonly silent?: boolean;
  readonly dspLoad?: number;
  /** Nanoseconds the worker's pool helpers were on a cpu in the window (the busiest of the windows taken): little means the worker held the pool and its helpers ran next to nothing. */
  readonly helperBusyNs?: number;
}

/** What the plugin did on the helper threads of a real pool under the interposer. */
export interface PoolRtFacts {
  readonly helpers: number;
  /** The tasks the helpers ran; none means the pool was not exercised, and nothing was seen of it. */
  readonly tasksOnHelpers: number;
  readonly allocations: number;
  readonly locks: number;
  readonly syscalls: number;
}

/** What one run of the step saw. A run that never reached the plugin says `started: false`, and `problem`. */
export interface PoolRunFacts {
  readonly started: boolean;
  readonly problem?: string;
  /** Whether the plugin offers clap.thread-pool. */
  readonly asks?: boolean;
  /** The plugin's tasks on helper threads, counted by the interposer (the prober's `--pool`); absent when it could not be watched. */
  readonly rt?: PoolRtFacts;
  readonly added?: boolean;
  readonly off?: PoolWindowFacts;
  readonly on?: PoolWindowFacts;
  /** The worker under `pool=cores` was started with the pool and the one under `pool=off` was not. */
  readonly poolApplied?: boolean;
}

export type PoolRunner = (uri: string, cell: GridCell, env: Readonly<Record<string, string | undefined>>) => PoolRunFacts;

function figuresOf(run: PoolRunFacts): PoolFigures | undefined {
  const { off, on, rt } = run;
  const watched = rt === undefined ? {} : { allocationsOn: rt.allocations, locksOn: rt.locks, syscallsOn: rt.syscalls, tasksOnHelpers: rt.tasksOnHelpers };
  const timed = off?.dspLoad === undefined || on?.dspLoad === undefined ? {} : { dspLoadOff: off.dspLoad, dspLoadOn: on.dspLoad, xrunsOff: off.xruns ?? 0, xrunsOn: on.xruns ?? 0 };
  return Object.keys(watched).length === 0 && Object.keys(timed).length === 0 ? undefined : { ...watched, ...timed };
}

/** The decision table of the step, with the figures it took. Pure. */
export function judgePoolRun(run: PoolRunFacts): RunStep {
  const step = (result: string, code?: string, detail?: string): RunStep => {
    const pool = figuresOf(run);
    return { step: POOL_STEP, result, ...(code === undefined ? {} : { code }), ...(detail === undefined ? {} : { detail }), ...(pool === undefined ? {} : { pool }) };
  };
  if (!run.started) return step(POOL_RESULT.notRun, POOL_CODE.noHost, run.problem);
  if (run.asks === false) return step(POOL_RESULT.notAsked);
  // the plugin on helper threads comes first: a plugin that allocates or locks there is refused the pool whatever it gains,
  // and one nobody could watch there decides nothing
  const { rt } = run;
  if (rt === undefined || rt.tasksOnHelpers < 1) return step(POOL_RESULT.notRun, POOL_CODE.unwatched, run.problem ?? "the plugin's tasks were not seen on helper threads under the interposer");
  if (rt.allocations + rt.locks + rt.syscalls > 0) {
    return step(POOL_RESULT.off, POOL_CODE.notRtSafe, `${String(rt.allocations)} allocations, ${String(rt.locks)} locks and ${String(rt.syscalls)} system calls while its tasks ran on ${String(rt.helpers)} helper threads`);
  }
  if (run.added !== true) return step(POOL_RESULT.notRun, POOL_CODE.notAdded, run.problem);
  const { off, on } = run;
  // the window without the pool is the reference: a plugin that does not even run alone says nothing about the pool
  if (off === undefined || off.problem !== undefined || off.alive !== true || off.finite !== true) return step(POOL_RESULT.notRun, POOL_CODE.windowFailed, off?.problem ?? "the window without the pool did not run");
  if (on === undefined) return step(POOL_RESULT.notRun, POOL_CODE.windowFailed, "the window with the pool did not run");
  if (run.poolApplied !== true) return step(POOL_RESULT.notRun, POOL_CODE.notApplied, "the daemon did not start the worker with the thread pool");
  if (on.alive !== true) return step(POOL_RESULT.off, POOL_CODE.crashed, on.problem);
  if (on.problem !== undefined) return step(POOL_RESULT.notRun, POOL_CODE.windowFailed, on.problem);
  if (on.finite !== true || on.silent !== false) return step(POOL_RESULT.off, POOL_CODE.unsafeOutput);
  // the worker held the pool and its helpers ran nothing: the plugin's requests never reached them, so the window with the
  // pool measured the window without it again, and no gain was seen because there was nothing to see
  if (on.helperBusyNs !== undefined && on.helperBusyNs < POOL_HELPERS_IDLE_NS) return step(POOL_RESULT.off, POOL_CODE.helpersIdle, "the worker's pool helpers ran no task in the window with the pool");
  if ((on.xruns ?? 0) > (off.xruns ?? 0)) return step(POOL_RESULT.off, POOL_CODE.xruns);
  if (off.dspLoad === undefined || on.dspLoad === undefined) return step(POOL_RESULT.notRun, POOL_CODE.windowFailed, "the server's load was not read");
  if (on.dspLoad > off.dspLoad * POOL_GAIN || off.dspLoad - on.dspLoad < POOL_MIN_GAIN) return step(POOL_RESULT.off, POOL_CODE.notFaster);
  return step(POOL_RESULT.cores);
}

/** The pool word a step grants, or `undefined` for a step that decided nothing or granted none. */
export function poolWordOf(step: RunStep | undefined): PinPool | undefined {
  if (step?.step !== POOL_STEP) return undefined;
  return step.result === POOL_RESULT.cores ? "cores" : step.result === POOL_RESULT.off ? "off" : undefined;
}

/** The pool step of a run, if it has one. */
export function poolStepOf(run: QualificationRecord["run"]): RunStep | undefined {
  return run?.steps.find((s) => s.step === POOL_STEP);
}

/** The pin once the step has spoken: its pool word follows the step, and a step that decided nothing leaves none. A refused pin carries none. Pure. */
export function pinAfterPool(pin: PinEntry | undefined, step: RunStep | undefined): PinEntry | undefined {
  if (pin === undefined) return undefined;
  const { pool: _had, ...rest } = pin;
  const word = poolWordOf(step);
  return word === undefined || pin.verdict === "refused" ? rest : { ...rest, pool: word };
}

/** Whether a step ended with a decision: `not-run` is the machine's, and the sync asks again. */
export const poolDecided = (s: RunStep): boolean => s.step === POOL_STEP && s.result !== POOL_RESULT.notRun;

/**
 * Whether a record owes the pool step: a CLAP plugin judged in a pass with steps, not refused, with no decided pool step.
 * A record from before the steps owes the isolated step first, which gives it a run; the pool is for a plugin that runs,
 * and a refused one never is.
 */
export function owesPool(record: QualificationRecord): boolean {
  if (record.plugin.format !== "clap" || record.run === undefined) return false;
  const steps = record.run.steps;
  if (steps.some(poolDecided)) return false;
  if (steps.some((s) => s.step === RUN_STEP.isolated && s.result === ISOLATED_RESULT.refused)) return false;
  return record.verdicts.some((v) => v.measured && v.rating !== "unsuitable");
}

/** How long each window plays, and what the step may take beyond the two: the host's start and its answers. */
const POOL_WINDOW_MS = 3000;
const POOL_ROUNDS = 2;
const POOL_STEP_SLACK_MS = 120000;

/** Whether the plugin of a `clap:<path>#<id>` uri offers clap.thread-pool, by the prober's own `--asks-thread-pool`; `undefined` when it could not be asked. */
export function asksForPool(prober: string, uri: string, env: Readonly<Record<string, string | undefined>>): boolean | undefined {
  const m = /^clap:(.*)#([^#]*)$/s.exec(uri);
  if (m === null) return undefined;
  const r = spawnSync(prober, ["--asks-thread-pool", m[1]!, m[2]!], { encoding: "utf8", timeout: 60000, killSignal: "SIGKILL", env: { ...env } });
  if (r.status !== 0) return undefined;
  try {
    return (JSON.parse(r.stdout) as { threadPool?: unknown }).threadPool === true;
  } catch {
    return undefined;
  }
}

/** The most helper threads the prober's pool makes (`POOL_HELPERS_MAX` in native/clap-qualify.c). */
const POOL_HELPERS_MAX = 7;

/** How many blocks the prober's sweeps run: the sync's own, so a plugin that needs a few blocks to settle is seen settled. */
const WATCH_BLOCKS = 512;

/**
 * What the plugin does on helper threads: the prober run with a real pool of one helper per core of this process's set but
 * one (at most seven), under the interposer, which counts what any thread does while a sweep runs. The pool must have
 * been used: a run whose tasks all ran on the calling thread saw nothing of the helpers.
 */
export function watchOnHelpers(prober: string, interposer: string, uri: string, cell: GridCell, env: Readonly<Record<string, string | undefined>>): { readonly rt: PoolRtFacts } | { readonly problem: string } {
  const m = /^clap:(.*)#([^#]*)$/s.exec(uri);
  if (m === null) return { problem: `${uri} is no clap uri` };
  const helpers = Math.min(POOL_HELPERS_MAX, availableParallelism() - 1);
  if (helpers < 1) return { problem: "this machine has one core, and a pool of one core is no pool" };
  const preload = [interposer, env["LD_PRELOAD"]].filter((x) => x !== undefined && x !== "").join(" ");
  const r = spawnSync(prober, ["--rates", String(cell.rate), "--block", String(cell.quantum), "--blocks", String(WATCH_BLOCKS), "--pool", String(helpers), m[1]!, m[2]!], {
    encoding: "utf8",
    timeout: 120000,
    killSignal: "SIGKILL",
    env: { ...env, LD_PRELOAD: preload },
  });
  if (r.error !== undefined || r.status !== 0) return { problem: `${CLAP_QUALIFY_TOOL_NAME} --pool: ${r.error?.message ?? `exit ${String(r.status)}`}` };
  const line = r.stdout.split("\n").filter((l) => l.startsWith("{")).pop();
  if (line === undefined) return { problem: `${CLAP_QUALIFY_TOOL_NAME} --pool printed no line` };
  try {
    const doc = JSON.parse(line) as { rtSafety?: { interposer?: boolean; allocationsInRun?: number; locksInRun?: number; syscallsInRun?: number }; noteSweep?: { interposer?: boolean; allocationsInRun?: number; locksInRun?: number; syscallsInRun?: number }; threadPool?: { tasksOnHelpers?: number } };
    const sweeps = [doc.rtSafety, doc.noteSweep].filter((x) => x?.interposer === true);
    if (doc.rtSafety?.interposer !== true) return { problem: "the interposer did not load in the prober" };
    const sum = (key: "allocationsInRun" | "locksInRun" | "syscallsInRun"): number => sweeps.reduce((n, x) => n + (x?.[key] ?? 0), 0);
    return { rt: { helpers, tasksOnHelpers: doc.threadPool?.tasksOnHelpers ?? 0, allocations: sum("allocationsInRun"), locks: sum("locksInRun"), syscalls: sum("syscallsInRun") } };
  } catch {
    return { problem: `${CLAP_QUALIFY_TOOL_NAME} --pool printed no JSON` };
  }
}

/** The step as it runs on a device: a private server at the cell, and `tools/pool-step.mjs` under it. */
export function spawnedPoolRunner(jack: JackStarter = startPrivateJack): PoolRunner {
  return (uri, cell, env) => {
    const prober = locateNativeTool(CLAP_QUALIFY_TOOL_NAME, env, existsSync).path;
    if (prober === undefined) return { started: false, problem: `no ${CLAP_QUALIFY_TOOL_NAME}` };
    // a plugin that does not offer the pool is not worth a JACK server and a daemon: ask the plugin first
    const asks = asksForPool(prober, uri, env);
    if (asks === undefined) return { started: false, problem: `${uri} could not be asked for clap.thread-pool` };
    if (!asks) return { started: true, asks: false };
    // then what it does on helper threads, which needs no server: a plugin that allocates there is refused without one
    const interposer = locateNativeTool(RT_INTERPOSE_NAME, env, existsSync).path;
    if (interposer === undefined) return { started: true, asks: true, problem: `no ${RT_INTERPOSE_NAME}` };
    const watched = watchOnHelpers(prober, interposer, uri, cell, env);
    if (!("rt" in watched)) return { started: true, asks: true, problem: watched.problem };
    if (watched.rt.tasksOnHelpers < 1 || watched.rt.allocations + watched.rt.locks + watched.rt.syscalls > 0) return { started: true, asks: true, rt: watched.rt };
    const signal = locateNativeTool(ISOLATED_SIGNAL_TOOL_NAME, env, existsSync).path;
    if (signal === undefined) return { started: false, problem: `no ${ISOLATED_SIGNAL_TOOL_NAME}` };
    const server = jack(cell);
    if (server === undefined) return { started: false, problem: `${POOL_CODE.noServer} at ${String(cell.rate)}/${String(cell.quantum)}` };
    try {
      const r = spawnSync(process.execPath, [join(toolsDir(), "pool-step.mjs"), uri, String(POOL_WINDOW_MS)], {
        encoding: "utf8",
        timeout: 2 * POOL_ROUNDS * POOL_WINDOW_MS + POOL_STEP_SLACK_MS,
        killSignal: "SIGKILL",
        env: { ...env, JACK_DEFAULT_SERVER: server.name, [ISOLATED_SIGNAL_TOOL_ENV]: signal },
      });
      if (r.error !== undefined || r.status !== 0) return { started: false, problem: `pool-step: ${r.error?.message ?? `exit ${String(r.status)}`}: ${(r.stderr ?? "").trim()}` };
      return { ...(JSON.parse(r.stdout) as PoolRunFacts), asks: true, rt: watched.rt };
    } finally {
      server.stop();
    }
  };
}

/** The step's environment: each of its commands has the sync's budget. */
export const poolEnv = (env: Readonly<Record<string, string | undefined>>, budgetS: number): Readonly<Record<string, string | undefined>> => ({ ...env, [ADMIT_STEP_MS_ENV]: String(budgetS * 1000) });

/**
 * The steps of a run with the pool step added or replaced: a step that could not run takes the place of an earlier one
 * that could not, and a decided step is never replaced here.
 */
export function withPoolStep(steps: readonly RunStep[], step: RunStep): RunStep[] {
  return [...steps.filter((s) => s.step !== POOL_STEP), step];
}

/**
 * The pin a record can give back to a plugin whose state lost it: what {@link pinFromRecord} gives, with the pool word
 * of the record's pool step.
 */
export function pinFromRecordWithPool(record: QualificationRecord): PinEntry | undefined {
  return pinAfterPool(pinFromRecord(record), poolStepOf(record.run));
}

/**
 * The missing pool step of a record already judged: the run keeps its id and gains the step, and nothing else is
 * measured. `undefined` when it owes none, or has no run id to extend. Writes the record whole.
 */
export function completePool(path: string, record: QualificationRecord, uri: string, cell: GridCell, runner: PoolRunner, env: Readonly<Record<string, string | undefined>>): { readonly record: QualificationRecord; readonly step: RunStep } | undefined {
  if (!owesPool(record)) return undefined;
  const id = runIdOf(record, join(path, ".."));
  if (id === undefined) return undefined;
  const step = judgePoolRun(runner(uri, cell, env));
  const run: RunBlock = { id, steps: withPoolStep(record.run?.steps ?? baseSteps(record), step) };
  const next = { ...record, run };
  writeFileWhole(path, `${JSON.stringify(next, null, 2)}\n`);
  return { record: next, step };
}
