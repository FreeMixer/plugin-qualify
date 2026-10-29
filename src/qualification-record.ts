// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The qualification record: what plugin-qualify wrote down about one plugin binary and one offer
 * after judging its probe output, kept in `qualification_dir`. Evidence, not a constraint: no
 * reader refuses a descriptor because of it.
 *
 * Two files, always together. The record is the judgment; beside it is a byte copy of the probe
 * output it judged, because the probe directory is runtime and may be wiped. The record names the
 * copy and the SHA-256 of the copy's bytes, so the facts outlive the run without hostd keeping a
 * second store, and a reader can tell that the figures it holds are the ones the verdict came from.
 *
 * Not yet in the record: the fingerprint of the descriptor's controls, since the descriptor is
 * written by the scan (stage 5) and plugin-qualify does not read one yet.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Adjustment } from "./history-adjust.js";
import type { Judgment, RecordReason } from "./probe-judge.js";
import { sha256Hex, PROBE_OK, type ProbeGridPoint, type ProbeOutput } from "./probe-output.js";
import type { VoicesHeld } from "./measurement/format.js";
import { writeFileWhole } from "./whole-file.js";
import { HOSTING_CODE } from "./hosting-codes.js";
import { MEASUREMENT_UNMEASURED_REASONS } from "@openmixer/omx-contract";

export const QUALIFICATION_RECORD_SCHEMA = "plugin-qualify.qualification-record/1";

/** One host's verdict in the record. */
export interface RecordVerdict {
  readonly host: string;
  /** False when the run did not finish: the rating is `unknown` and the reason is the run's outcome. */
  readonly measured: boolean;
  readonly rating: string;
  readonly qualified: boolean;
  readonly hosting: "in-process" | "isolated";
  /** `run` when the plugin was run under this host (`jalv`, `mod-host`), `declaration` when the verdict is what the profile's declaration makes of the probe output. */
  readonly arm: "run" | "declaration";
  /** The code that decided it; absent for `suitable`. */
  readonly deciding?: string;
  readonly reasons: readonly RecordReason[];
}

/** One tier of the console as a verdict: the host it is judged under and whether the plugin qualified there. */
export interface TierVerdict {
  readonly host: string;
  readonly measured: boolean;
  readonly qualified: boolean;
  readonly rating: string;
  readonly deciding?: string;
}

/** The console's two tiers (what the console's roster offers): offered where the verdict qualified, dimmed with the reason when neither did. */
export interface RecordTiers {
  readonly inProcess?: TierVerdict;
  readonly isolated?: TierVerdict;
  readonly offeredOn: readonly ("in-process" | "isolated")[];
  /** Why the plugin is offered on neither tier: the deciding codes, in-process first. */
  readonly dimmed?: string;
}

/** The profile each format's isolated tier is judged under. */
export const ISOLATED_TIER_HOST: Readonly<Record<string, string>> = { lv2: "mod-host", clap: "omx-clap-host" };
export const IN_PROCESS_TIER_HOST = "openmixer-console";

/** A latency or cost figure the run could not take: which one, at what rate and quantum, and the code that says why. */
export interface UnmeasuredFigure {
  readonly dimension: "latency" | "cost";
  readonly rate?: number;
  readonly quantum?: number;
  /** The hosting code the run gave (`hosting.latency.unmeasured`), else the step's outcome code. */
  readonly code: string;
  /** The prober's own words, for a person; never what a reader classifies by. */
  readonly detail?: string;
}

/**
 * The figures the run could not take, from the steps that say so. A latency or cost step that did not end `probe.ok`
 * leaves its figure out of the grid: this names the figure, so a grid point without a `latency` is never read as a plugin
 * with none.
 */
export function unmeasuredFigures(output: ProbeOutput): readonly UnmeasuredFigure[] {
  return output.steps
    .filter((s) => (s.step === "latency" || s.step === "cost") && s.outcome !== PROBE_OK)
    .map((s) => ({
      dimension: s.step as "latency" | "cost",
      ...(s.rate === undefined ? {} : { rate: s.rate }),
      ...(s.quantum === undefined ? {} : { quantum: s.quantum }),
      code: s.hostingCode ?? s.outcome,
      ...(s.detail === undefined ? {} : { detail: s.detail }),
    }));
}

/** A cell's latency when the run took no figure: the contract's unmeasured word and the hosting code a reader classifies by. */
export interface UnmeasuredLatency {
  /** The figure the plugin declared (LV2 latency port, CLAP latency extension) when it loaded but the probe did not measure. */
  readonly declaredFrames?: number;
  readonly unmeasuredReason: string;
  readonly code: string;
}

