// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The reader of plugin-hostd's probe output (`plugin-hostd.probe-output`): the document
 * `plugin-hostd-probe run` writes about one plugin binary and one offer. It holds facts only, so
 * this module reads and checks; it never judges (`probe-judge.ts` does).
 *
 * The reader is structural, as `measurement/probe-json.ts` is: it validates what plugin-qualify
 * needs and ignores the rest, so a newer minor of the format, which only adds fields, still reads.
 * It refuses three things, each with a code that is never reworded:
 *
 * - `probe.format.major-unknown`: a major version this reader does not know. The check comes
 *   before the content is looked at, since a new major may change what the content means.
 * - `probe.format.derived-mismatch`: `machine.class.cstatesLimited` or `machine.profile.meetsProtocol`
 *   disagrees with the fields they are computed from. Both are kept in the document because the
 *   machine class is shared; neither is trusted, both are recomputed here.
 * - `probe.format.invalid`: anything else that is not the document: not JSON, a verdict inside it
 *   (the format has no field for one), a missing required block, a malformed figure.
 */
import { createHash } from "node:crypto";

import { finiteNumber, isRecord, nonEmptyString, optional } from "./measurement/guards.js";
import { readVoicesHeld, type VoicesHeld } from "./measurement/format.js";

export const PROBE_OUTPUT_FORMAT = "plugin-hostd.probe-output";
/** The one major this reader knows. A minor of it only adds fields. */
export const PROBE_OUTPUT_MAJOR = 1;

export const PROBE_FORMAT_CODE = {
  majorUnknown: "probe.format.major-unknown",
  derivedMismatch: "probe.format.derived-mismatch",
  invalid: "probe.format.invalid",
} as const;
export type ProbeFormatCode = (typeof PROBE_FORMAT_CODE)[keyof typeof PROBE_FORMAT_CODE];

/** The outcome that means a step ran to its end. */
export const PROBE_OK = "probe.ok";
export const PROBE_NOT_ATTEMPTED = "probe.not-attempted";

/**
 * An exit-latency above this many microseconds makes an idle state deep. The runner writes the
 * document by this rule, so the reader recomputes by it; the protocol document will state it
 * (plugin-hostd#78) and this number follows that document.
 */
export const DEEP_IDLE_LATENCY_US = 20;

/** The keys the format has no room for: a document holding one is a judgment, not a fact. */
const JUDGMENT_KEYS = ["verdict", "verdicts", "rating", "hosting"] as const;

const SHA256 = /^[0-9a-f]{64}$/;
const OUTCOME = /^probe\.[a-z][a-z0-9.-]*$/;

export interface ProbeFile {
  readonly path: string;
  readonly sha256: string;
}

export interface ProbeCost {
  readonly median: number;
  /** The percentile the figure is taken at, and its value, in nanoseconds per sample. */
  readonly percentile: { readonly p: number; readonly value: number };
  readonly blocks: number;
  readonly warmupBlocks: number;
  /** For an instrument: the notes it held while it was timed, how many and why that many. */
  readonly voices?: VoicesHeld;
}

export interface ProbeRtSafety {
  readonly interposer: boolean;
  readonly swept?: boolean;
  readonly sweepApplicable?: boolean;
  readonly blocks?: number;
  readonly allocations?: number;
  readonly locks?: number;
  readonly syscalls?: number;
  readonly threadViolations?: number;
  readonly processErrors?: number;
  readonly events?: readonly string[];
}

export interface ProbeNoteSweep {
  readonly applicable: boolean;
  readonly dialect?: string;
  readonly allocations?: number;
  readonly locks?: number;
  readonly syscalls?: number;
}

/** One point of the protocol's grid: the figures at one rate and one quantum. */
export interface ProbeGridPoint {
  readonly rate: number;
  readonly quantum: number;
  readonly outcome: string;
  readonly latency?: { readonly declaredFrames: number; readonly measuredFrames: number };
  readonly cost?: ProbeCost;
  readonly rtSafety?: ProbeRtSafety;
  readonly noteSweep?: ProbeNoteSweep;
}

export interface ProbeStep {
  readonly step: string;
  readonly outcome: string;
  readonly rate?: number;
  readonly quantum?: number;
  readonly detail?: string;
}

