// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Measuring through plugin-hostd's probe runner (`plugin-hostd-probe run`). The runner starts the
 * prober under limits (a wall clock that kills the whole process tree, CPU time, memory, files),
 * and writes the probe output; plugin-qualify waits for the runner and reads the document. No
 * timeout of ours sits around it: the runner owns the deadline, and a node timer that signalled only
 * the direct child is exactly what the runner replaces.
 *
 * The runner's exit says whether there is a document: 0 and 1 write one (1 is a run whose steps did
 * not all end well, which the document records), 2 is no document (usage, a required limit
 * unavailable, an output that could not be written), 3 is no such plugin.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClapQualifyError, clapQualifyTools, proberOffer, type RtSafetyDocument } from "./clap-qualify.js";
import { locateNativeTool } from "./tool-paths.js";
import type { HostProfile } from "./host-profiles.js";
import { OPENMIXER_CONSOLE_PROFILE, shippedHostProfile } from "./host-profiles.js";
import { IN_PROCESS_TIER_HOST, ISOLATED_TIER_HOST } from "./qualification-record.js";
import type { PluginTarget } from "./loader.js";
import { SPAWNED_ADMISSIONS, admitPlugin, admitUnderAdapter, admittedHostOf, type AdmissionRuns, type HostAdmission } from "./host-admission.js";
import { judgeProbeOutput, judgmentVerdicts, type Judgment } from "./probe-judge.js";
import { readProbeOutput, type ProbeOutput } from "./probe-output.js";
import { budgetCells, gridCells, runnerInvocations, type GridCell, type GridSpec, type RunnerInvocation } from "./measurement-grid.js";
import type { MemoryBound } from "./memory-bound.js";
import { mergeProbeRuns, ProbeMergeError } from "./probe-merge.js";
import type { QualifyVerdict } from "./qualify-cli.js";
import {
  CLAP_QUALIFY_TIMEOUT_S,
  CLAP_SWEEP_BLOCKS,
  CLAP_SWEEP_FRAMES,
  LV2_HOSTING_BLOCK_FRAMES,
  LV2_HOSTING_TIMEOUT_S,
  LV2_MEASURE_TOOL_NAME,
  MEMORY_BOUND_EXIT_ENV,
  PROBE_RUNNER_DEFAULT,
  PROBE_RUNNER_ENV,
  QUALIFY_QUANTA,
} from "./qualify-declarations.js";

export class ProbeRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeRunnerError";
  }
}

/** The runner: the declared setting when set, else the declared default (on `PATH`). */
export function probeRunnerTool(env: Readonly<Record<string, string | undefined>>): string {
  const named = env[PROBE_RUNNER_ENV];
  return named === undefined || named === "" ? PROBE_RUNNER_DEFAULT : named;
}

/** What one run of the runner gave back; `error` is a spawn failure, `signal` a death. */
export interface ProbeRunResult {
  readonly status: number | null;
  readonly signal?: string | null;
  readonly stderr?: string;
  readonly error?: Error;
}

/** Runs the runner. It is given no time limit of its own, since the runner keeps the deadline. */
export type ProbeRun = (tool: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>) => ProbeRunResult;

const spawnRunner: ProbeRun = (tool, args, env) => {
  const r = spawnSync(tool, [...args], { encoding: "utf8", env: { ...env }, maxBuffer: 64 << 20 });
  return { status: r.status, signal: r.signal, stderr: r.stderr ?? "", ...(r.error === undefined ? {} : { error: r.error }) };
};

export interface ProbeTargetOptions {
  /** The rates the plugin is measured at; with no `cells`, each at `CLAP_SWEEP_FRAMES`. */
  readonly rates: readonly number[];
  /** The cells of the grid this plugin is measured at (`measurement-grid.ts`); each format's runs are planned from them. */
  readonly cells?: readonly GridCell[];
  /** Blocks of the CLAP sweep a cell; else `CLAP_SWEEP_BLOCKS`. The LV2 pass has a fixed shape. */
  readonly blocks?: number;
  /** The memory bound every run is held to; none (the runner's own default) when absent. */
  readonly memory?: MemoryBound;
  /** Host extensions to offer beyond the prober's own (a CLAP run). */
  readonly offer?: readonly string[];
  /** The wall clock the runner gives one run, in seconds; else the format's declared one. */
  readonly wallS?: number;
  readonly run?: ProbeRun;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly exists?: (path: string) => boolean;
}