/** A grid point as the record writes it: every cell carries `latency`, the figures or why there are none (#201). */
export type RecordGridPoint = Omit<ProbeGridPoint, "latency"> & {
  readonly latency: (Omit<NonNullable<ProbeGridPoint["latency"]>, "measuredFrames"> & { readonly measuredFrames: number }) | UnmeasuredLatency;
};

const UNMEASURED_WORDS: ReadonlySet<string> = new Set(Object.values(MEASUREMENT_UNMEASURED_REASONS).map((r) => r.word));
const word = (key: keyof typeof MEASUREMENT_UNMEASURED_REASONS): string => MEASUREMENT_UNMEASURED_REASONS[key].word;

/** The unmeasured word of a cell whose run did not end well, by its outcome code. */
const OUTCOME_WORD: Readonly<Record<string, string>> = {
  "probe.crashed": word("probeCrashed"),
  "probe.timeout": word("probeTimeout"),
  "probe.refused-instantiation": word("refusedInstantiation"),
  "probe.non-finite-output": word("nonFiniteOutput"),
};

/**
 * Why a cell has no latency figure. A cell whose run failed: its outcome's word. A latency step at the cell that did not
 * end well: the child's own reason, which the runner writes first in the step's detail, when it is a contract word,
 * else `probe-error`. No latency step at all: the run did not take the figure (`not-attempted`), as a runner or a child
 * older than the latency arm writes it.
 */
export function latencyOfCell(output: ProbeOutput, point: ProbeGridPoint): RecordGridPoint["latency"] {
  const had = point.latency;
  if (had?.measuredFrames !== undefined) return { ...had, measuredFrames: had.measuredFrames };
  const why = unmeasuredOfCell(output, point);
  return had === undefined ? why : { declaredFrames: had.declaredFrames, ...why };
}

function unmeasuredOfCell(output: ProbeOutput, point: ProbeGridPoint): UnmeasuredLatency {
  const code = HOSTING_CODE.latencyUnmeasured;
  if (point.outcome !== PROBE_OK) return { unmeasuredReason: OUTCOME_WORD[point.outcome] ?? word("probeError"), code };
  const step = output.steps.find((st) => st.step === "latency" && st.rate === point.rate && (st.quantum === undefined || st.quantum === point.quantum));
  if (step === undefined) return { unmeasuredReason: word("notAttempted"), code };
  const said = step.detail?.split(":")[0]?.trim() ?? "";
  return { unmeasuredReason: UNMEASURED_WORDS.has(said) ? said : word("probeError"), code: step.hostingCode ?? code };
}

/**
 * What the running history made of the measured verdicts, for one host class: the second verdict beside the measured one.
 * Written by `plugin-qualify adjust --history`; the measured `verdicts` above are never changed by it. A record without the
 * block was never adjusted.
 */
export interface HistoryBlock {
  /** The machine class of the history's lines, `arch/cores/clock`. */
  readonly hostClass: string;
  /** The history file as it was named. */
  readonly file: string;
  /** The UTC time the history was read at (ISO 8601). */
  readonly at: string;
  /** The line looked for: plugin-hostd's uri and the digest of the first file of the pin; absent when the record holds no whole pin. */
  readonly key?: { readonly uri: string; readonly digest: string };
  /** Whether the history holds a line of this plugin binary on this host class. */
  readonly found: boolean;
  /** The windows the line counts. */
  readonly windows?: { readonly solo: number; readonly grouped: number };
  /** What plugin-hostd's `history_get` would answer of the line. */
  readonly summary?: { readonly crashed: boolean; readonly raisesXruns: boolean };
  /** The keys of the line this tool does not know, as written. */
  readonly unknownKeys?: Readonly<Record<string, string>>;
  /** One per host profile adjusted: the measured pin verdict, the adjusted one, the move and the reason code. */
  readonly verdicts: readonly ({ readonly host: string } & Adjustment)[];
}