export interface ProbeIdleState {
  readonly cpu: number;
  readonly state: string;
  readonly latencyUs: number;
  readonly disabled: boolean;
  readonly usageDelta: number;
}

export interface ProbeOutput {
  readonly formatVersion: string;
  readonly run: {
    readonly id: string;
    readonly startedAt: string;
    readonly elapsedMs: number;
    readonly complete: boolean;
    readonly outcome: string;
    readonly reason?: string;
    readonly protocol: { readonly name: string; readonly version: number };
    readonly tools: Readonly<Record<string, string>>;
    readonly via: string;
  };
  readonly plugin: {
    readonly format: "clap" | "lv2";
    readonly id: string;
    readonly name?: string;
    readonly version?: string;
  };
  readonly binary: {
    readonly path: string;
    readonly sha256: string;
    readonly files: readonly ProbeFile[];
    readonly layout?: { readonly scheme: string; readonly sha256: string };
    /** Why the files cannot be pinned, when they cannot. */
    readonly unpinnable?: string;
  };
  readonly machine: {
    readonly class: Readonly<Record<string, string | boolean>>;
    readonly profile: {
      readonly governor: string | null;
      readonly cpuidle: readonly ProbeIdleState[];
      readonly meetsProtocol: boolean;
      readonly unmet: readonly string[];
    };
    readonly pinnedCpus: string;
  };
  readonly offer: { readonly id: string; readonly clapExtensions?: readonly string[] };
  readonly steps: readonly ProbeStep[];
  readonly grid: readonly ProbeGridPoint[];
  /** What the document says about how the plugin behaves, as it was written. */
  readonly behaviour?: Readonly<Record<string, unknown>>;
}

export type ReadProbeOutputResult =
  | { readonly ok: true; readonly output: ProbeOutput }
  | { readonly ok: false; readonly code: ProbeFormatCode; readonly problem: string };

class Refusal extends Error {
  constructor(
    readonly code: ProbeFormatCode,
    message: string,
  ) {
    super(message);
  }
}

function invalid(what: string): never {
  throw new Refusal(PROBE_FORMAT_CODE.invalid, what);
}

function record(v: unknown, where: string): Record<string, unknown> {
  return isRecord(v) ? v : invalid(`${where} is not an object`);
}

function str(o: Record<string, unknown>, key: string, where: string): string {
  return nonEmptyString(o[key]) ?? invalid(`${where} has no ${key}`);
}

function bool(o: Record<string, unknown>, key: string, where: string): boolean {
  const v = o[key];
  return typeof v === "boolean" ? v : invalid(`${where} has no boolean ${key}`);
}

function num(o: Record<string, unknown>, key: string, where: string): number {
  return finiteNumber(o[key]) ?? invalid(`${where} has no number ${key}`);
}

function posInt(o: Record<string, unknown>, key: string, where: string): number {
  const v = o[key];
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : invalid(`${where} has no positive integer ${key}`);
}

function count(o: Record<string, unknown>, key: string, where: string): number {
  const v = o[key];
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : invalid(`${where} has no count ${key}`);
}

function optCount(o: Record<string, unknown>, key: string, where: string): number | undefined {
  return o[key] === undefined ? undefined : count(o, key, where);
}

function optBool(o: Record<string, unknown>, key: string, where: string): boolean | undefined {
  return o[key] === undefined ? undefined : bool(o, key, where);
}

function outcome(o: Record<string, unknown>, where: string): string {
  const v = str(o, "outcome", where);
  return OUTCOME.test(v) ? v : invalid(`${where} outcome ${v} is not a probe code`);
}

function list(o: Record<string, unknown>, key: string, where: string): unknown[] {
  const v = o[key];
  return Array.isArray(v) ? v : invalid(`${where} has no list ${key}`);
}

function sha(o: Record<string, unknown>, key: string, where: string): string {
  const v = str(o, key, where);
  return SHA256.test(v) ? v : invalid(`${where} ${key} is not 64 lowercase hex digits`);
}

/** The strings of a list that holds nothing else, or `undefined`. */
function stringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") return undefined;
    out.push(item);
  }
  return out;
}

