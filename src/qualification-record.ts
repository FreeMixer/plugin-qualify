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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Judgment, RecordReason } from "./probe-judge.js";
import { sha256Hex, type ProbeGridPoint, type ProbeOutput } from "./probe-output.js";
import type { VoicesHeld } from "./measurement/format.js";

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

export interface QualificationRecord {
  readonly schema: typeof QUALIFICATION_RECORD_SCHEMA;
  readonly plugin: { readonly format: string; readonly id: string; readonly name?: string };
  /** The plugin's version when it was tested; a newer installed one is shown as "tested on X, installed Y". */
  readonly testedVersion?: string;
  readonly binary: ProbeOutput["binary"];
  readonly verdicts: readonly RecordVerdict[];
  readonly tiers: RecordTiers;
  /** The cost reasons at each host's rate and quantum, beside the verdicts; an instrument's with the notes it held. */
  readonly cost: readonly {
    readonly host: string;
    readonly rate: number;
    readonly quantum: number;
    readonly voices?: VoicesHeld;
    readonly reasons: readonly RecordReason[];
  }[];
  /** The figures as measured, per rate and quantum. */
  readonly measurements: { readonly grid: readonly ProbeGridPoint[]; readonly behaviour?: Readonly<Record<string, unknown>> };
  /** Who measured and when. */
  readonly tool: Readonly<Record<string, string>>;
  readonly measuredAt: string;
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

export function buildQualificationRecord(judgment: Judgment, copy: { file: string; sha256: string; bytes: number }): QualificationRecord {
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
    tiers: tiersOf(judgment),
    cost: judgment.hosts.map((h) => ({ host: h.verdict.host, ...h.cost })),
    measurements: { grid: o.grid, ...(o.behaviour === undefined ? {} : { behaviour: o.behaviour }) },
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

/** A file whole or not at all: written beside its name and renamed over it. */
function writeWhole(path: string, bytes: string | Uint8Array): void {
  const pending = `${path}.new`;
  writeFileSync(pending, bytes);
  renameSync(pending, path);
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
export function writeQualification(dir: string, probeBytes: Uint8Array, judgment: Judgment): WrittenQualification {
  mkdirSync(dir, { recursive: true });
  const probePath = join(dir, probeCopyFileName(judgment.output));
  writeWhole(probePath, probeBytes);
  const copy = readFileSync(probePath);
  const record = buildQualificationRecord(judgment, { file: probeCopyFileName(judgment.output), sha256: sha256Hex(copy), bytes: copy.length });
  const recordPath = join(dir, recordFileName(judgment.output));
  writeWhole(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return { recordPath, probePath, record };
}
