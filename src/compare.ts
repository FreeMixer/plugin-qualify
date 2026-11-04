// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * `plugin-qualify compare`: every plugin through every host with the same checks, one row per plugin per host.
 *
 * The hosts are mod-host and jalv, the two LV2 hosts a Zynthian or a MOD device runs, and ours: omx-clap-host (one
 * process, the LV2 adapter for LV2, CLAP as itself) and plugin-hostd (a worker per plugin). Every host runs on one
 * private JACK server at one rate and quantum, with the same timeouts, the same stimulus (a tone into an effect, notes
 * into an instrument), the same number of load cycles, the same soak and the same real-time watch.
 *
 * This file holds every decision and no process: the arguments, which host a plugin goes to, how one host's raw
 * observation (`tools/compare-host.mjs` prints it) becomes the row's checks, the comparison record of a plugin, and the
 * summary of a directory of them. A check a host does not let us observe is `not-observable`, never `fail`; a host that
 * is not installed is `skipped` with the reason, never left out.
 */
import { createHash } from "node:crypto";

export const COMPARISON_RECORD_SCHEMA = "plugin-qualify.comparison-record/1";
export const COMPARISON_SUMMARY_SCHEMA = "plugin-qualify.comparison-summary/1";
export const COMPARISON_RECORD_SUFFIX = ".comparison.json";
export const COMPARISON_SUMMARY_FILE = "comparison-summary.json";

/** The hosts, in the order their rows are written. */
export const COMPARE_HOSTS = ["omx-clap-host", "plugin-hostd", "mod-host", "jalv"] as const;
export type CompareHost = (typeof COMPARE_HOSTS)[number];
/** The references a published comparison is measured against: without both, a summary is not publishable. */
export const REFERENCE_HOSTS: readonly CompareHost[] = ["mod-host", "jalv"];

/** How each host is driven, and what of it can be observed. The page and the summary print these, so they are data. */
export interface HostTraits {
  readonly program: string;
  /** `protocol`: the mod-host socket protocol (`add`, `remove`); `process`: one process per plugin (jalv). */
  readonly drive: "protocol" | "process";
  readonly formats: readonly ("lv2" | "clap")[];
  /** Why the plugin latency it reports is or is not observable. */
  readonly latency: { readonly observable: boolean; readonly how: string };
  readonly rt: string;
}

export const HOST_TRAITS: Readonly<Record<CompareHost, HostTraits>> = {
  "omx-clap-host": {
    program: "omx-clap-host",
    drive: "protocol",
    formats: ["lv2", "clap"],
    latency: { observable: true, how: "the host sets a JACK latency callback: the plugin's latency is on its output port's capture range" },
    rt: "its JACK process callback, counted by rt_watch.so",
  },
  "plugin-hostd": {
    program: "plugin-hostd",
    drive: "protocol",
    formats: ["lv2", "clap"],
    latency: { observable: true, how: "its worker (omx-clap-host) sets a JACK latency callback" },
    rt: "the JACK process callback of every process it starts, counted by rt_watch.so",
  },
  "mod-host": {
    program: "mod-host",
    drive: "protocol",
    formats: ["lv2"],
    latency: { observable: false, how: "mod-host sets no JACK latency callback, so a plugin's latency is not on its ports" },
    rt: "its JACK process callback, counted by rt_watch.so",
  },
  jalv: {
    program: "jalv",
    drive: "process",
    formats: ["lv2"],
    latency: { observable: true, how: "jalv sets a JACK latency callback: the plugin's latency is on its output port's capture range" },
    rt: "its JACK process callback, counted by rt_watch.so",
  },
};

export const isCompareHost = (s: string): s is CompareHost => (COMPARE_HOSTS as readonly string[]).includes(s);

// ---------------------------------------------------------------------------------------------------- arguments

export interface CompareArgs {
  readonly help: boolean;
  readonly all: boolean;
  readonly targets: readonly string[];
  readonly hosts: readonly CompareHost[];
  readonly rate: number;
  readonly quantum: number;
  readonly cycles: number;
  readonly soakS: number;
  readonly windowMs: number;
  readonly timeoutMs: number;
  readonly out: string | undefined;
  readonly hostClass: string | undefined;
  readonly set: string | undefined;
  readonly publish: boolean;
  readonly server: string | undefined;
  readonly limit: number;
  readonly force: boolean;
  readonly format: "text" | "json";
}