function readCost(v: unknown, where: string): ProbeCost {
  const o = record(v, where);
  const pct = record(o["percentile"], `${where} percentile`);
  const p = num(pct, "p", `${where} percentile`);
  if (!(p > 50 && p <= 100)) invalid(`${where} percentile p ${p} is outside (50, 100]`);
  const median = num(o, "median", where);
  const value = num(pct, "value", `${where} percentile`);
  if (median < 0 || value < 0) invalid(`${where} holds a negative cost`);
  const voices = o["voices"] === undefined ? undefined : readVoicesHeld(o["voices"]);
  if (o["voices"] !== undefined && voices === undefined) invalid(`${where} voices is not a count of held notes with its basis`);
  return {
    median,
    percentile: { p, value },
    blocks: posInt(o, "blocks", where),
    warmupBlocks: count(o, "warmupBlocks", where),
    ...(voices === undefined ? {} : { voices }),
  };
}

function readRtSafety(v: unknown, where: string): ProbeRtSafety {
  const o = record(v, where);
  const events = o["events"] === undefined ? undefined : (stringList(o["events"]) ?? invalid(`${where} events is not a list of strings`));
  return {
    interposer: bool(o, "interposer", where),
    ...optional("swept", optBool(o, "swept", where)),
    ...optional("sweepApplicable", optBool(o, "sweepApplicable", where)),
    ...optional("blocks", optCount(o, "blocks", where)),
    ...optional("allocations", optCount(o, "allocations", where)),
    ...optional("locks", optCount(o, "locks", where)),
    ...optional("syscalls", optCount(o, "syscalls", where)),
    ...optional("threadViolations", optCount(o, "threadViolations", where)),
    ...optional("processErrors", optCount(o, "processErrors", where)),
    ...optional("events", events),
  };
}

function readNoteSweep(v: unknown, where: string): ProbeNoteSweep {
  const o = record(v, where);
  return {
    applicable: bool(o, "applicable", where),
    ...optional("dialect", nonEmptyString(o["dialect"])),
    ...optional("allocations", optCount(o, "allocations", where)),
    ...optional("locks", optCount(o, "locks", where)),
    ...optional("syscalls", optCount(o, "syscalls", where)),
  };
}

function readPoint(v: unknown, i: number): ProbeGridPoint {
  const where = `grid[${i}]`;
  const o = record(v, where);
  const latencyIn = o["latency"];
  let latency: ProbeGridPoint["latency"];
  if (latencyIn !== undefined) {
    const l = record(latencyIn, `${where} latency`);
    latency = { declaredFrames: count(l, "declaredFrames", `${where} latency`), measuredFrames: count(l, "measuredFrames", `${where} latency`) };
  }
  return {
    rate: posInt(o, "rate", where),
    quantum: posInt(o, "quantum", where),
    outcome: outcome(o, where),
    ...optional("latency", latency),
    ...(o["cost"] === undefined ? {} : { cost: readCost(o["cost"], `${where} cost`) }),
    ...(o["rtSafety"] === undefined ? {} : { rtSafety: readRtSafety(o["rtSafety"], `${where} rtSafety`) }),
    ...(o["noteSweep"] === undefined ? {} : { noteSweep: readNoteSweep(o["noteSweep"], `${where} noteSweep`) }),
  };
}

function readStep(v: unknown, i: number): ProbeStep {
  const where = `steps[${i}]`;
  const o = record(v, where);
  return {
    step: str(o, "step", where),
    outcome: outcome(o, where),
    ...optional("rate", o["rate"] === undefined ? undefined : posInt(o, "rate", where)),
    ...optional("quantum", o["quantum"] === undefined ? undefined : posInt(o, "quantum", where)),
    ...optional("detail", nonEmptyString(o["detail"])),
  };
}

function readIdle(v: unknown, i: number): ProbeIdleState {
  const where = `machine.profile.cpuidle[${i}]`;
  const o = record(v, where);
  return {
    cpu: count(o, "cpu", where),
    state: str(o, "state", where),
    latencyUs: count(o, "latencyUs", where),
    disabled: bool(o, "disabled", where),
    usageDelta: count(o, "usageDelta", where),
  };
}

/** Whether any idle state deeper than {@link DEEP_IDLE_LATENCY_US} is enabled: then the machine does not limit its C-states. */
export function deepIdleEnabled(cpuidle: readonly ProbeIdleState[]): boolean {
  return cpuidle.some((s) => s.latencyUs > DEEP_IDLE_LATENCY_US && !s.disabled);
}