export interface QualificationRecord {
  readonly schema: typeof QUALIFICATION_RECORD_SCHEMA;
  readonly plugin: { readonly format: string; readonly id: string; readonly name?: string };
  /** The plugin's version when it was tested; a newer installed one is shown as "tested on X, installed Y". */
  readonly testedVersion?: string;
  readonly binary: ProbeOutput["binary"];
  readonly verdicts: readonly RecordVerdict[];
  /**
   * An LV2 plugin run under plugin-hostd's LV2 adapter (omx-clap-host), as under mod-host: admitted, or refused with
   * its code, or `measured: false` when it was not tried. Beside the verdicts, which it does not change (#223).
   */
  readonly adapter?: { readonly host: string; readonly measured: boolean; readonly admitted: boolean; readonly code?: string; readonly params: Readonly<Record<string, string | number>> };
  readonly tiers: RecordTiers;
  /** The cost reasons at each host's rate and quantum, beside the verdicts; an instrument's with the notes it held. */
  readonly cost: readonly {
    readonly host: string;
    readonly rate: number;
    readonly quantum: number;
    readonly voices?: VoicesHeld;
    readonly reasons: readonly RecordReason[];
  }[];
  /**
   * The figures as measured, per rate and quantum: the same fields whichever format the plugin is (`latency`
   * {declaredFrames, measuredFrames}, `cost`, `rtSafety`, `noteSweep`), and the figures the run could not take, named.
   */
  readonly measurements: {
    readonly grid: readonly RecordGridPoint[];
    readonly behaviour?: Readonly<Record<string, unknown>>;
    readonly unmeasured?: readonly UnmeasuredFigure[];
  };
  /**
   * What the run that wrote this record did not measure, each with the code a verdict reads for it: the quick
   * qualification of `plugin-qualify-sync` takes no soak, and says so here rather than leave it unstated.
   */
  readonly notMeasured?: readonly NotMeasured[];
  /** Who measured and when. */
  readonly tool: Readonly<Record<string, string>>;
  readonly measuredAt: string;
  /** The second verdict, per host class of the history that was read; absent until `adjust --history` has run. */
  readonly history?: readonly HistoryBlock[];
  /** Where the record came from when it was not measured on this device: the distributed set's provenance, as the set's package wrote it. */
  readonly provenance?: Readonly<Record<string, unknown>>;
  /** The probe output this record judged. */
  readonly probe: {
    readonly file: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly protocol: { readonly name: string; readonly version: number };
    readonly reason?: string;
    readonly outcome: string;
    readonly complete: boolean;
    readonly machineClass: Readonly<Record<string, string | boolean>>;
    /** Whether the machine met the protocol's optimised profile: a figure that did not is not a reference figure. */
    readonly meetsProtocol: boolean;
  };
}

/** One dimension a run did not measure, and the code that says so. */
export interface NotMeasured {
  readonly dimension: string;
  readonly code: string;
}

const safe = (text: string): string => text.replace(/[^A-Za-z0-9._-]/g, "_");

/** `<id>@<version>-<sha256 first 12>.<offer>`: one binary and one offer, whatever the run. */
export function qualificationBaseName(output: ProbeOutput): string {
  return `${safe(output.plugin.id)}@${safe(output.plugin.version ?? "unversioned")}-${output.binary.sha256.slice(0, 12)}.${safe(output.offer.id)}`;
}

export const recordFileName = (output: ProbeOutput): string => `${qualificationBaseName(output)}.qualification.json`;
export const probeCopyFileName = (output: ProbeOutput): string => `${qualificationBaseName(output)}.probe.json`;

function tierOf(judgment: Judgment, host: string | undefined): TierVerdict | undefined {
  const v = judgment.hosts.find((h) => h.verdict.host === host)?.verdict;
  if (v === undefined) return undefined;
  return { host: v.host, measured: v.measured, qualified: v.qualified, rating: v.rating, ...(v.deciding === undefined ? {} : { deciding: v.deciding }) };
}

/** The console's two tiers from the verdicts the judgment holds. A tier no profile judged is absent, and is not offered. */
export function tiersOf(judgment: Judgment): RecordTiers {
  const inProcess = tierOf(judgment, IN_PROCESS_TIER_HOST);
  const isolated = tierOf(judgment, ISOLATED_TIER_HOST[judgment.output.plugin.format]);
  const offeredOn: ("in-process" | "isolated")[] = [];
  if (inProcess?.qualified === true) offeredOn.push("in-process");
  if (isolated?.qualified === true) offeredOn.push("isolated");
  const why = [inProcess, isolated].flatMap((t) => (t === undefined ? [] : [`${t.host}: ${t.deciding ?? t.rating}`]));
  return {
    ...(inProcess === undefined ? {} : { inProcess }),
    ...(isolated === undefined ? {} : { isolated }),
    offeredOn,
    ...(offeredOn.length === 0 ? { dimmed: why.length === 0 ? "no tier was judged" : why.join("; ") } : {}),
  };
}