export const COMPARE_DEFAULTS = {
  rate: 48000,
  quantum: 256,
  cycles: 5,
  soakS: 10,
  windowMs: 2000,
  timeoutMs: 10000,
} as const;

export type ParseCompare = { ok: true; args: CompareArgs } | { ok: false; error: string };

const positiveInt = (v: string | undefined): number | undefined => (v !== undefined && /^[1-9]\d*$/.test(v) ? Number(v) : undefined);

export function parseCompareArgs(argv: readonly string[]): ParseCompare {
  let help = false;
  let all = false;
  let publish = false;
  let force = false;
  let format: "text" | "json" = "text";
  const targets: string[] = [];
  let hosts: CompareHost[] = [...COMPARE_HOSTS];
  const n: { -readonly [K in keyof typeof COMPARE_DEFAULTS]: number } = { ...COMPARE_DEFAULTS };
  let out: string | undefined;
  let hostClass: string | undefined;
  let set: string | undefined;
  let server: string | undefined;
  let limit = 0;
  const numeric: Record<string, keyof typeof COMPARE_DEFAULTS> = {
    "--rate": "rate",
    "--quantum": "quantum",
    "--cycles": "cycles",
    "--soak": "soakS",
    "--window-ms": "windowMs",
    "--timeout-ms": "timeoutMs",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    const key = numeric[a];
    const value = (): string | undefined => argv[++i];
    if (a === "-h" || a === "--help") help = true;
    else if (a === "--all") all = true;
    else if (a === "--publish") publish = true;
    else if (a === "--force") force = true;
    else if (a === "--hosts") {
      const v = value();
      const list = (v ?? "").split(",").filter(Boolean);
      const bad = list.filter((h) => !isCompareHost(h));
      if (list.length === 0 || bad.length > 0) return { ok: false, error: `--hosts takes a list of ${COMPARE_HOSTS.join(", ")}${bad.length ? `; not a host: ${bad.join(", ")}` : ""}` };
      hosts = COMPARE_HOSTS.filter((h) => list.includes(h));
    } else if (key !== undefined) {
      const v = positiveInt(value());
      if (v === undefined) return { ok: false, error: `${a} takes a whole number above 0` };
      n[key] = v;
    } else if (a === "--limit") {
      const v = positiveInt(value());
      if (v === undefined) return { ok: false, error: "--limit takes a whole number above 0" };
      limit = v;
    } else if (a === "--out") out = value();
    else if (a === "--host-class") hostClass = value();
    else if (a === "--set") set = value();
    else if (a === "--server") server = value();
    else if (a === "--format") {
      const v = value();
      if (v !== "text" && v !== "json") return { ok: false, error: "--format is text or json" };
      format = v;
    } else if (a.startsWith("-")) return { ok: false, error: `unknown option ${a}` };
    else targets.push(a);
  }
  for (const [k, v] of [["--out", out], ["--host-class", hostClass], ["--set", set], ["--server", server]] as const) {
    if (argv.includes(k) && (v === undefined || v.startsWith("-"))) return { ok: false, error: `${k} needs a value` };
  }
  if (!help && !all && targets.length === 0) return { ok: false, error: "name the plugins (LV2 URIs, bundles or .clap files) or --all" };
  if (all && targets.length > 0) return { ok: false, error: "--all and named plugins do not go together" };
  if (publish && (out === undefined || hostClass === undefined || set === undefined)) {
    return { ok: false, error: "--publish writes a summary for the records: it needs --out, --host-class and --set" };
  }
  if (publish && !REFERENCE_HOSTS.every((h) => hosts.includes(h))) {
    return { ok: false, error: `--publish compares against ${REFERENCE_HOSTS.join(" and ")}: --hosts must name them` };
  }
  return {
    ok: true,
    args: {
      help,
      all,
      targets,
      hosts,
      rate: n.rate,
      quantum: n.quantum,
      cycles: n.cycles,
      soakS: n.soakS,
      windowMs: n.windowMs,
      timeoutMs: n.timeoutMs,
      out,
      hostClass,
      set,
      publish,
      server,
      limit,
      force,
      format,
    },
  };
}