/** Whether a deep idle state was entered while the run measured. */
export function deepIdleEntered(cpuidle: readonly ProbeIdleState[]): boolean {
  return cpuidle.some((s) => s.latencyUs > DEEP_IDLE_LATENCY_US && s.usageDelta > 0);
}

const PROFILE_GOVERNOR = "probe.profile.governor";
const PROFILE_DEEP_IDLE = "probe.profile.deep-idle-entered";

/**
 * The two derived fields, recomputed. `cstatesLimited` is "idle states are read and none deeper than
 * the limit is enabled", and it cannot hold when a deep state was entered. `meetsProtocol` is the
 * performance governor, no deep state entered and nothing else unmet: the codes the reader can
 * recompute (`probe.profile.governor`, `probe.profile.deep-idle-entered`) must be in `unmet`, and the
 * flag is true exactly when `unmet` is empty. A code the reader cannot recompute (the pinning, the
 * turbo and SMT readings) is taken as the runner wrote it.
 */
function checkDerived(machine: ProbeOutput["machine"]): void {
  const idle = machine.profile.cpuidle;
  const limited = idle.length > 0 && !deepIdleEnabled(idle);
  const claimed = machine.class["cstatesLimited"];
  if (claimed !== limited) {
    throw new Refusal(
      PROBE_FORMAT_CODE.derivedMismatch,
      `machine.class.cstatesLimited is ${String(claimed)} but cpuidle[] gives ${String(limited)}`,
    );
  }
  const { governor, unmet, meetsProtocol } = machine.profile;
  const required = [...(governor === "performance" ? [] : [PROFILE_GOVERNOR]), ...(deepIdleEntered(idle) ? [PROFILE_DEEP_IDLE] : [])];
  const missing = required.filter((code) => !unmet.includes(code));
  if (missing.length > 0) {
    throw new Refusal(PROBE_FORMAT_CODE.derivedMismatch, `machine.profile.unmet lacks ${missing.join(", ")}, which governor and cpuidle[] give`);
  }
  if (meetsProtocol !== (unmet.length === 0)) {
    throw new Refusal(
      PROBE_FORMAT_CODE.derivedMismatch,
      `machine.profile.meetsProtocol is ${String(meetsProtocol)} but unmet[] holds ${unmet.length} code${unmet.length === 1 ? "" : "s"}`,
    );
  }
}

function readMachine(v: unknown): ProbeOutput["machine"] {
  const o = record(v, "machine");
  const cls = record(o["class"], "machine.class");
  const klass: Record<string, string | boolean> = {};
  for (const [k, value] of Object.entries(cls)) if (typeof value === "string" || typeof value === "boolean") klass[k] = value;
  if (typeof klass["cstatesLimited"] !== "boolean") invalid("machine.class has no boolean cstatesLimited");
  const p = record(o["profile"], "machine.profile");
  const governor = p["governor"];
  if (!(governor === null || typeof governor === "string")) invalid("machine.profile.governor is not a string or null");
  const unmet = p["unmet"] === undefined ? [] : (stringList(p["unmet"]) ?? invalid("machine.profile.unmet is not a list of strings"));
  return {
    class: klass,
    profile: {
      governor,
      cpuidle: list(p, "cpuidle", "machine.profile").map(readIdle),
      meetsProtocol: bool(p, "meetsProtocol", "machine.profile"),
      unmet,
    },
    pinnedCpus: str(o, "pinnedCpus", "machine"),
  };
}

function readBinary(v: unknown): ProbeOutput["binary"] {
  const o = record(v, "binary");
  const files = list(o, "files", "binary").map((f, i) => {
    const fo = record(f, `binary.files[${i}]`);
    return { path: str(fo, "path", `binary.files[${i}]`), sha256: sha(fo, "sha256", `binary.files[${i}]`) };
  });
  const layoutIn = o["layout"];
  let layout: { scheme: string; sha256: string } | undefined;
  if (layoutIn !== undefined) {
    const lo = record(layoutIn, "binary.layout");
    layout = { scheme: str(lo, "scheme", "binary.layout"), sha256: sha(lo, "sha256", "binary.layout") };
  }
  return {
    path: str(o, "path", "binary"),
    sha256: sha(o, "sha256", "binary"),
    files,
    ...optional("layout", layout),
    ...optional("unpinnable", nonEmptyString(o["unpinnable"])),
  };
}

