// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The probe-output documents the tests build on, read from `fixtures/probe-output/`: plugin-hostd's
 * three example documents (a success on the reference rig, a crash, a refusal for memory). Kept
 * out of the test files so every test reads the same documents; a `.test.ts` imported for a helper
 * runs its whole suite in each importer.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ClapQualifyLine } from "./clap-qualify.js";
import { OMX_CLAP_HOST_EXTENSIONS } from "./host-profiles.js";
import { readProbeOutput, type ProbeOutput } from "./probe-output.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "probe-output");

export function fixtureText(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.json`), "utf8");
}

/** A fixture as a mutable JSON value, for the tests that break one field of it. */
export function fixtureJson(name: string): Record<string, any> {
  return JSON.parse(fixtureText(name));
}

/** A fixture through the reader; throws when the reader refuses it. */
export function readFixture(name: string): ProbeOutput {
  const r = readProbeOutput(fixtureText(name));
  if (!r.ok) throw new Error(`${name}: ${r.code}: ${r.problem}`);
  return r.output;
}

/**
 * The probe output that carries what a prober line carries, for the proofs that a verdict read from a
 * probe output equals the verdict read from today's document. Built on the success fixture, so its machine,
 * limits and run are a real document's.
 *
 * What the line holds and a probe output cannot is not encoded: the port layout and the features (no
 * verdict reads them), the note sweep's process errors and non-finite flag, and a block count apart
 * from the sweep's (the probe output has one, the blocks the sweep processed, which is `processCalls`).
 */
export function probeOutputOfLine(line: ClapQualifyLine): Record<string, any> {
  const doc = fixtureJson("success-msi");
  const rt = line.rtSafety;
  const note = line.noteSweep;
  const pin = line.integrity;
  const rates = Object.keys(line.clap.latency);
  const quantum = rt.blockFrames ?? 512;
  doc["plugin"] = { format: "clap", id: line.id, ...(pin.version === undefined ? {} : { version: pin.version }) };
  doc["binary"] = {
    path: line.binary.path,
    sha256: line.binary.sha256,
    files: pin.files ?? [],
    ...(pin.layout === undefined ? {} : { layout: pin.layout }),
    ...(pin.unmeasuredReason === undefined ? {} : { unpinnable: pin.unmeasuredDetail ?? pin.unmeasuredReason }),
  };
  delete doc["descriptor"];
  doc["offer"] = { id: "default", clapExtensions: [...line.hostExtensions], realtime: "none" };
  doc["steps"] = [{ step: "hash", outcome: "probe.ok", elapsedMs: 1 }, { step: "instantiate", outcome: "probe.ok", elapsedMs: 1 }];
  const first: Record<string, unknown> = {};
  if (rt.interposer) {
    Object.assign(first, {
      rtSafety: {
        interposer: true,
        swept: rt.swept,
        sweepApplicable: rt.sweepApplicable,
        blocks: line.clap.processCalls,
        allocations: rt.allocationsInRun,
        locks: rt.locksInRun,
        syscalls: rt.syscallsInRun,
        threadViolations: line.clap.threadViolations,
        processErrors: line.clap.processErrors,
        events: rt.events ?? [],
      },
    });
  } else first["rtSafety"] = { interposer: false };
  if (note.applicable) {
    first["noteSweep"] = {
      applicable: true,
      ...(note.dialect === undefined ? {} : { dialect: note.dialect }),
      ...(note.interposer === true ? { allocations: note.allocationsInRun, locks: note.locksInRun, syscalls: note.syscallsInRun } : {}),
    };
  }
  const at = rates.length > 0 ? rates : ["48000"];
  doc["grid"] = at.map((rate, i) => ({
    rate: Number(rate),
    quantum,
    outcome: "probe.ok",
    ...(line.clap.latency[rate] === undefined ? {} : { latency: { ...line.clap.latency[rate], method: "impulse-onset" } }),
    ...(i === 0 ? first : {}),
  }));
  return doc;
}

const PIN = {
  version: "1",
  files: [{ path: "rt-safe.clap", sha256: "a".repeat(64) }],
  layout: { scheme: "omx-layout/1", sha256: "b".repeat(64) },
};

/** A prober line for a clean stereo effect, with `patch` merged over it. */
export function clapLineFixture(patch: {
  rtSafety?: object;
  clap?: object;
  hostExtensions?: string[];
  noteSweep?: object;
  integrity?: object;
} = {}): ClapQualifyLine {
  return {
    uri: "urn:clap:org.example.fx",
    id: "org.example.fx",
    binary: { path: "/x/rt-safe.clap", sha256: "a".repeat(64) },
    hostExtensions: patch.hostExtensions ?? [...OMX_CLAP_HOST_EXTENSIONS],
    clap: {
      mainInputChannels: 2,
      mainOutputChannels: 2,
      sidechainInputs: 0,
      features: ["audio-effect"],
      headlessOk: true,
      noteInputs: 0,
      latency: { "48000": { declaredFrames: 0, measuredFrames: 0 }, "96000": { declaredFrames: 4, measuredFrames: 4 } },
      threadViolations: 0,
      processErrors: 0,
      processCalls: 512,
      nonFinite: false,
      ...patch.clap,
    },
    rtSafety: {
      interposer: true,
      swept: true,
      sweepApplicable: true,
      blocks: 512,
      blockFrames: 512,
      allocationsInRun: 0,
      locksInRun: 0,
      syscallsInRun: 0,
      events: [],
      ...patch.rtSafety,
    },
    noteSweep: { applicable: false, ...patch.noteSweep },
    integrity: { ...PIN, ...patch.integrity },
  };
}


/** One LV2 measurer line, as `lv2_measure` prints it: the keys the translation reads. */
export type Lv2MeasureLine = Record<string, any>;

/**
 * The probe output the runner writes for an LV2 measurer line: the grid point of the run's rate and block with what
 * run() did under the interposer, and, under the same field names as a CLAP point, the `latency` and `cost` the line holds
 * at that rate. A latency or cost the line could not take is no field of the point: it is a step that says so, with the
 * hosting code, and the run still ends `probe.ok`. The runner's translation in the small (plugin-hostd's `put_lv2_measure`), as
 * `probeOutputOfLine` is its CLAP one, so a record is read from a real measurement through the real reader.
 */
export function probeOutputOfLv2Line(line: Lv2MeasureLine): Record<string, any> {
  const doc = fixtureJson("success-msi");
  const rate = Number(line["rate"]);
  const quantum = Number(line["block"]);
  const rt = line["rtSafety"];
  const key = String(rate);
  const latency = line["latency"]?.[key];
  const cost = line["cost"]?.perRate?.[key];
  const pin = line["integrity"];
  doc["plugin"] = { format: "lv2", id: line["uri"], ...(pin?.version === undefined ? {} : { version: pin.version }) };
  doc["binary"] = {
    path: pin?.files?.find((f: { path: string }) => !f.path.endsWith(".ttl"))?.path ?? "plugin.so",
    sha256: pin?.files?.find((f: { path: string }) => !f.path.endsWith(".ttl"))?.sha256 ?? "0".repeat(64),
    files: pin?.files ?? [],
    ...(pin?.layout === undefined ? {} : { layout: pin.layout }),
  };
  delete doc["descriptor"];
  doc["offer"] = { id: "default", realtime: "none" };
  const steps: Record<string, unknown>[] = [
    { step: "hash", outcome: "probe.ok", elapsedMs: 1 },
    { step: "instantiate", outcome: "probe.ok", elapsedMs: 1 },
    { step: "rt-safety", rate, quantum, outcome: "probe.ok", elapsedMs: 1 },
  ];
  const absent = (step: "latency" | "cost", at: any): void => {
    steps.push({
      step,
      rate,
      quantum,
      outcome: "probe.not-attempted",
      elapsedMs: 1,
      hostingCode: step === "latency" ? "hosting.latency.unmeasured" : "hosting.cost.unmeasured-at-rate-and-quantum",
      detail: `${at?.unmeasuredReason ?? "not-attempted"}: ${at?.unmeasuredDetail ?? "the measurer's line holds no figure"}`,
    });
  };
  const point: Record<string, unknown> = { rate, quantum, outcome: "probe.ok" };
  if (latency?.measuredFrames !== undefined) {
    steps.push({ step: "latency", rate, quantum, outcome: "probe.ok", elapsedMs: 1 });
    point["latency"] = {
      declaredFrames: latency.declaredFrames,
      measuredFrames: latency.measuredFrames,
      method: latency.from === "note" ? "note-onset" : "impulse-onset",
      ...(latency.from === "note" ? { heard: true } : {}),
    };
  } else absent("latency", latency);
  if (cost?.nsPerSampleMedian !== undefined) {
    steps.push({ step: "cost", rate, quantum, outcome: "probe.ok", elapsedMs: 1 });
    point["cost"] = {
      unit: "ns-per-sample",
      median: cost.nsPerSampleMedian,
      percentile: { p: line["cost"].percentile, value: cost.nsPerSampleP95 },
      min: cost.nsPerSampleMin,
      max: cost.nsPerSampleMax,
      blocks: cost.blocks,
      warmupBlocks: line["cost"].warmupBlocks,
      ...(cost.voices === undefined ? {} : { voices: cost.voices }),
    };
  } else absent("cost", cost);
  if (rt !== undefined) {
    point["rtSafety"] = {
      interposer: rt.interposer,
      swept: rt.swept,
      sweepApplicable: rt.sweepApplicable,
      blocks: rt.blocks,
      allocations: rt.allocationsInRun,
      locks: rt.locksInRun,
      syscalls: rt.syscallsInRun,
      events: [],
    };
  }
  point["noteSweep"] = { applicable: rt?.noteSweep?.applicable === true };
  doc["steps"] = steps;
  doc["grid"] = [point];
  doc["behaviour"] = { lifecycle: line["lifecycle"], threads: line["threads"], features: { required: line["requiredFeatures"] ?? [] } };
  return doc;
}
