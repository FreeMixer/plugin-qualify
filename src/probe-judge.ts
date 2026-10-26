// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Judging from a probe output. The probe output holds facts (`probe-output.ts`); this module turns
 * them into the facts the one judge already reads and lets that judge speak. There is no second
 * judge: a CLAP plugin's verdict is {@link rtSafetyDocument}'s fold of the same reasons it folds
 * for a prober line, an LV2 plugin's is {@link rtSafetyReasons}, and cost is read by
 * {@link hostingCostReasons} at the host's rate and quantum.
 *
 * What a probe output does not carry, this module does not invent:
 *
 * - `noteInputs` is the descriptor's fact. Without one the run's note sweep stands in: a plugin
 *   whose sweep was applicable has at least one note input; one whose sweep was not applicable is
 *   read as having none, so an instrument that could not be played reads as an effect. The caller
 *   that holds the descriptor passes the real count.
 * - The note sweep's block count is the parameter sweep's: both run in one prober process at one
 *   block count, and the schema holds the note sweep's counts but not its blocks.
 */
import { DEFAULT_HOSTING_POLICY } from "./qualify-declarations.js";
import {
  rtSafetyDocument,
  type ClapNoteSweepReading,
  type ClapQualifyLine,
  type ClapRtSafetyReading,
  type RtSafetyDocument,
} from "./clap-qualify.js";
import { gridCostReadings } from "./cost-fields.js";
import {
  hostingCostReasons,
  noteSweepReasons,
  rtSafetyReasons,
  contributedHostingRating,
  type HostingReason,
} from "./hosting-suitability.js";
import type { HostProfile } from "./host-profiles.js";
import { PROBE_NOT_ATTEMPTED, PROBE_OK, type ProbeGridPoint, type ProbeOutput } from "./probe-output.js";
import type { QualifyVerdict } from "./qualify-cli.js";
import { RATING_SEVERITY, worstRating, type SuitabilityRating } from "./rating.js";
import type { IntegrityMeasurement, VoicesHeld } from "./measurement/format.js";

/** Facts of the descriptor, which the probe output repeats none of. */
export interface JudgeFacts {
  /** Note input ports the plugin declares. */
  readonly noteInputs?: number;
}

/** A sum of one count over the points, or `undefined` when a point lacks it: a missing count is not zero. */
function total(points: readonly ProbeGridPoint[], count: (p: ProbeGridPoint) => number | undefined): number | undefined {
  let sum = 0;
  for (const p of points) {
    const n = count(p);
    if (n === undefined) return undefined;
    sum += n;
  }
  return sum;
}

/** The points whose run ended well: a point that crashed measured nothing. */
function okPoints(output: ProbeOutput): ProbeGridPoint[] {
  return output.grid.filter((p) => p.outcome === PROBE_OK);
}

/**
 * The interposer's counts over every grid point that carries them. The interposer must have been
 * loaded at every such point; the sweep counts as done when every point swept, and as applicable
 * when any did. A count a point lacks leaves the total absent, and the judge reads that as
 * unmeasured.
 */
export function rtSafetyOfProbeOutput(output: ProbeOutput): ClapRtSafetyReading {
  const points = okPoints(output).filter((p) => p.rtSafety !== undefined);
  if (points.length === 0 || points.some((p) => p.rtSafety?.interposer !== true)) return { interposer: false };
  const reading = (p: ProbeGridPoint) => p.rtSafety;
  const allocations = total(points, (p) => reading(p)?.allocations);
  const locks = total(points, (p) => reading(p)?.locks);
  const syscalls = total(points, (p) => reading(p)?.syscalls);
  return {
    interposer: true,
    swept: points.every((p) => reading(p)?.swept === true),
    sweepApplicable: points.some((p) => reading(p)?.sweepApplicable === true),
    blocks: total(points, (p) => reading(p)?.blocks ?? 0) ?? 0,
    blockFrames: points[0]?.quantum ?? 0,
    ...(allocations === undefined ? {} : { allocationsInRun: allocations }),
    ...(locks === undefined ? {} : { locksInRun: locks }),
    ...(syscalls === undefined ? {} : { syscallsInRun: syscalls }),
    events: points.flatMap((p) => reading(p)?.events ?? []),
  };
}

