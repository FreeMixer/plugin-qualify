// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The prober run DIRECTLY, as the tests need it: `native/clap-qualify` under the interposer, its line
 * read, no runner in between. This is what plugin-hostd's probe runner starts as its child, so the live
 * tests of the prober and of the verdict fold use it to see the prober's own line.
 *
 * Not part of the package: the command line never calls the prober itself any more, it calls the runner
 * (`probe-runner.ts`), which keeps the wall clock, the limits and the process tree. The spawn here has a
 * timeout only so that a hung test cannot hang the suite.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import {
  ClapQualifyError,
  clapQualifyTools,
  parseClapQualifyOutput,
  proberOffer,
  rtSafetyDocument,
  rtSafetyVerdict,
  type ClapQualifyLine,
  type RtSafetyDocument,
} from "./clap-qualify.js";
import type { HostProfile } from "./host-profiles.js";
import { OPENMIXER_CONSOLE_PROFILE } from "./host-profiles.js";
import type { PluginTarget } from "./loader.js";
import type { QualifyVerdict } from "./qualify-cli.js";
import { CLAP_QUALIFY_TIMEOUT_S, CLAP_SWEEP_BLOCKS, CLAP_SWEEP_FRAMES } from "./qualify-declarations.js";

// --- running the prober --------------------------------------------------------------------------

/** What a run of the prober gave back; `error` is a spawn failure, `signal` a death. */
export interface ClapQualifyRunResult {
  readonly status: number | null;
  readonly signal?: string | null;
  readonly stdout: string;
  readonly stderr?: string;
  readonly error?: Error;
}

export type ClapQualifyRun = (
  tool: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
) => ClapQualifyRunResult;

const spawnQualify: ClapQualifyRun = (tool, args, env, timeoutMs) => {
  const r = spawnSync(tool, [...args], { encoding: "utf8", env: { ...env }, timeout: timeoutMs, maxBuffer: 64 << 20 });
  return {
    status: r.status,
    signal: r.signal,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    ...(r.error === undefined ? {} : { error: r.error }),
  };
};

export interface ClapQualifyOptions {
  /** The rates the plugin is activated and swept at. */
  readonly rates: readonly number[];
  /** Runs the prober; the default spawns it. */
  readonly run?: ClapQualifyRun;
  /** Where the two settings are read from; the default is `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Whether a file exists; the default asks the filesystem. */
  readonly exists?: (path: string) => boolean;
  /** The host extensions the prober offers beyond the console's, each one of {@link OMX_CLAP_HOST_CONFIGURED_EXTENSIONS}. */
  readonly offer?: readonly string[];
}

/**
 * Qualify the plugins of one `.clap` (all of them, or the one `id` names) under the interposer.
 * Absent tools, a crash, a timeout, a load failure or an unreadable line throw: none of them is a
 * measurement.
 */
export function qualifyClap(binaryPath: string, id: string | undefined, options: ClapQualifyOptions): ClapQualifyLine[] {
  const env = options.env ?? process.env;
  const { tool, interposer } = clapQualifyTools(env, options.exists ?? existsSync);
  const args = [
    "--rates",
    options.rates.join(","),
    "--block",
    String(CLAP_SWEEP_FRAMES),
    "--blocks",
    String(CLAP_SWEEP_BLOCKS),
    ...(options.offer === undefined || options.offer.length === 0 ? [] : ["--offer", options.offer.join(",")]),
    binaryPath,
    ...(id === undefined ? [] : [id]),
  ];
  const r = (options.run ?? spawnQualify)(tool, args, { ...env, LD_PRELOAD: interposer }, CLAP_QUALIFY_TIMEOUT_S * 1000);
  if (r.error !== undefined) throw new ClapQualifyError(`cannot run ${tool}: ${r.error.message}`);
  if (r.signal) throw new ClapQualifyError(`${binaryPath} killed the prober (${r.signal})`);
  if (r.status !== 0) throw new ClapQualifyError(`${tool} exited ${String(r.status)} on ${binaryPath}: ${(r.stderr ?? "").trim()}`);
  const lines = parseClapQualifyOutput(r.stdout);
  if (lines.length === 0) throw new ClapQualifyError(`${tool} printed nothing for ${binaryPath}`);
  return lines;
}

// --- the CLI's CLAP pass -------------------------------------------------------------------------

/** What the CLAP pass of one run produced: a document per plugin and console, and a row per verdict. */
export interface ClapQualifyPass {
  readonly documents: readonly RtSafetyDocument[];
  readonly verdicts: readonly QualifyVerdict[];
  /** Each target that could not be measured, with why; its verdict rows read `unknown`, unmeasured. */
  readonly failures: readonly { readonly uri: string; readonly problem: string }[];
}

/**
 * Qualify every CLAP target, one prober run per target and set of offered extensions (a crash takes
 * only that plugin), and judge each line under every host profile, from the run that offered that
 * profile's extensions. A target without a binary path (a bare `urn:clap:` id) has nothing to load
 * and is a failure, never a pass.
 */
export function qualifyClapTargets(
  targets: readonly PluginTarget[],
  options: ClapQualifyOptions & { readonly profiles?: readonly HostProfile[] },
): ClapQualifyPass {
  const profiles = options.profiles ?? [OPENMIXER_CONSOLE_PROFILE];
  const documents: RtSafetyDocument[] = [];
  const verdicts: QualifyVerdict[] = [];
  const failures: { uri: string; problem: string }[] = [];
  for (const target of targets) {
    const id = target.uri.startsWith("urn:clap:") ? target.uri.slice("urn:clap:".length) : undefined;
    // one run per distinct offer, the console's (none) for a profile the prober cannot stand in for
    const offers = new Map<string, readonly string[]>();
    for (const profile of profiles) {
      const offer = proberOffer(profile) ?? [];
      offers.set(offer.join(","), offer);
    }
    const runs = new Map<string, ClapQualifyLine[]>();
    try {
      if (target.binaryPath === undefined) throw new ClapQualifyError(`${target.uri}: no .clap to load; name the file or a directory holding it`);
      for (const [key, offer] of offers) runs.set(key, qualifyClap(target.binaryPath, id, { ...options, offer }));
    } catch (e) {
      if (!(e instanceof ClapQualifyError)) throw e;
      failures.push({ uri: target.uri, problem: e.message });
      for (const profile of profiles) {
        verdicts.push({ uri: target.uri, host: profile.id, measured: false, rating: "unknown", qualified: false, deciding: "not-measured" });
      }
      continue;
    }
    for (const profile of profiles) {
      for (const line of runs.get((proberOffer(profile) ?? []).join(","))!) {
        const doc = rtSafetyDocument(line, profile);
        documents.push(doc);
        verdicts.push(rtSafetyVerdict(doc));
      }
    }
  }
  return { documents, verdicts, failures };
}