/** The runner's arguments for a CLAP file; `child` is the prober the runner starts. */
export function clapRunnerArgs(
  options: {
    rates: readonly number[];
    quantum?: number;
    blocks?: number;
    dataBytes?: number;
    offer?: readonly string[];
    wallS?: number;
    out: string;
    log: string;
    child: string;
  },
  binaryPath: string,
  id: string | undefined,
): string[] {
  return [
    "run",
    "--child",
    options.child,
    "--rates",
    options.rates.join(","),
    "--quantum",
    String(options.quantum ?? CLAP_SWEEP_FRAMES),
    "--blocks",
    String(options.blocks ?? CLAP_SWEEP_BLOCKS),
    ...(options.offer === undefined || options.offer.length === 0 ? [] : ["--offer", options.offer.join(",")]),
    "--wall-s",
    String(options.wallS ?? CLAP_QUALIFY_TIMEOUT_S),
    ...(options.dataBytes === undefined ? [] : ["--data-bytes", String(options.dataBytes)]),
    "--out",
    options.out,
    "--log",
    options.log,
    binaryPath,
    ...(id === undefined ? [] : [id]),
  ];
}

/**
 * The runner's arguments for an LV2 plugin, named as `lv2:<uri>` and measured by `lv2_measure`: the one this run
 * located when `child` names it, else the one the runner looks for where the packages install it.
 */
export function lv2RunnerArgs(
  options: { rates: readonly number[]; quantum?: number; dataBytes?: number; wallS?: number; out: string; log: string; child?: string },
  uri: string,
): string[] {
  return [
    "run",
    ...(options.child === undefined ? [] : ["--child", options.child]),
    "--rates",
    options.rates.join(","),
    "--quantum",
    String(options.quantum ?? LV2_HOSTING_BLOCK_FRAMES),
    "--wall-s",
    String(options.wallS ?? LV2_HOSTING_TIMEOUT_S),
    ...(options.dataBytes === undefined ? [] : ["--data-bytes", String(options.dataBytes)]),
    "--out",
    options.out,
    "--log",
    options.log,
    `lv2:${uri}`,
  ];
}

/** One probe output and the bytes it was read from (the bytes are what gets copied beside the record). */
export interface ProbedTarget {
  readonly bytes: Buffer;
  readonly output: ProbeOutput;
}