export function compareHelpText(): string {
  return [
    "usage: plugin-qualify compare [options] (--all | <LV2 URI | bundle | .clap> ...)",
    "",
    "Runs every plugin through each host with the same checks, one row per plugin per host: it loads, it",
    "instantiates, it gives output (an effect a tone, an instrument notes), it survives the load cycles and the soak,",
    "its audio thread allocates, locks or makes a system call or not (rt_watch.so around the host's JACK process",
    "callback), its CPU and the latency the host reports. A check a host does not let us see is `not-observable`.",
    "",
    `  --hosts <list>      of ${COMPARE_HOSTS.join(",")} (default all); one not installed is skipped, with the reason`,
    `  --rate <hz>         of the private JACK server (default ${String(COMPARE_DEFAULTS.rate)})`,
    `  --quantum <frames>  (default ${String(COMPARE_DEFAULTS.quantum)})`,
    `  --cycles <n>        load and unload cycles before the run (default ${String(COMPARE_DEFAULTS.cycles)})`,
    `  --soak <s>          seconds the plugin runs under its stimulus (default ${String(COMPARE_DEFAULTS.soakS)})`,
    `  --window-ms <ms>    the output window, at the start and at the end of the soak (default ${String(COMPARE_DEFAULTS.windowMs)})`,
    `  --timeout-ms <ms>   the budget of one host step: a reply, a client on the graph (default ${String(COMPARE_DEFAULTS.timeoutMs)})`,
    "  --server <name>     use this running JACK server instead of starting a private one (dummy driver)",
    "  --limit <n>         the first n plugins only",
    "  --force             compare again a plugin whose record in --out was made under the same conditions",
    `  --out <dir>         write one ${COMPARISON_RECORD_SUFFIX} per plugin and ${COMPARISON_SUMMARY_FILE} there`,
    "  --host-class <c>    the machine class the summary is for (rpi5, x86-64)",
    "  --set <name>        the plugin set the summary is for (zynthian-vangelis, fedora44)",
    `  --publish           a summary for the records: refused unless ${REFERENCE_HOSTS.join(" and ")} are installed and ran`,
    "  --format text|json",
    "",
    "exit 0 the comparison ran / 1 a --publish run lacked a reference host / 2 nothing could be compared",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------- the hosts here

export interface HostPresence {
  readonly host: CompareHost;
  readonly installed: boolean;
  readonly version: string | null;
  /** Why it is skipped, when it is. */
  readonly reason?: string;
}

/** The reference hosts a publishable summary lacks, by name, with the reason each is missing. */
export function missingReferences(present: readonly HostPresence[]): readonly { host: CompareHost; reason: string }[] {
  return REFERENCE_HOSTS.flatMap((h) => {
    const p = present.find((x) => x.host === h);
    if (p === undefined) return [{ host: h, reason: "not asked for with --hosts" }];
    if (!p.installed) return [{ host: h, reason: p.reason ?? `${HOST_TRAITS[h].program} is not installed` }];
    return [];
  });
}

/** What a directory of records says of each host: it ran where a row of it ran, else the reason its rows give. */
export function presenceFromRecords(records: readonly ComparisonRecord[]): HostPresence[] {
  return COMPARE_HOSTS.flatMap((h): HostPresence[] => {
    const rows = records.flatMap((r) => r.hosts.filter((x) => x.host === h));
    if (rows.length === 0) return [];
    const ran = rows.find((x) => x.status === "ran");
    if (ran !== undefined) return [{ host: h, installed: true, version: ran.version }];
    if (rows.every((x) => x.status === "not-applicable")) return [{ host: h, installed: true, version: rows[0]?.version ?? null }];
    const skipped = rows.find((x) => x.status === "skipped");
    return [{ host: h, installed: false, version: null, reason: skipped?.reason ?? `${HOST_TRAITS[h].program} did not run` }];
  });
}

/** The arguments of `plugin-qualify compare summary <dir>`: the summary of the records already in a directory. */
export type ParseSummary = { ok: true; args: { dir: string; hostClass?: string; set?: string; publish: boolean; help: boolean } } | { ok: false; error: string };

export function parseSummaryArgs(argv: readonly string[]): ParseSummary {
  let dir: string | undefined;
  let hostClass: string | undefined;
  let set: string | undefined;
  let publish = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "-h" || a === "--help") help = true;
    else if (a === "--publish") publish = true;
    else if (a === "--host-class") hostClass = argv[++i];
    else if (a === "--set") set = argv[++i];
    else if (a.startsWith("-")) return { ok: false, error: `unknown option ${a}` };
    else if (dir === undefined) dir = a;
    else return { ok: false, error: "one directory" };
  }
  if (help) return { ok: true, args: { dir: dir ?? ".", publish, help } };
  if (dir === undefined) return { ok: false, error: "name the directory of the comparison records" };
  if (publish && (hostClass === undefined || set === undefined)) return { ok: false, error: "--publish needs --host-class and --set" };
  return { ok: true, args: { dir, publish, help, ...(hostClass === undefined ? {} : { hostClass }), ...(set === undefined ? {} : { set }) } };
}

