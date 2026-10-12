// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The CLAP arm of the one qualifier. `native/clap-qualify` loads a `.clap` under the interposer
 * (`native/rt_interpose.so`), sweeps each plugin at every rate and prints what it MEASURED, one
 * JSON line per plugin; this module runs it, reads those lines strictly, and turns each into the
 * RT-safety verdict document: the binary's SHA-256, the console it was judged for, and the verdict
 * of the `rtSafety` dimension from the same rules `classifyPluginHosting` folds
 * ({@link rtSafetyReasons}, {@link clapRtReasons}) — never a second judge. A line that cannot be
 * read, a prober that is absent, crashed or timed out, is a {@link ClapQualifyError}: nothing was
 * measured, and nothing is rated.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import {
  CLAP_QUALIFY_TIMEOUT_S,
  CLAP_QUALIFY_TOOL_ENV,
  CLAP_QUALIFY_TOOL_NAME,
  CLAP_SWEEP_BLOCKS,
  CLAP_SWEEP_FRAMES,
  RT_INTERPOSE_ENV,
  RT_INTERPOSE_NAME,
} from "./qualify-declarations.js";
import {
  HOSTING_CODE,
  clapRtReasons,
  contributedHostingRating,
  rtSafetyReasons,
  type HostingReason,
  type PluginClapMeasurement,
  type PluginRtSafetyMeasurement,
} from "./hosting-suitability.js";
import { OPENMIXER_CONSOLE_PROFILE, type HostProfile } from "./host-profiles.js";
import type { PluginTarget } from "./loader.js";
import type { QualifyVerdict } from "./qualify-cli.js";
import { RATING_SEVERITY, worstRating, type SuitabilityRating } from "./rating.js";
import { nativeToolCandidates } from "./tool-paths.js";
import { readIntegrity, type IntegrityMeasurement } from "./measurement/format.js";

export class ClapQualifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClapQualifyError";
  }
}

// --- the prober's line ---------------------------------------------------------------------------

/** What the interposer counted; `interposer: false` is a run without it, which counts nothing. */
export interface ClapRtSafetyReading extends PluginRtSafetyMeasurement {
  /** The first events the interposer recorded inside `process()`, by libc call (`malloc`, `pthread_mutex_lock`, ...). */
  readonly events?: readonly string[];
}

/** The CLAP facts as the prober printed them: the measurement, and whether any output was not finite. */
export interface ClapProbedFacts extends PluginClapMeasurement {
  readonly nonFinite: boolean;
}

/** One plugin's line from `clap-qualify`. */
export interface ClapQualifyLine {
  readonly uri: string;
  readonly id: string;
  readonly binary: { readonly path: string; readonly sha256: string };
  /** The host extensions the prober offered; the verdict's headless pass holds only for these. */
  readonly hostExtensions: readonly string[];
  readonly clap: ClapProbedFacts;
  readonly rtSafety: ClapRtSafetyReading;
  /**
   * The pin (spec §11): the `.clap`'s digest by its name in its directory and the layout fingerprint
   * the prober computed through plugin-hostd's `pin.h`, or the reason it took none.
   */
  readonly integrity: IntegrityMeasurement;
}

const SHA256 = /^[0-9a-f]{64}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return Object.prototype.toString.call(v) === "[object Object]";
}

function bad(what: string): never {
  throw new ClapQualifyError(`clap-qualify printed a line that is not its document: ${what}`);
}

function str(o: Record<string, unknown>, key: string, where: string): string {
  const v = o[key];
  return typeof v === "string" ? v : bad(`${where} has no string ${key}`);
}

function count(o: Record<string, unknown>, key: string, where: string): number {
  const v = o[key];
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : bad(`${where} has no count ${key}`);
}

function bool(o: Record<string, unknown>, key: string, where: string): boolean {
  const v = o[key];
  return typeof v === "boolean" ? v : bad(`${where} has no boolean ${key}`);
}

function strings(o: Record<string, unknown>, key: string, where: string): string[] {
  const v = o[key];
  if (!Array.isArray(v)) return bad(`${where} has no list ${key}`);
  return v.map((s) => (typeof s === "string" ? s : bad(`${where} ${key} holds something that is not a string`)));
}

