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
import type { HostProfile } from "./host-profiles.js";
import { OPENMIXER_CONSOLE_PROFILE } from "./host-profiles.js";
import type { PluginTarget } from "./loader.js";
import { judgeProbeOutput, judgmentVerdicts, type Judgment } from "./probe-judge.js";
import { readProbeOutput, type ProbeOutput } from "./probe-output.js";
import type { QualifyVerdict } from "./qualify-cli.js";
import {
  CLAP_QUALIFY_TIMEOUT_S,
  CLAP_SWEEP_BLOCKS,
  CLAP_SWEEP_FRAMES,
  LV2_HOSTING_BLOCK_FRAMES,
  LV2_HOSTING_TIMEOUT_S,
  PROBE_RUNNER_DEFAULT,
  PROBE_RUNNER_ENV,
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
  /** The rates the plugin is measured at. */
  readonly rates: readonly number[];
  /** Host extensions to offer beyond the prober's own (a CLAP run). */
  readonly offer?: readonly string[];
  readonly run?: ProbeRun;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly exists?: (path: string) => boolean;
}

/** The runner's arguments for a CLAP file; `child` is the prober the runner starts. */
export function clapRunnerArgs(
  options: { rates: readonly number[]; offer?: readonly string[]; out: string; log: string; child: string },
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
    String(CLAP_SWEEP_FRAMES),
    "--blocks",
    String(CLAP_SWEEP_BLOCKS),
    ...(options.offer === undefined || options.offer.length === 0 ? [] : ["--offer", options.offer.join(",")]),
    "--wall-s",
    String(CLAP_QUALIFY_TIMEOUT_S),
    "--out",
    options.out,
    "--log",
    options.log,
    binaryPath,
    ...(id === undefined ? [] : [id]),
  ];
}

/**
 * The runner's arguments for an LV2 plugin, named as `lv2:<uri>` and measured by the runner's own LV2
 * child. The runner of plugin-hostd 0.3 starts a CLAP prober only (plugin-hostd#76 adds the LV2 child), so
 * against it this run ends with the runner's own refusal, which {@link runOne} reports.
 */
export function lv2RunnerArgs(options: { rates: readonly number[]; out: string; log: string }, uri: string): string[] {
  return [
    "run",
    "--rates",
    options.rates.join(","),
    "--quantum",
    String(LV2_HOSTING_BLOCK_FRAMES),
    "--wall-s",
    String(LV2_HOSTING_TIMEOUT_S),
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

function runOne(target: PluginTarget, options: ProbeTargetOptions): ProbedTarget {
  const env = options.env ?? process.env;
  const tool = probeRunnerTool(env);
  const work = mkdtempSync(join(tmpdir(), "plugin-qualify-probe-"));
  const out = join(work, "probe.json");
  const log = join(work, "child.stderr.log");
  try {
    let args: string[];
    let runEnv: Record<string, string | undefined> = { ...env };
    let expectedId: string;
    if (target.format === "clap") {
      if (target.binaryPath === undefined) throw new ProbeRunnerError(`${target.uri}: no .clap to load; name the file or a directory holding it`);
      expectedId = target.uri.startsWith("urn:clap:") ? target.uri.slice("urn:clap:".length) : target.uri;
      const { tool: child, interposer } = clapQualifyTools(env, options.exists ?? existsSync);
      args = clapRunnerArgs({ rates: options.rates, ...(options.offer === undefined ? {} : { offer: options.offer }), out, log, child }, target.binaryPath, expectedId);
      runEnv = { ...env, LD_PRELOAD: interposer };
    } else {
      expectedId = target.uri;
      args = lv2RunnerArgs({ rates: options.rates, out, log }, target.uri);
    }
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

/** The probe output of one target, through the runner. Throws {@link ProbeRunnerError} when there is none to judge. */
export function probeTarget(target: PluginTarget, options: ProbeTargetOptions): ProbedTarget {
  return runOne(target, options);
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
  options: ProbeTargetOptions & { readonly profiles?: readonly HostProfile[] },
): ProbePass {
  const profiles = options.profiles ?? [OPENMIXER_CONSOLE_PROFILE];
  const runs: { bytes: Buffer; judgment: Judgment }[] = [];
  const verdicts: QualifyVerdict[] = [];
  const documents: RtSafetyDocument[] = [];
  const failures: { uri: string; problem: string }[] = [];
  for (const target of targets) {
    const byOffer = new Map<string, { offer: readonly string[]; profiles: HostProfile[] }>();
    for (const profile of profiles) {
      const offer = target.format === "clap" ? (proberOffer(profile) ?? []) : [];
      const key = offer.join(",");
      const entry = byOffer.get(key) ?? { offer, profiles: [] };
      entry.profiles.push(profile);
      byOffer.set(key, entry);
    }
    const judged = new Map<string, QualifyVerdict>();
    try {
      for (const { offer, profiles: forOffer } of byOffer.values()) {
        const probed = probeTarget(target, { ...options, offer });
        const judgment = judgeProbeOutput(probed.output, forOffer);
        runs.push({ bytes: probed.bytes, judgment });
        documents.push(...judgment.documents);
        for (const v of judgmentVerdicts(judgment)) judged.set(v.host, v);
      }
    } catch (e) {
      if (!(e instanceof ProbeRunnerError) && !(e instanceof ClapQualifyError)) throw e;
      failures.push({ uri: target.uri, problem: e.message });
      for (const profile of profiles) {
        verdicts.push({ uri: target.uri, host: profile.id, measured: false, rating: "unknown", qualified: false, deciding: "not-measured" });
      }
      continue;
    }
    for (const profile of profiles) verdicts.push(judged.get(profile.id)!);
  }
  return { runs, verdicts, documents, failures };
}