export function summaryHelpText(): string {
  return [
    "usage: plugin-qualify compare summary <dir> [--host-class <c> --set <s> --publish]",
    "",
    `Reads every ${COMPARISON_RECORD_SUFFIX} in <dir> and writes ${COMPARISON_SUMMARY_FILE} beside them: per host the plugins`,
    "it loads, runs clean, runs real-time safe and crashes on, and the plugins where each host does better than the others.",
    `--publish marks it for the records, and is refused unless ${REFERENCE_HOSTS.join(" and ")} ran.`,
    "",
  ].join("\n");
}

/** Two runs are the same comparison when every condition but the machine's JACK version and real-time grant agree. */
export function sameConditions(a: ComparisonConditions, b: ComparisonConditions): boolean {
  return a.rate === b.rate && a.quantum === b.quantum && a.cycles === b.cycles && a.soakS === b.soakS && a.windowMs === b.windowMs && a.timeoutMs === b.timeoutMs;
}

// ---------------------------------------------------------------------------------------------------- one host's row

export type CheckResult = "pass" | "fail" | "not-observable" | "not-run";
export type FigureResult = "measured" | "not-observable" | "not-run";

export interface Check {
  readonly result: CheckResult;
  readonly detail?: string;
}
export interface OutputCheck extends Check {
  readonly peak?: number;
  readonly stimulus?: Stimulus;
}
export interface CyclesCheck extends Check {
  readonly done: number;
  readonly of: number;
}
export interface SoakCheck extends Check {
  readonly seconds: number;
  readonly peakAtEnd?: number;
}
export interface RtCheck extends Check {
  readonly allocations?: number;
  readonly locks?: number;
  /** Try-locks: they never wait, so they are reported and do not fail the check. */
  readonly trylocks?: number;
  readonly syscalls?: number;
  readonly cycles?: number;
  readonly kinds?: readonly string[];
}
export interface CpuFigure {
  readonly result: FigureResult;
  /** utime + stime of the host's processes over the soak, in percent of one core. */
  readonly percent?: number;
  readonly detail?: string;
}
export interface LatencyFigure {
  readonly result: FigureResult;
  readonly frames?: number;
  readonly detail?: string;
}

export interface HostChecks {
  readonly loads: Check;
  readonly instantiates: Check;
  readonly output: OutputCheck;
  readonly cycles: CyclesCheck;
  readonly soak: SoakCheck;
  readonly rtSafe: RtCheck;
  readonly cpu: CpuFigure;
  readonly latency: LatencyFigure;
}

export interface HostRow {
  readonly host: CompareHost;
  readonly version: string | null;
  readonly status: "ran" | "skipped" | "not-applicable";
  readonly reason?: string;
  readonly checks?: HostChecks;
  /** The step the host died at and how, when it did. */
  readonly crash?: { readonly step: string; readonly signal: string };
  /** Loaded, instantiated, survived the cycles and the soak, never crashed, and its output was not found silent. */
  readonly runsClean?: boolean;
}

export type Stimulus = "tone" | "notes" | "none";

/** What tools/compare-host.mjs prints for one plugin under one host: observations, no judgment. */
export interface HostObservation {
  readonly installed: boolean;
  readonly started?: boolean;
  /** Each add or start: ok, the reply code, or how the host ended. */
  readonly load?: { readonly ok: boolean; readonly resp?: number; readonly died?: string; readonly detail?: string };
  /** The plugin's ports appeared on the graph. */
  readonly ports?: { readonly audioIn: number; readonly audioOut: number; readonly midiIn: number };
  readonly stimulus?: Stimulus;
  readonly peak?: number | null;
  /** NaN and infinite samples read on the outputs, over both windows. */
  readonly nonFinite?: number;
  readonly peakProblem?: string;
  readonly cycles?: { readonly done: number; readonly of: number; readonly died?: string; readonly failedAt?: string };
  readonly soak?: { readonly seconds: number; readonly alive: boolean; readonly died?: string; readonly peakAtEnd?: number | null };
  readonly rt?: readonly RtReport[];
  readonly cpu?: { readonly percent: number } | { readonly problem: string };
  readonly latencyFrames?: number | null;
  readonly died?: { readonly step: string; readonly signal: string };
  readonly problem?: string;
}