export function buildQualificationRecord(
  judgment: Judgment,
  copy: { file: string; sha256: string; bytes: number },
  notMeasured: readonly NotMeasured[] = [],
): QualificationRecord {
  const o = judgment.output;
  return {
    schema: QUALIFICATION_RECORD_SCHEMA,
    plugin: { format: o.plugin.format, id: o.plugin.id, ...(o.plugin.name === undefined ? {} : { name: o.plugin.name }) },
    ...(o.plugin.version === undefined ? {} : { testedVersion: o.plugin.version }),
    binary: o.binary,
    verdicts: judgment.hosts.map((h) => ({
      host: h.verdict.host,
      measured: h.verdict.measured,
      rating: h.verdict.rating,
      qualified: h.verdict.qualified,
      hosting: h.hosting,
      arm: h.arm,
      ...(h.verdict.deciding === undefined ? {} : { deciding: h.verdict.deciding }),
      reasons: h.reasons,
    })),
    ...(judgment.adapter === undefined ? {} : { adapter: judgment.adapter }),
    tiers: tiersOf(judgment),
    cost: judgment.hosts.map((h) => ({ host: h.verdict.host, ...h.cost })),
    measurements: {
      grid: o.grid.map((p) => ({ ...p, latency: latencyOfCell(o, p) })),
      ...(o.behaviour === undefined ? {} : { behaviour: o.behaviour }),
      ...(unmeasuredFigures(o).length === 0 ? {} : { unmeasured: unmeasuredFigures(o) }),
    },
    ...(notMeasured.length === 0 ? {} : { notMeasured }),
    tool: o.run.tools,
    measuredAt: o.run.startedAt,
    probe: {
      file: copy.file,
      sha256: copy.sha256,
      bytes: copy.bytes,
      protocol: o.run.protocol,
      ...(o.run.reason === undefined ? {} : { reason: o.run.reason }),
      outcome: o.run.outcome,
      complete: o.run.complete,
      machineClass: o.machine.class,
      meetsProtocol: o.machine.profile.meetsProtocol,
    },
  };
}

/** The record of a judgment, with the copy fields taken from the bytes that were judged. */
export function qualificationRecordOf(probeBytes: Uint8Array, judgment: Judgment): QualificationRecord {
  return buildQualificationRecord(judgment, { file: probeCopyFileName(judgment.output), sha256: sha256Hex(probeBytes), bytes: probeBytes.length });
}

/** The record rewritten whole or not at all, with its `history` block; nothing else in it is changed by the caller. */
export function rewriteRecord(path: string, record: QualificationRecord): void {
  writeFileWhole(path, `${JSON.stringify(record, null, 2)}\n`);
}

export interface WrittenQualification {
  readonly recordPath: string;
  readonly probePath: string;
  readonly record: QualificationRecord;
}

/**
 * Write the byte copy of the probe output, then the record that names it. The copy goes first, and the
 * record names the SHA-256 of the copy as it is on disk, read back, so a record never names bytes that
 * are not there. A rescan of the same binary and offer replaces both.
 */
export function writeQualification(
  dir: string,
  probeBytes: Uint8Array,
  judgment: Judgment,
  notMeasured: readonly NotMeasured[] = [],
): WrittenQualification {
  mkdirSync(dir, { recursive: true });
  const probePath = join(dir, probeCopyFileName(judgment.output));
  writeFileWhole(probePath, probeBytes);
  const copy = readFileSync(probePath);
  const record = buildQualificationRecord(judgment, { file: probeCopyFileName(judgment.output), sha256: sha256Hex(copy), bytes: copy.length }, notMeasured);
  const recordPath = join(dir, recordFileName(judgment.output));
  writeFileWhole(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return { recordPath, probePath, record };
}

/**
 * Runs that name the same binary and offer share one record file (a CLAP judged with and without the extra extensions
 * offered): their verdicts become one record over the first run's probe output, so the second is never written over the first.
 */
export function mergeRunsByRecord<T extends { readonly bytes: Uint8Array; readonly judgment: Judgment }>(runs: readonly T[]): { bytes: Uint8Array; judgment: Judgment }[] {
  const byName = new Map<string, { bytes: Uint8Array; judgment: Judgment }>();
  for (const r of runs) {
    const name = qualificationBaseName(r.judgment.output);
    const first = byName.get(name);
    byName.set(
      name,
      first === undefined
        ? r
        : {
            bytes: first.bytes,
            judgment: { ...first.judgment, hosts: [...first.judgment.hosts, ...r.judgment.hosts], documents: [...first.judgment.documents, ...r.judgment.documents] },
          },
    );
  }
  return [...byName.values()];
}