function noteSweepOfProbeOutput(output: ProbeOutput, rt: ClapRtSafetyReading): ClapNoteSweepReading {
  const played = okPoints(output).find((p) => p.noteSweep?.applicable === true)?.noteSweep;
  if (played === undefined) return { applicable: false };
  const dialect: { dialect?: "clap" | "midi" } = {};
  if (played.dialect === "clap" || played.dialect === "midi") dialect.dialect = played.dialect;
  const base = { applicable: true, ...dialect, blocks: rt.blocks ?? 0, blockFrames: rt.blockFrames ?? 0, noteEvents: 0, processErrors: 0, nonFinite: false };
  if (!rt.interposer) return { ...base, interposer: false };
  return {
    ...base,
    interposer: true,
    ...(played.allocations === undefined ? {} : { allocationsInRun: played.allocations }),
    ...(played.locks === undefined ? {} : { locksInRun: played.locks }),
    ...(played.syscalls === undefined ? {} : { syscallsInRun: played.syscalls }),
  };
}

/** The pin a probe output took: its files and layout, or why it has none. */
export function integrityOfProbeOutput(output: ProbeOutput): IntegrityMeasurement {
  const { files, layout, unpinnable } = output.binary;
  if (layout === undefined || files.length === 0) {
    return { unmeasuredReason: unpinnable === undefined ? "probe-error" : "unpinnable", unmeasuredDetail: unpinnable ?? "the probe output holds no layout pin" };
  }
  return {
    ...(output.plugin.version === undefined ? {} : { version: output.plugin.version }),
    files: files.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    layout,
  };
}

/**
 * A CLAP probe output as the prober's line it stands for, so that {@link rtSafetyDocument} judges it.
 * The facts the line holds and a probe output does not (the port layout, the features) are not read
 * by the rtSafety fold and are left empty here.
 */
export function clapLineFromProbeOutput(output: ProbeOutput, facts: JudgeFacts = {}): ClapQualifyLine {
  const rtSafety = rtSafetyOfProbeOutput(output);
  const noteSweep = noteSweepOfProbeOutput(output, rtSafety);
  const points = okPoints(output);
  const latency: Record<string, { declaredFrames: number; measuredFrames: number }> = {};
  for (const p of points) {
    if (p.latency !== undefined && latency[String(p.rate)] === undefined) latency[String(p.rate)] = p.latency;
  }
  const withRt = points.filter((p) => p.rtSafety !== undefined);
  return {
    uri: `urn:clap:${output.plugin.id}`,
    id: output.plugin.id,
    binary: { path: output.binary.path, sha256: output.binary.sha256 },
    hostExtensions: output.offer.clapExtensions ?? [],
    clap: {
      mainInputChannels: 0,
      mainOutputChannels: 0,
      sidechainInputs: 0,
      features: [],
      headlessOk: output.steps.some((s) => s.step === "instantiate" && s.outcome === PROBE_OK),
      noteInputs: facts.noteInputs ?? (noteSweep.applicable ? 1 : 0),
      latency,
      threadViolations: total(withRt, (p) => p.rtSafety?.threadViolations ?? 0) ?? 0,
      processErrors: total(withRt, (p) => p.rtSafety?.processErrors ?? 0) ?? 0,
      // the sweep ran as many blocks as the points that counted say; a run with none measured nothing
      processCalls: rtSafety.interposer ? (rtSafety.blocks ?? 0) : points.length,
      nonFinite: output.steps.some((s) => s.outcome === "probe.non-finite-output"),
    },
    rtSafety,
    noteSweep,
    integrity: integrityOfProbeOutput(output),
  };
}

/** One reason as the record writes it: the code is a string since a failed run's reason is the run's outcome code. */
export interface RecordReason {
  readonly dimension: string;
  readonly rating: SuitabilityRating;
  readonly code: string;
  readonly params: Readonly<Record<string, string | number>>;
}

const asRecordReason = (r: HostingReason): RecordReason => ({ dimension: r.dimension, rating: contributedHostingRating(r), code: r.code, params: r.params });

/** What one host profile makes of one probe output. */
export interface HostJudgment {
  readonly verdict: QualifyVerdict;
  /** In-process only for a suitable plugin on a host that runs its plugins in its own process, else isolated. */
  readonly hosting: "in-process" | "isolated";
  readonly reasons: readonly RecordReason[];
  /**
   * The cost reasons at this host's rate and quantum, kept beside the verdict, not folded into it; for an instrument,
   * the notes it held while that figure was timed.
   */
  readonly cost: { readonly rate: number; readonly quantum: number; readonly voices?: VoicesHeld; readonly reasons: readonly RecordReason[] };
}