/** One process's rt_watch.so report. */
export interface RtReport {
  readonly pid: number;
  readonly callbacks: number;
  readonly cycles: number;
  readonly armedCycles: number;
  readonly allocations: number;
  readonly locks: number;
  readonly trylocks?: number;
  readonly syscalls: number;
  readonly kinds?: readonly string[];
}

/** A peak at or under this is silence (-100 dBFS). */
export const SILENCE = 1e-5;

const audible = (p: number | null | undefined): boolean => typeof p === "number" && Number.isFinite(p) && p > SILENCE;

/** The real-time verdict from the reports of the host's processes. */
export function rtCheckOf(reports: readonly RtReport[] | undefined): RtCheck {
  if (reports === undefined || reports.length === 0) return { result: "not-observable", detail: "no process of the host reported (rt_watch.so was not loaded, or the host was gone)" };
  const watched = reports.filter((r) => r.callbacks > 0);
  const armed = watched.reduce((s, r) => s + r.armedCycles, 0);
  if (watched.length === 0) return { result: "not-observable", detail: "no process of the host set a JACK process callback that rt_watch.so could wrap" };
  if (armed === 0) return { result: "not-observable", detail: "the process callback never ran past its warm-up" };
  const allocations = watched.reduce((s, r) => s + r.allocations, 0);
  const locks = watched.reduce((s, r) => s + r.locks, 0);
  const syscalls = watched.reduce((s, r) => s + r.syscalls, 0);
  const trylocks = watched.reduce((s, r) => s + (r.trylocks ?? 0), 0);
  const kinds = [...new Set(watched.flatMap((r) => r.kinds ?? []))];
  const clean = allocations === 0 && locks === 0 && syscalls === 0;
  return {
    result: clean ? "pass" : "fail",
    allocations,
    locks,
    trylocks,
    syscalls,
    cycles: armed,
    ...(kinds.length ? { kinds } : {}),
    ...(clean ? (trylocks > 0 ? { detail: `${String(trylocks)} try-locks on the audio thread over ${String(armed)} cycles; a try-lock never waits` } : {}) : { detail: `on the audio thread over ${String(armed)} cycles: ${String(allocations)} allocations, ${String(locks)} locks, ${String(syscalls)} system calls` }),
  };
}

const NOT_RUN = (why: string): Check => ({ result: "not-run", detail: why });