function runOne(target: PluginTarget, options: ProbeTargetOptions, invocation: RunnerInvocation): ProbedTarget {
  const env = options.env ?? process.env;
  const tool = probeRunnerTool(env);
  const work = mkdtempSync(join(tmpdir(), "plugin-qualify-probe-"));
  const out = join(work, "probe.json");
  const log = join(work, "child.stderr.log");
  try {
    let args: string[];
    let runEnv: Record<string, string | undefined> = { ...env };
    let expectedId: string;
    const wall = options.wallS === undefined ? {} : { wallS: options.wallS };
    const bound = options.memory === undefined ? {} : { dataBytes: options.memory.bytes };
    const at = { rates: invocation.rates, quantum: invocation.quantum, ...bound };
    if (target.format === "clap") {
      if (target.binaryPath === undefined) throw new ProbeRunnerError(`${target.uri}: no .clap to load; name the file or a directory holding it`);
      expectedId = target.uri.startsWith("urn:clap:") ? target.uri.slice("urn:clap:".length) : target.uri;
      const { tool: child, interposer } = clapQualifyTools(env, options.exists ?? existsSync);
      args = clapRunnerArgs(
        { ...at, ...(options.blocks === undefined ? {} : { blocks: options.blocks }), ...(options.offer === undefined ? {} : { offer: options.offer }), ...wall, out, log, child },
        target.binaryPath,
        expectedId,
      );
      runEnv = { ...env, LD_PRELOAD: interposer };
    } else {
      expectedId = target.uri;
      const child = locateNativeTool(LV2_MEASURE_TOOL_NAME, env, options.exists ?? existsSync).path;
      args = lv2RunnerArgs(
        { ...at, ...wall, out, log, ...(child === undefined ? {} : { child }) },
        target.uri,
      );
    }
    // under a bound, the interposer ends the child the moment an allocation is refused, with the status that names it
    if (options.memory !== undefined) runEnv = { ...runEnv, [MEMORY_BOUND_EXIT_ENV]: "1" };
    const r = (options.run ?? spawnRunner)(tool, args, runEnv);
    if (r.error !== undefined) {
      throw new ProbeRunnerError(`cannot run the probe runner "${tool}" (${r.error.message}): install plugin-hostd or set ${PROBE_RUNNER_ENV} to plugin-hostd-probe`);
    }
    if (r.signal) throw new ProbeRunnerError(`${tool} was killed (${r.signal}) measuring ${target.uri}`);
    const said = (r.stderr ?? "").trim();
    if (r.status === 3) throw new ProbeRunnerError(`${tool}: no such plugin ${target.uri}${said === "" ? "" : `: ${said}`}`);
    if (r.status !== 0 && r.status !== 1) {
      throw new ProbeRunnerError(`${tool} exited ${String(r.status)} measuring ${target.uri}, and wrote no document${said === "" ? "" : `: ${said}`}`);
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(out);
    } catch {
      throw new ProbeRunnerError(`${tool} exited ${String(r.status)} but wrote no document at the path it was given`);
    }
    const read = readProbeOutput(bytes.toString("utf8"));
    if (!read.ok) throw new ProbeRunnerError(`${tool} wrote a document that is refused (${read.code}): ${read.problem}`);
    if (read.output.plugin.id !== expectedId) {
      throw new ProbeRunnerError(`${tool} measured ${read.output.plugin.id} when asked for ${expectedId}: not judged as the plugin asked for`);
    }
    return { bytes, output: read.output };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The cells a target is measured at: the options' cells, else every rate at `CLAP_SWEEP_FRAMES`. */
export function targetCells(options: Pick<ProbeTargetOptions, "rates" | "cells">): readonly GridCell[] {
  return options.cells ?? options.rates.map((rate) => ({ rate, quantum: CLAP_SWEEP_FRAMES }));
}

/**
 * The probe output of one target over its grid, through the runner: one run per quantum (CLAP) or per cell (LV2),
 * merged into one document (`probe-merge.ts`). Throws {@link ProbeRunnerError} when a run leaves nothing to judge.
 */
export function probeTarget(target: PluginTarget, options: ProbeTargetOptions): ProbedTarget {
  const parts = runnerInvocations(target.format, targetCells(options)).map((invocation) => ({ ...runOne(target, options, invocation), invocation }));
  try {
    return mergeProbeRuns(parts, options.memory);
  } catch (e) {
    if (e instanceof ProbeMergeError) throw new ProbeRunnerError(e.message);
    throw e;
  }
}

/** What the pass over a run's targets produced. */
export interface ProbePass {
  /** Every probe output that was judged, with its bytes, for the qualification directory. */
  readonly runs: readonly { readonly bytes: Buffer; readonly judgment: Judgment }[];
  readonly verdicts: readonly QualifyVerdict[];
  /** The CLAP documents of today's judge, which the pins file is taken from. */
  readonly documents: readonly RtSafetyDocument[];
  /** Each target that could not be measured, with why; its verdict rows read `unknown`, unmeasured. */
  readonly failures: readonly { readonly uri: string; readonly problem: string }[];
}

/**
 * Measure every target through the runner, one run per target and set of offered extensions (a crash
 * takes only that plugin), and judge each probe output under the profiles whose offer it was taken
 * with. A CLAP profile the prober cannot stand in for is judged from the run with no offer and reads
 * `unknown` there, as before. An LV2 plugin has one run for every profile.
 */
export function qualifyTargets(
  targets: readonly PluginTarget[],
  options: ProbeTargetOptions & {
    readonly profiles?: readonly HostProfile[];
    readonly admissions?: AdmissionRuns;
    /**
     * The LV2 directories the hosts of an admission see (`LV2_PATH`), the device's as the sync's settings name them;
     * absent, they get the run's environment as it is.
     */
    readonly admissionLv2Path?: readonly string[];
    /** How the grid is chosen; with it, each target's cells come from the hosts it is judged under. */
    readonly grid?: GridSpec;
    /** The quanta of a `full` grid; else `QUALIFY_QUANTA`. */
    readonly quanta?: readonly number[];
    /** At most this many cells a plugin, the first of the grid's order; 0 or absent is every cell. */
    readonly cellsPerPluginBudget?: number;
  },
): ProbePass {
  const profiles = options.profiles ?? [OPENMIXER_CONSOLE_PROFILE];
  const admissionRuns = options.admissions ?? SPAWNED_ADMISSIONS;
  const runEnvironment = options.env ?? process.env;
  const admissionEnv = options.admissionLv2Path === undefined ? runEnvironment : { ...runEnvironment, LV2_PATH: options.admissionLv2Path.join(":") };
  const runs: { bytes: Buffer; judgment: Judgment }[] = [];
  const verdicts: QualifyVerdict[] = [];
  const documents: RtSafetyDocument[] = [];
  const failures: { uri: string; problem: string }[] = [];
  for (const target of targets) {
    const byOffer = new Map<string, { offer: readonly string[]; profiles: HostProfile[] }>();
    // the record carries the console's two tiers whatever hosts were asked about, so they are judged too
    const tierProfiles = [IN_PROCESS_TIER_HOST, ISOLATED_TIER_HOST[target.format]]
      .flatMap((id) => (id === undefined ? [] : [shippedHostProfile(id)]))
      .filter((p): p is HostProfile => p !== undefined);
    const judgedProfiles = [...profiles, ...tierProfiles.filter((t) => !profiles.some((p) => p.id === t.id))];
    const cells =
      options.grid === undefined
        ? options.cells
        : gridCells(options.grid, { rates: options.rates, quanta: options.quanta ?? QUALIFY_QUANTA, hosts: judgedProfiles.map((p) => ({ rate: p.cost.rate, quantum: p.cost.quantum })) });
    const measured = cells === undefined ? {} : { cells: budgetCells(cells, options.cellsPerPluginBudget) };
    // an LV2 plugin is run under each measured host once, whichever probe output it is judged with
    const admissions: Record<string, HostAdmission> = {};
    // an LV2 plugin is also run once under plugin-hostd's LV2 adapter, recorded beside the verdicts (#223)
    const adapter = target.format === "lv2" ? admitUnderAdapter(target.uri, admissionRuns, admissionEnv) : undefined;
    if (target.format === "lv2") {
      for (const profile of judgedProfiles) {
        const host = admittedHostOf(profile);
        if (host !== undefined) admissions[profile.id] = admitPlugin(host, target.uri, admissionRuns, admissionEnv);
      }
    }
    for (const profile of judgedProfiles) {
      const offer = target.format === "clap" ? (proberOffer(profile) ?? []) : [];
      const key = offer.join(",");
      const entry = byOffer.get(key) ?? { offer, profiles: [] };
      entry.profiles.push(profile);
      byOffer.set(key, entry);
    }
    const judged = new Map<string, QualifyVerdict>();
    // a target's runs and documents count only when every one of its runs gave a probe output: one that
    // failed leaves the target not measured, and then nothing of it is recorded or pinned
    const targetRuns: { bytes: Buffer; judgment: Judgment }[] = [];
    try {
      for (const { offer, profiles: forOffer } of byOffer.values()) {
        const probed = probeTarget(target, { ...options, ...measured, offer });
        const plain = judgeProbeOutput(probed.output, forOffer, { admissions });
        const judgment = adapter === undefined ? plain : { ...plain, adapter };
        targetRuns.push({ bytes: probed.bytes, judgment });
        for (const v of judgmentVerdicts(judgment)) judged.set(v.host, v);
      }
    } catch (e) {
      if (!(e instanceof ProbeRunnerError) && !(e instanceof ClapQualifyError)) throw e;
      failures.push({ uri: target.uri, problem: e.message });
      for (const profile of profiles) {
        // no probe output means no record, but a host that refused the plugin when it was run is still a measured refusal
        const a = admissions[profile.id];
        verdicts.push(
          a !== undefined && a.measured && !a.admitted
            ? { uri: target.uri, host: profile.id, measured: true, rating: "unsuitable", qualified: false, deciding: a.code ?? `${a.host}.not-admitted` }
            : { uri: target.uri, host: profile.id, measured: false, rating: "unknown", qualified: false, deciding: "not-measured" },
        );
      }
      continue;
    }
    for (const r of targetRuns) {
      runs.push(r);
      documents.push(...r.judgment.documents);
    }
    for (const profile of profiles) verdicts.push(judged.get(profile.id)!);
  }
  return { runs, verdicts, documents, failures };
}