export interface Judgment {
  readonly output: ProbeOutput;
  readonly hosts: readonly HostJudgment[];
  /** For a CLAP plugin, the document of each host that today's judge writes; the pins are taken from these. */
  readonly documents: readonly RtSafetyDocument[];
}

function decidingOf(reasons: readonly RecordReason[], rating: SuitabilityRating): RecordReason | undefined {
  if (rating === "suitable") return undefined;
  return [...reasons].sort((a, b) => RATING_SEVERITY[b.rating] - RATING_SEVERITY[a.rating]).find((r) => r.rating === rating);
}

function costOf(output: ProbeOutput, profile: HostProfile): HostJudgment["cost"] {
  const { rate, quantum } = profile.cost;
  const reasons = hostingCostReasons(
    { cpuCost: { perRateQuantum: gridCostReadings(output.grid, PROBE_OK) } },
    { rate, quantum, profile },
    DEFAULT_HOSTING_POLICY,
  );
  const voices = output.grid.find((p) => p.outcome === PROBE_OK && p.rate === rate && p.quantum === quantum)?.cost?.voices;
  return { rate, quantum, ...(voices === undefined ? {} : { voices }), reasons: reasons.map(asRecordReason) };
}

/**
 * The outcome that ended the run badly, or `undefined` when it ended well. The run's own outcome is the
 * first word; a grid point that failed under a run that says `probe.ok` is a document that contradicts
 * itself, and is read as the failure it records rather than as a pass that skipped the point.
 */
function failedOutcome(output: ProbeOutput): string | undefined {
  if (output.run.outcome !== PROBE_OK) return output.run.outcome;
  return output.grid.find((p) => p.outcome !== PROBE_OK && p.outcome !== PROBE_NOT_ATTEMPTED)?.outcome;
}

/**
 * Every profile's judgment of one probe output.
 *
 * A run that did not end `probe.ok` is `unknown` under every profile, with the run's outcome code as
 * the reason: the measurement did not finish, so there is nothing to rate, and it is not a plugin
 * `unsuitable` on evidence the run never gathered. A step that was not attempted is part of a run that
 * ended well (a plugin with no note input has no note sweep).
 */
export function judgeProbeOutput(output: ProbeOutput, profiles: readonly HostProfile[], facts: JudgeFacts = {}): Judgment {
  const uri = output.plugin.format === "clap" ? `urn:clap:${output.plugin.id}` : output.plugin.id;
  const failure = failedOutcome(output);
  if (failure !== undefined) {
    const reason: RecordReason = { dimension: "rtSafety", rating: "unknown", code: failure, params: {} };
    return {
      output,
      documents: [],
      hosts: profiles.map((profile) => ({
        verdict: { uri, host: profile.id, measured: false, rating: "unknown", qualified: false, deciding: failure },
        hosting: "isolated",
        reasons: [reason],
        cost: costOf(output, profile),
      })),
    };
  }
  const line = output.plugin.format === "clap" ? clapLineFromProbeOutput(output, facts) : undefined;
  const documents: RtSafetyDocument[] = [];
  const hosts = profiles.map((profile): HostJudgment => {
    let reasons: RecordReason[];
    if (line !== undefined) {
      const doc = rtSafetyDocument(line, profile);
      documents.push(doc);
      reasons = doc.verdict.reasons.map(asRecordReason);
    } else {
      // an LV2 plugin: the control sweep's counts, and the note sweep's when it was played through a MIDI input
      const rt = rtSafetyOfProbeOutput(output);
      const notes = noteSweepOfProbeOutput(output, rt);
      reasons = [...rtSafetyReasons(rt), ...noteSweepReasons(notes, facts.noteInputs ?? (notes.applicable ? 1 : 0))].map(asRecordReason);
    }
    const rating = worstRating(reasons.map((r) => r.rating));
    const deciding = decidingOf(reasons, rating);
    return {
      verdict: {
        uri,
        host: profile.id,
        measured: true,
        rating,
        qualified: rating === "suitable",
        ...(deciding === undefined ? {} : { deciding: deciding.code }),
      },
      hosting: rating === "suitable" && profile.isolation === "in-process" ? "in-process" : "isolated",
      reasons,
      cost: costOf(output, profile),
    };
  });
  return { output, hosts, documents };
}

/** The verdict rows of a judgment, as the CLI prints them. */
export function judgmentVerdicts(judgment: Judgment): QualifyVerdict[] {
  return judgment.hosts.map((h) => h.verdict);
}