/** One host's observation of one plugin as its row. */
export function hostRowOf(host: CompareHost, version: string | null, obs: HostObservation, conditions: { cycles: number; soakS: number }): HostRow {
  const base = { host, version };
  if (!obs.installed) return { ...base, status: "skipped", reason: obs.problem ?? `${HOST_TRAITS[host].program} is not installed` };
  if (obs.started === false) return { ...base, status: "skipped", reason: obs.problem ?? `${HOST_TRAITS[host].program} did not start` };
  const load = obs.load;
  const loaded = load?.ok === true;
  const loads: Check = loaded
    ? { result: "pass" }
    : { result: "fail", detail: load?.died ? `the host ended (${load.died})` : load?.resp !== undefined ? `resp ${String(load.resp)}` : load?.detail ?? "no answer in time" };
  const ports = obs.ports;
  const anyPort = ports !== undefined && ports.audioIn + ports.audioOut + ports.midiIn > 0;
  const instantiates: Check = !loaded ? NOT_RUN("it did not load") : anyPort ? { result: "pass" } : { result: "fail", detail: "no port of the plugin appeared on the graph" };
  const running = loaded && anyPort;

  let output: OutputCheck;
  if (!running) output = { ...NOT_RUN("it is not running") };
  else if (ports.audioOut === 0) output = { result: "not-observable", detail: "the plugin has no audio output" };
  else if (obs.peakProblem !== undefined) output = { result: "not-observable", detail: obs.peakProblem };
  else if ((obs.nonFinite ?? 0) > 0) output = { result: "fail", detail: `the output is not finite (${String(obs.nonFinite)} NaN or infinite samples)`, peak: obs.peak ?? 0, stimulus: obs.stimulus ?? "none" };
  else if (audible(obs.peak)) output = { result: "pass", peak: obs.peak as number, stimulus: obs.stimulus ?? "none" };
  else if (obs.stimulus === "none" || obs.stimulus === undefined) output = { result: "not-observable", detail: "no stimulus this plugin takes (no audio or MIDI input), and its output was silent", peak: obs.peak ?? 0, stimulus: "none" };
  else output = { result: "fail", detail: `silent under ${obs.stimulus}`, peak: obs.peak ?? 0, stimulus: obs.stimulus };

  const c = obs.cycles;
  const cycles: CyclesCheck =
    c === undefined
      ? { result: "not-run", done: 0, of: conditions.cycles, detail: "the cycles did not run" }
      : c.done === c.of
        ? { result: "pass", done: c.done, of: c.of }
        : { result: "fail", done: c.done, of: c.of, detail: c.died ? `the host ended at cycle ${String(c.done + 1)} (${c.died})` : `cycle ${String(c.done + 1)} failed${c.failedAt ? ` at ${c.failedAt}` : ""}` };

  const s = obs.soak;
  const soak: SoakCheck = !running || s === undefined
    ? { result: "not-run", seconds: 0, detail: "it is not running" }
    : s.alive
      ? { result: "pass", seconds: s.seconds, ...(typeof s.peakAtEnd === "number" ? { peakAtEnd: s.peakAtEnd } : {}) }
      : { result: "fail", seconds: s.seconds, detail: `the host ended during the soak${s.died ? ` (${s.died})` : ""}` };

  const rtSafe: RtCheck = !running ? { result: "not-run", detail: "it is not running" } : rtCheckOf(obs.rt);
  const cpu: CpuFigure = !running || obs.cpu === undefined
    ? { result: "not-run", detail: "it is not running" }
    : "percent" in obs.cpu
      ? { result: "measured", percent: Math.round(obs.cpu.percent * 100) / 100 }
      : { result: "not-observable", detail: obs.cpu.problem };
  const traits = HOST_TRAITS[host];
  const latency: LatencyFigure = !running
    ? { result: "not-run", detail: "it is not running" }
    : !traits.latency.observable
      ? { result: "not-observable", detail: traits.latency.how }
      : typeof obs.latencyFrames === "number"
        ? { result: "measured", frames: obs.latencyFrames }
        : { result: "not-observable", detail: "the output port's latency could not be read" };

  const crashed = obs.died !== undefined;
  const runsClean = !crashed && loaded && running && cycles.result === "pass" && soak.result === "pass" && output.result !== "fail";
  return {
    ...base,
    status: "ran",
    checks: { loads, instantiates, output, cycles, soak, rtSafe, cpu, latency },
    ...(crashed ? { crash: obs.died } : {}),
    runsClean,
  };
}

// ---------------------------------------------------------------------------------------------------- the record

export interface ComparisonConditions {
  readonly rate: number;
  readonly quantum: number;
  readonly cycles: number;
  readonly soakS: number;
  readonly windowMs: number;
  readonly timeoutMs: number;
  readonly jack: string;
  readonly realtime: string;
}

export interface ComparisonRecord {
  readonly schema: typeof COMPARISON_RECORD_SCHEMA;
  readonly plugin: { readonly format: string; readonly id: string; readonly binary?: string };
  readonly stimulus: Stimulus;
  readonly conditions: ComparisonConditions;
  readonly measuredAt: string;
  readonly hosts: readonly HostRow[];
}