function readClap(v: unknown): ClapProbedFacts {
  if (!isRecord(v)) return bad("no clap facts");
  const latencyIn = v["latency"];
  if (!isRecord(latencyIn)) return bad("clap has no latency map");
  const latency: Record<string, { declaredFrames: number; measuredFrames: number }> = {};
  for (const [rate, at] of Object.entries(latencyIn)) {
    if (!/^[1-9]\d*$/.test(rate) || !isRecord(at)) return bad(`clap latency at ${rate}`);
    latency[rate] = { declaredFrames: count(at, "declaredFrames", `latency ${rate}`), measuredFrames: count(at, "measuredFrames", `latency ${rate}`) };
  }
  return {
    mainInputChannels: count(v, "mainInputChannels", "clap"),
    mainOutputChannels: count(v, "mainOutputChannels", "clap"),
    sidechainInputs: count(v, "sidechainInputs", "clap"),
    features: strings(v, "features", "clap"),
    headlessOk: bool(v, "headlessOk", "clap"),
    noteInputs: count(v, "noteInputs", "clap"),
    latency,
    threadViolations: count(v, "threadViolations", "clap"),
    processErrors: count(v, "processErrors", "clap"),
    processCalls: count(v, "processCalls", "clap"),
    nonFinite: bool(v, "nonFinite", "clap"),
  };
}

function readRtSafety(v: unknown): ClapRtSafetyReading {
  if (!isRecord(v)) return bad("no rtSafety");
  if (!bool(v, "interposer", "rtSafety")) return { interposer: false };
  return {
    interposer: true,
    swept: bool(v, "swept", "rtSafety"),
    sweepApplicable: bool(v, "sweepApplicable", "rtSafety"),
    blocks: count(v, "blocks", "rtSafety"),
    blockFrames: count(v, "blockFrames", "rtSafety"),
    allocationsInRun: count(v, "allocationsInRun", "rtSafety"),
    locksInRun: count(v, "locksInRun", "rtSafety"),
    syscallsInRun: count(v, "syscallsInRun", "rtSafety"),
    events: strings(v, "events", "rtSafety"),
  };
}

/** One line of the prober's stdout, or a {@link ClapQualifyError} saying how it differs. */
export function parseClapQualifyLine(text: string): ClapQualifyLine {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return bad("not JSON");
  }
  if (!isRecord(v)) return bad("not an object");
  if (v["format"] !== "clap") return bad(`format is ${JSON.stringify(v["format"])}`);
  const id = str(v, "id", "the line");
  const uri = str(v, "uri", "the line");
  if (uri !== `urn:clap:${id}`) return bad(`uri ${uri} is not urn:clap:${id}`);
  const binary = v["binary"];
  if (!isRecord(binary)) return bad("no binary");
  const sha256 = str(binary, "sha256", "binary");
  if (!SHA256.test(sha256)) return bad(`binary sha256 ${sha256} is not 64 lowercase hex digits`);
  return {
    uri,
    id,
    binary: { path: str(binary, "path", "binary"), sha256 },
    hostExtensions: strings(v, "hostExtensions", "the line"),
    clap: readClap(v["clap"]),
    rtSafety: readRtSafety(v["rtSafety"]),
    integrity: readIntegrity(v["integrity"]) ?? bad("no integrity"),
  };
}

/** Every non-empty line of the prober's stdout. */
export function parseClapQualifyOutput(stdout: string): ClapQualifyLine[] {
  return stdout.split("\n").filter((l) => l.trim() !== "").map(parseClapQualifyLine);
}

// --- the verdict document ------------------------------------------------------------------------

/** The document's schema name; a reader refuses any other. */
export const RT_SAFETY_DOCUMENT_SCHEMA = "plugin-qualify.rt-safety/1";

/**
 * The RT-safety verdict of one plugin binary for one console: keyed by the binary's SHA-256 and
 * the host profile id, so a verdict never outlives the bytes it was measured on. `measured` is what
 * the prober printed, raw; `verdict` is the `rtSafety` dimension's worst-wins fold of it.
 */
export interface RtSafetyDocument {
  readonly schema: typeof RT_SAFETY_DOCUMENT_SCHEMA;
  readonly plugin: {
    readonly uri: string;
    readonly format: "clap";
    readonly binary: { readonly path: string; readonly sha256: string };
  };
  /** The host profile the verdict is for. */
  readonly console: string;
  readonly verdict: {
    readonly rating: SuitabilityRating;
    /** `rating === "suitable"` — in-process only with it. */
    readonly rtSafe: boolean;
    /** The ONE reason that decided it; absent when suitable. */
    readonly deciding?: HostingReason;
    readonly reasons: readonly HostingReason[];
  };
  readonly measured: {
    readonly hostExtensions: readonly string[];
    readonly clap: ClapProbedFacts;
    readonly rtSafety: ClapRtSafetyReading;
    readonly integrity: IntegrityMeasurement;
  };
}

/**
 * The verdict document for one prober line under one host profile. The interposer's counts and the
 * two violations only a CLAP commits decide it. The line is judged against the profile's own CLAP
 * host extensions: a line from a prober that offered others is not that host's measurement, and a
 * host with no CLAP path has none; both read `unknown`.
 */