function readRun(v: unknown): ProbeOutput["run"] {
  const o = record(v, "run");
  const protocol = record(o["protocol"], "run.protocol");
  const toolsIn = record(o["tools"], "run.tools");
  const tools: Record<string, string> = {};
  for (const [k, value] of Object.entries(toolsIn)) if (typeof value === "string") tools[k] = value;
  return {
    id: str(o, "id", "run"),
    startedAt: str(o, "startedAt", "run"),
    elapsedMs: count(o, "elapsedMs", "run"),
    complete: bool(o, "complete", "run"),
    outcome: outcome(o, "run"),
    ...optional("reason", nonEmptyString(o["reason"])),
    protocol: { name: str(protocol, "name", "run.protocol"), version: posInt(protocol, "version", "run.protocol") },
    tools,
    via: str(o, "via", "run"),
  };
}

function readPlugin(v: unknown): ProbeOutput["plugin"] {
  const o = record(v, "plugin");
  const format = o["format"];
  if (format !== "clap" && format !== "lv2") invalid(`plugin.format ${JSON.stringify(format)} is neither clap nor lv2`);
  return {
    format,
    id: str(o, "id", "plugin"),
    ...optional("name", nonEmptyString(o["name"])),
    ...optional("version", nonEmptyString(o["version"])),
  };
}

function readOffer(v: unknown): ProbeOutput["offer"] {
  const o = record(v, "offer");
  const ext = o["clapExtensions"] === undefined ? undefined : (stringList(o["clapExtensions"]) ?? invalid("offer.clapExtensions is not a list of strings"));
  return { id: str(o, "id", "offer"), ...optional("clapExtensions", ext) };
}

/** The version `"<major>.<minor>"`, or `undefined` when it is not one. */
function parseVersion(v: unknown): { major: number; minor: number } | undefined {
  const m = typeof v === "string" ? /^(\d+)\.(\d+)$/.exec(v) : null;
  return m === null ? undefined : { major: Number(m[1]), minor: Number(m[2]) };
}

/**
 * A probe output from its text, or the code that refuses it. The order of the checks is the order of
 * what can be trusted: that it is JSON and the format, then the major (before any content is read),
 * then that it holds no judgment, then the content, then the derived fields against it.
 */
export function readProbeOutput(text: string): ReadProbeOutputResult {
  try {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return invalid("not JSON");
    }
    const doc = record(json, "the document");
    if (doc["format"] !== PROBE_OUTPUT_FORMAT) invalid(`format is ${JSON.stringify(doc["format"])}, not ${PROBE_OUTPUT_FORMAT}`);
    const version = parseVersion(doc["formatVersion"]);
    if (version === undefined) invalid(`formatVersion ${JSON.stringify(doc["formatVersion"])} is not "<major>.<minor>"`);
    if (version.major !== PROBE_OUTPUT_MAJOR) {
      throw new Refusal(PROBE_FORMAT_CODE.majorUnknown, `formatVersion ${String(doc["formatVersion"])}: this reader knows major ${PROBE_OUTPUT_MAJOR}`);
    }
    for (const key of JUDGMENT_KEYS) if (key in doc) invalid(`the document carries ${key}: a probe output holds facts, never a judgment`);
    const grid = doc["grid"] === undefined ? [] : list(doc, "grid", "the document").map(readPoint);
    const seen = new Set<string>();
    for (const p of grid) {
      const key = `${p.rate}/${p.quantum}`;
      if (seen.has(key)) invalid(`grid holds rate ${p.rate} at quantum ${p.quantum} twice`);
      seen.add(key);
    }
    const behaviour = doc["behaviour"];
    const output: ProbeOutput = {
      formatVersion: String(doc["formatVersion"]),
      run: readRun(doc["run"]),
      plugin: readPlugin(doc["plugin"]),
      binary: readBinary(doc["binary"]),
      machine: readMachine(doc["machine"]),
      offer: readOffer(doc["offer"]),
      steps: list(doc, "steps", "the document").map(readStep),
      grid,
      ...(isRecord(behaviour) ? { behaviour } : {}),
    };
    checkDerived(output.machine);
    return { ok: true, output };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, code: e.code, problem: e.message };
    throw e;
  }
}

/** The SHA-256 of some bytes, as the record names a probe output's copy. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