/** The record's file name: the plugin's id made safe for a file, with a hash of the whole id so two ids never meet. */
export function comparisonFileName(format: string, id: string): string {
  const slug = id.replace(/^[a-z]+:\/\//i, "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+|_+$/g, "").slice(0, 80);
  const hash = createHash("sha256").update(`${format}\0${id}`).digest("hex").slice(0, 12);
  return `${slug}-${format}-${hash}${COMPARISON_RECORD_SUFFIX}`;
}

export function comparisonRecordOf(
  plugin: { format: string; id: string; binary?: string },
  stimulus: Stimulus,
  conditions: ComparisonConditions,
  measuredAt: string,
  rows: readonly HostRow[],
): ComparisonRecord {
  const ordered = COMPARE_HOSTS.flatMap((h) => rows.filter((r) => r.host === h));
  return { schema: COMPARISON_RECORD_SCHEMA, plugin, stimulus, conditions, measuredAt, hosts: ordered };
}

/** The row of a host that does not take this plugin's format. */
export function notApplicableRow(host: CompareHost, version: string | null, format: string): HostRow {
  return { host, version, status: "not-applicable", reason: `${HOST_TRAITS[host].program} takes no ${format.toUpperCase()} plugin` };
}

/** Problems with a record's shape, empty when it is one: the records repository's check holds the same rules. */
export function comparisonRecordProblems(rec: unknown): string[] {
  const p: string[] = [];
  const r = rec as Partial<ComparisonRecord> | null;
  if (r === null || typeof r !== "object") return ["not an object"];
  if (r.schema !== COMPARISON_RECORD_SCHEMA) p.push(`schema is ${JSON.stringify(r.schema)}`);
  if (typeof r.plugin?.id !== "string" || typeof r.plugin.format !== "string") p.push("names no plugin");
  if (!Array.isArray(r.hosts) || r.hosts.length === 0) p.push("holds no host row");
  for (const h of r.hosts ?? []) {
    if (!isCompareHost(String(h.host))) p.push(`a row of the unknown host ${JSON.stringify(h.host)}`);
    if (h.status === "ran" && (h.checks === undefined || typeof h.runsClean !== "boolean")) p.push(`${h.host}: ran with no checks`);
    if (h.status !== "ran" && !h.reason) p.push(`${h.host}: ${String(h.status)} with no reason`);
  }
  return p;
}

// ---------------------------------------------------------------------------------------------------- the summary

export interface HostTotals {
  readonly host: CompareHost;
  readonly version: string | null;
  readonly status: "ran" | "skipped";
  readonly reason?: string;
  /** Plugins of a format the host takes. */
  readonly plugins: number;
  readonly loads: number;
  readonly instantiates: number;
  readonly output: number;
  readonly runsClean: number;
  readonly rtSafe: number;
  /** Plugins whose real-time behaviour could be watched under this host. */
  readonly rtObserved: number;
  readonly crashes: number;
  readonly cpuMedianPercent: number | null;
  readonly latencyObservable: boolean;
}

export interface Beat {
  readonly format: string;
  readonly id: string;
  /** The hosts it does better than on this plugin. */
  readonly over: readonly CompareHost[];
  /** runs-clean: it runs clean where they do not; rt-safe: its audio thread is clean where theirs is not. */
  readonly on: "runs-clean" | "rt-safe";
}

export interface ComparisonSummary {
  readonly schema: typeof COMPARISON_SUMMARY_SCHEMA;
  readonly hostClass: string | null;
  readonly set: string | null;
  readonly measured: string | null;
  readonly publishable: boolean;
  readonly missing: readonly { host: CompareHost; reason: string }[];
  readonly conditions: ComparisonConditions | null;
  readonly records: number;
  /** Plugins every host that ran takes and ran: the like-for-like set the headline counts. */
  readonly common: number;
  readonly hosts: readonly HostTotals[];
  readonly beats: Readonly<Record<string, readonly Beat[]>>;
}

const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  const hi = s[m] ?? 0;
  return Math.round((s.length % 2 ? hi : ((s[m - 1] ?? hi) + hi) / 2) * 100) / 100;
};

/**
 * The summary of a set of comparison records. `present` is what the run found installed; a host absent from every
 * record is still listed, skipped, with its reason. Beats are counted between hosts that both ran the plugin.
 */