export function rtSafetyDocument(line: ClapQualifyLine, profile: HostProfile = OPENMIXER_CONSOLE_PROFILE): RtSafetyDocument {
  const offered = profile.clapExtensions;
  const offeredAsProfile =
    offered !== null && line.hostExtensions.length === offered.length && offered.every((e) => line.hostExtensions.includes(e));
  const reasons: HostingReason[] =
    offered === null
      ? [{ dimension: "rtSafety", kind: "objective", rating: "unknown", code: HOSTING_CODE.clapFormatNotHosted, params: {} }]
      : offeredAsProfile
        ? [...rtSafetyReasons(line.rtSafety), ...clapRtReasons(line.clap)]
        : [
            {
              dimension: "rtSafety",
              kind: "objective",
              rating: "unknown",
              code: HOSTING_CODE.clapExtensionsNotCovered,
              params: { extensions: line.hostExtensions.join(" ") },
            },
          ];
  const rating = worstRating(reasons.map(contributedHostingRating));
  const deciding = [...reasons]
    .sort((a, b) => RATING_SEVERITY[contributedHostingRating(b)] - RATING_SEVERITY[contributedHostingRating(a)])
    .find((r) => contributedHostingRating(r) === rating);
  return {
    schema: RT_SAFETY_DOCUMENT_SCHEMA,
    plugin: { uri: line.uri, format: "clap", binary: line.binary },
    console: profile.id,
    verdict: { rating, rtSafe: rating === "suitable", ...(rating === "suitable" || deciding === undefined ? {} : { deciding }), reasons },
    measured: { hostExtensions: line.hostExtensions, clap: line.clap, rtSafety: line.rtSafety, integrity: line.integrity },
  };
}

/** The document as the CLI's verdict row. */
export function rtSafetyVerdict(doc: RtSafetyDocument): QualifyVerdict {
  return {
    uri: doc.plugin.uri,
    host: doc.console,
    measured: true,
    rating: doc.verdict.rating,
    qualified: doc.verdict.rtSafe,
    ...(doc.verdict.deciding === undefined ? {} : { deciding: doc.verdict.deciding.code }),
  };
}

/** Where a document is written in `--out`: one file per binary and console. */
export function rtSafetyDocumentName(doc: RtSafetyDocument): string {
  return `${doc.plugin.binary.sha256}.${doc.console}.rt-safety.json`;
}

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
}

/** One native tool: its setting when set, else the first candidate that exists. Absent, it throws, naming where it looked. */
function locate(
  env: Readonly<Record<string, string | undefined>>,
  what: string,
  name: string,
  file: string,
  exists: (path: string) => boolean,
): string {
  const v = env[name];
  const looked = v === undefined || v === "" ? nativeToolCandidates(file) : [v];
  const path = looked.find((p) => exists(p));
  if (path === undefined) {
    throw new ClapQualifyError(`no CLAP ${what} at ${looked.join(", ")}: install the plugin-qualify package, build it with make -C native, or set ${name}`);
  }
  return path;
}

/**
 * The prober and the interposer this run uses: each its setting, else the first of the installed
 * directories (`NATIVE_TOOL_DIRS`) that holds it, else the package's own build.
 */
export function clapQualifyTools(
  env: Readonly<Record<string, string | undefined>>,
  exists: (path: string) => boolean = existsSync,
): { tool: string; interposer: string } {
  return {
    tool: locate(env, "prober", CLAP_QUALIFY_TOOL_ENV, CLAP_QUALIFY_TOOL_NAME, exists),
    interposer: locate(env, "interposer", RT_INTERPOSE_ENV, RT_INTERPOSE_NAME, exists),
  };
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
 * Qualify every CLAP target, one prober run per target (a crash takes only that plugin), and judge
 * each line under every host profile. A target without a binary path (a bare `urn:clap:` id) has
 * nothing to load and is a failure, never a pass.
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
    let lines: ClapQualifyLine[];
    try {
      if (target.binaryPath === undefined) throw new ClapQualifyError(`${target.uri}: no .clap to load; name the file or a directory holding it`);
      lines = qualifyClap(target.binaryPath, id, options);
    } catch (e) {
      if (!(e instanceof ClapQualifyError)) throw e;
      failures.push({ uri: target.uri, problem: e.message });
      for (const profile of profiles) {
        verdicts.push({ uri: target.uri, host: profile.id, measured: false, rating: "unknown", qualified: false, deciding: "not-measured" });
      }
      continue;
    }
    for (const line of lines) {
      for (const profile of profiles) {
        const doc = rtSafetyDocument(line, profile);
        documents.push(doc);
        verdicts.push(rtSafetyVerdict(doc));
      }
    }
  }
  return { documents, verdicts, failures };
}