export function summarise(
  records: readonly ComparisonRecord[],
  present: readonly HostPresence[],
  meta: { hostClass?: string; set?: string; publish: boolean },
): ComparisonSummary {
  const hostsSeen = COMPARE_HOSTS.filter((h) => present.some((p) => p.host === h) || records.some((r) => r.hosts.some((x) => x.host === h)));
  const missing = missingReferences(present);
  const ranRow = (r: ComparisonRecord, h: CompareHost): HostRow | undefined => r.hosts.find((x) => x.host === h && x.status === "ran");
  const totals: HostTotals[] = hostsSeen.map((h) => {
    const p = present.find((x) => x.host === h);
    const rows = records.map((r) => ranRow(r, h)).filter((x): x is HostRow => x !== undefined);
    const version = p?.version ?? rows.find((r) => r.version !== null)?.version ?? null;
    const count = (f: (r: HostRow) => boolean): number => rows.filter(f).length;
    const skipped = rows.length === 0 && (p === undefined || !p.installed);
    return {
      host: h,
      version,
      status: skipped ? "skipped" : "ran",
      ...(skipped ? { reason: p?.reason ?? `${HOST_TRAITS[h].program} is not installed` } : {}),
      plugins: rows.length,
      loads: count((r) => r.checks?.loads.result === "pass"),
      instantiates: count((r) => r.checks?.instantiates.result === "pass"),
      output: count((r) => r.checks?.output.result === "pass"),
      runsClean: count((r) => r.runsClean === true),
      rtSafe: count((r) => r.checks?.rtSafe.result === "pass"),
      rtObserved: count((r) => r.checks?.rtSafe.result === "pass" || r.checks?.rtSafe.result === "fail"),
      crashes: count((r) => r.crash !== undefined),
      cpuMedianPercent: median(rows.flatMap((r) => (r.checks?.cpu.result === "measured" && typeof r.checks.cpu.percent === "number" ? [r.checks.cpu.percent] : []))),
      latencyObservable: HOST_TRAITS[h].latency.observable,
    };
  });
  const ran = totals.filter((t) => t.status === "ran").map((t) => t.host);
  const beats: Record<string, Beat[]> = {};
  for (const h of ran) beats[h] = [];
  for (const r of records) {
    for (const h of ran) {
      const mine = ranRow(r, h);
      const list = beats[h];
      if (mine === undefined || list === undefined) continue;
      const others = ran.filter((o) => o !== h).map((o) => [o, ranRow(r, o)] as const).filter((x): x is readonly [CompareHost, HostRow] => x[1] !== undefined);
      const cleanOver = mine.runsClean === true ? others.filter(([, row]) => row.runsClean !== true).map(([o]) => o) : [];
      if (cleanOver.length) list.push({ format: r.plugin.format, id: r.plugin.id, over: cleanOver, on: "runs-clean" });
      const rtOver = mine.checks?.rtSafe.result === "pass" ? others.filter(([, row]) => row.checks?.rtSafe.result === "fail").map(([o]) => o) : [];
      if (rtOver.length) list.push({ format: r.plugin.format, id: r.plugin.id, over: rtOver, on: "rt-safe" });
    }
  }
  for (const list of Object.values(beats)) list.sort((a, b) => a.on.localeCompare(b.on) || a.format.localeCompare(b.format) || a.id.localeCompare(b.id));
  const measured = records.map((r) => r.measuredAt).sort().pop() ?? null;
  return {
    schema: COMPARISON_SUMMARY_SCHEMA,
    hostClass: meta.hostClass ?? null,
    set: meta.set ?? null,
    measured: measured === null ? null : measured.slice(0, 10),
    publishable: meta.publish && missing.length === 0 && REFERENCE_HOSTS.every((h) => ran.includes(h)),
    missing,
    conditions: records[0]?.conditions ?? null,
    records: records.length,
    common: records.filter((r) => ran.every((h) => ranRow(r, h) !== undefined)).length,
    hosts: totals,
    beats,
  };
}

/** The text table of a summary, for the terminal. */
export function summaryTable(s: ComparisonSummary): string {
  const lines = [`host            version                     plugins loads clean rt-safe/observed crashes cpu%`];
  for (const t of s.hosts) {
    if (t.status === "skipped") {
      lines.push(`${t.host.padEnd(15)} skipped: ${t.reason ?? ""}`);
      continue;
    }
    lines.push(
      `${t.host.padEnd(15)} ${(t.version ?? "?").padEnd(27)} ${String(t.plugins).padStart(7)} ${String(t.loads).padStart(5)} ${String(t.runsClean).padStart(5)} ${`${String(t.rtSafe)}/${String(t.rtObserved)}`.padStart(16)} ${String(t.crashes).padStart(7)} ${t.cpuMedianPercent === null ? "-" : String(t.cpuMedianPercent)}`,
    );
  }
  for (const [h, list] of Object.entries(s.beats)) if (list.length) lines.push(`${h} does better on ${String(list.length)}: ${list.map((b) => `${b.id} (${b.on} over ${b.over.join(",")})`).join("; ")}`);
  if (!s.publishable) lines.push(`not publishable${s.missing.length ? `: ${s.missing.map((m) => `${m.host}: ${m.reason}`).join("; ")}` : " (no --publish)"}`);
  return `${lines.join("\n")}\n`;
}
