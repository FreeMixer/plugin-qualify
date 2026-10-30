// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Keeping a device's records through an upgrade, by value. The re-judge reads records a Raspberry Pi 5 wrote under
 * plugin-qualify 0.16.1 (`fixtures/records-0.16.1/`), when an RT violation was unsuitable and the isolated tier of an LV2
 * plugin was mod-host's, through the run a device makes (`runSync`), with no measuring tool on the path. The memory-only
 * pass runs through a stand-in for the probe runner that writes a document and says what it was asked; the probers as
 * built are in `memory-footprint-native.test.ts`.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { HOSTING_CODE } from "./hosting-codes.js";
import { parsePinLine } from "./pins-file.js";
import { fixtureJson } from "./probe-output-fixtures.js";
import type { ProbeRun } from "./probe-runner.js";
import { sha256Hex } from "./probe-output.js";
import { MEMORY_PASS_NOT_MEASURED, OWED_CODE, OWED_SCHEMA, owedFile, rejudgeRecord } from "./qualify-rejudge.js";
import type { QualificationRecord } from "./qualification-record.js";
import { MEMORY_PASS_PROBE_NOTES } from "./qualify-declarations.js";
import { SYNC_STATE_SCHEMA, parseSyncArgs, resolveSyncSettings, runSync, summaryLine, type SyncEntry, type SyncPlugin, type SyncSettings, type SyncState } from "./qualify-sync.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "records-0.16.1");
const CLAP_RT = "in.lsp-plug.impulse_responses_mono@unversioned-d5235d2f5f53.custom";
const CLAP_NOTES = "in.lsp-plug.trigger_midi_mono@unversioned-d5235d2f5f53.custom";
const LV2_RT = "https___github.com_lucianodato_noise-repellent@unversioned-c3b5e21dd9a7.default";
const LV2_CRASHED = "http___example.org_raffo@unversioned-2060c09ff626.default";
const LV2_CLEAN = "http___lv2plug.in_plugins_eg-amp@unversioned-f046a60efd45.default";

const scratch = mkdtempSync(join(tmpdir(), "qualify-rejudge-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let devices = 0;

const recordFile = (stem: string): string => `${stem}.qualification.json`;
const probeFile = (stem: string): string => `${stem}.probe.json`;
const readJson = <T = QualificationRecord>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const stored = (stem: string): QualificationRecord => readJson(join(FIXTURES, recordFile(stem)));
const adapterAdmitted = { host: "omx-clap-host", measured: true, admitted: true, params: {} };

interface Device {
  readonly settings: SyncSettings;
  readonly dir: string;
  readonly record: (stem: string) => QualificationRecord;
  readonly pins: () => ReturnType<typeof parsePinLine>[];
  readonly state: () => SyncState;
}

/**
 * A device holding the given records, with a state that names each, its files on disk as they were recorded and its pin
 * the word the record's run gave. `patch` changes a record before it is stored (an adapter run a later plugin-qualify took).
 */
function device(stems: readonly string[], options: { patch?: (r: QualificationRecord) => QualificationRecord; host?: string } = {}): Device {
  const root = join(scratch, `device-${String(++devices)}`);
  const dir = join(root, "qualification");
  mkdirSync(dir, { recursive: true });
  const entries: Record<string, SyncEntry> = {};
  for (const stem of stems) {
    copyFileSync(join(FIXTURES, probeFile(stem)), join(dir, probeFile(stem)));
    const record = (options.patch ?? ((r) => r))(stored(stem));
    writeFileSync(join(dir, recordFile(stem)), `${JSON.stringify(record, null, 2)}\n`);
    const bundle = join(root, "plugins", stem);
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, "plugin.bin"), stem);
    const st = statSync(join(bundle, "plugin.bin"));
    const file = { path: "plugin.bin", sha256: sha256Hex(Buffer.from(stem)), size: st.size, mtimeMs: st.mtimeMs, ino: st.ino };
    const uri = record.plugin.format === "clap" ? `clap:${join(bundle, "plugin.clap")}#${record.plugin.id}` : record.plugin.id;
    const was = record.verdicts.find((v) => v.host === "omx-clap-host")!;
    const plugin: SyncPlugin = {
      uri,
      outcome: was.rating === "unsuitable" ? "refused" : was.measured ? "qualified" : "crashed",
      ...(was.deciding === undefined ? {} : { code: was.deciding }),
      pin: { uri, integrity: { files: [{ path: file.path, sha256: file.sha256 }], layout: { scheme: "omx-layout/1", sha256: "0".repeat(64) } }, ...(was.rating === "unsuitable" ? { verdict: "refused" as const } : was.rating === "suitable" ? { verdict: "in-process" as const } : {}) },
      record: join(dir, recordFile(stem)),
    };
    entries[`${record.plugin.format}:${stem}`] = { format: record.plugin.format as "clap" | "lv2", root: bundle, files: [file], plugins: [plugin], qualifiedAt: "2026-10-28T20:00:00.000Z", seconds: 1 };
  }
  const stateFile = join(root, "qualify-sync.json");
  const state: SyncState = { schema: SYNC_STATE_SCHEMA, entries };
  writeFileSync(stateFile, `${JSON.stringify(state, null, 1)}\n`);
  const args = parseSyncArgs([]);
  if (!args.ok) throw new Error(args.error);
  const conf = new Map([
    ["qualification_dir", dir],
    ["state_file", stateFile],
    ["pin_file", join(root, "qualified.pins")],
    ["descriptor_dir", join(root, "descriptors")],
    ["lv2_path", join(root, "none")],
    ["lv2_extra", ""],
    ["clap_path", join(root, "none")],
    ["hostd_port", "0"],
    ["budget_s", "17"],
    ["memory_limit", "2G"],
    ...(options.host === undefined ? [] : [["host_profile", options.host] as [string, string]]),
  ]);
  const r = resolveSyncSettings(conf, args.args, {}, scratch);
  if (!r.ok) throw new Error(r.error);
  return {
    settings: r.settings,
    dir,
    record: (stem) => readJson(join(dir, recordFile(stem))),
    pins: () => readFileSync(r.settings.pinFile, "utf8").split("\n").map(parsePinLine).filter((p) => p !== undefined),
    state: () => readJson<SyncState>(stateFile),
  };
}

/** The re-judge as a device runs it, with no tool to measure with and plugin-hostd naming no pin's files. */
const rejudge = (d: Device) =>
  runSync(d.settings, { rejudge: true, env: { OMX_PROBE_RUNNER: "/nonexistent", OMX_CLAP_QUALIFY: "/nonexistent" }, pinFilesRun: () => ({ status: 1, stdout: "", stderr: "" }) });

const row = (r: QualificationRecord, host: string) => r.verdicts.find((v) => v.host === host)!;
const owesOf = (r: QualificationRecord) => r.rejudged?.owes?.map((o) => o.measurement) ?? [];

describe("--rejudge: a record judged unsuitable for RT violations", () => {
  it("in run: conditional, isolated, pinned isolated, and the state says qualified with the code", async () => {
    expect(row(stored(CLAP_RT), "omx-clap-host")).toMatchObject({ rating: "unsuitable", deciding: HOSTING_CODE.rtSafetyViolations });
    const d = device([CLAP_RT]);
    await rejudge(d);
    const r = d.record(CLAP_RT);
    expect(row(r, "omx-clap-host")).toMatchObject({ rating: "conditional", hosting: "isolated", measured: true, deciding: HOSTING_CODE.rtSafetyViolations });
    expect(d.pins()[0]!.verdict).toBe("isolated");
    expect(Object.values(d.state().entries)[0]!.plugins[0]).toMatchObject({ outcome: "qualified", code: HOSTING_CODE.rtSafetyViolations });
  });

  it("under notes: the same", async () => {
    const d = device([CLAP_NOTES]);
    await rejudge(d);
    expect(row(d.record(CLAP_NOTES), "omx-clap-host")).toMatchObject({ rating: "conditional", hosting: "isolated", deciding: HOSTING_CODE.rtSafetyNotesViolations });
    expect(d.pins()[0]!.verdict).toBe("isolated");
  });

  it("an LV2 plugin with its adapter run: the same, the mod-host run kept and read by the new rule", async () => {
    const d = device([LV2_RT], { patch: (r) => ({ ...r, adapter: adapterAdmitted } as QualificationRecord) });
    await rejudge(d);
    const r = d.record(LV2_RT);
    expect(row(r, "omx-clap-host")).toMatchObject({ rating: "conditional", hosting: "isolated", arm: "run", deciding: HOSTING_CODE.rtSafetyViolations });
    expect(owesOf(r)).toEqual([]);
    expect(row(r, "mod-host")).toMatchObject({ rating: "unsuitable", arm: "run", deciding: "mod-host.no-answer" });
    expect(d.pins()[0]!.verdict).toBe("isolated");
  });
});

describe("--rejudge: what it says about itself", () => {
  it("names who took the figures and when, and leaves the figures, the probe copy and their provenance as they were", async () => {
    const d = device([CLAP_RT]);
    const was = stored(CLAP_RT);
    const copy = readFileSync(join(d.dir, probeFile(CLAP_RT)));
    await rejudge(d);
    const r = d.record(CLAP_RT);
    expect(r.rejudged).toMatchObject({ figures: { tool: { runner: "plugin-hostd-probe 0.13.1", child: "clap-qualify" }, measuredAt: was.measuredAt } });
    expect(r.rejudged!.figures.runId).toBe(readJson<{ run: { id: string } }>(join(d.dir, probeFile(CLAP_RT))).run.id);
    expect(r.rejudged!.by).toMatch(/^plugin-qualify \d+\.\d+\.\d+/);
    expect(r.measurements).toEqual(was.measurements);
    expect(r.probe).toEqual(was.probe);
    expect(r.tool).toEqual(was.tool);
    expect(r.measuredAt).toBe(was.measuredAt);
    expect(r.notMeasured).toEqual(was.notMeasured);
    expect(readFileSync(join(d.dir, probeFile(CLAP_RT))).equals(copy)).toBe(true);
  });

  it("a verdict with no soak does not read as soaked: the record still says the soak was not measured", async () => {
    const d = device([CLAP_RT]);
    await rejudge(d);
    expect(d.record(CLAP_RT).notMeasured).toContainEqual({ dimension: "stability", code: HOSTING_CODE.stabilityUnsoaked });
  });
});

describe("--rejudge: a crash", () => {
  it("under its host stays unsuitable and refused, whatever the figures say", async () => {
    const crash = { host: "omx-clap-host", measured: true, admitted: false, code: "omx-clap-host.signal-SIGSEGV", params: { step: "add" } };
    const d = device([LV2_CLEAN], { patch: (r) => ({ ...r, adapter: crash } as QualificationRecord) });
    await rejudge(d);
    const r = d.record(LV2_CLEAN);
    expect(row(r, "omx-clap-host")).toMatchObject({ rating: "unsuitable", qualified: false, arm: "run", deciding: "omx-clap-host.signal-SIGSEGV" });
    expect(row(r, "openmixer-pi-8gb")).toMatchObject({ rating: "unsuitable", deciding: "omx-clap-host.signal-SIGSEGV" });
    expect(r.tiers.offeredOn).toEqual([]);
    expect(d.pins()[0]!.verdict).toBe("refused");
    expect(Object.values(d.state().entries)[0]!.plugins[0]).toMatchObject({ outcome: "refused", code: "omx-clap-host.signal-SIGSEGV" });
  });

  it("under the mod-host run stays unsuitable", async () => {
    const signal = (r: QualificationRecord): QualificationRecord => ({
      ...r,
      verdicts: r.verdicts.map((v) => (v.host === "mod-host" ? { ...v, rating: "unsuitable", arm: "run", deciding: "mod-host.signal-SIGABRT", reasons: [{ dimension: "hostAdmission", rating: "unsuitable", code: "mod-host.signal-SIGABRT", params: {} }] } : v)),
    });
    const d = device([LV2_CLEAN], { patch: signal });
    await rejudge(d);
    expect(row(d.record(LV2_CLEAN), "mod-host")).toMatchObject({ rating: "unsuitable", arm: "run", deciding: "mod-host.signal-SIGABRT" });
  });

  it("in the probe, which took no figures, is judged as the run is: not measured, no word, the state's outcome still crashed, nothing owed", async () => {
    const d = device([LV2_CRASHED]);
    await rejudge(d);
    const r = d.record(LV2_CRASHED);
    expect(row(r, "omx-clap-host")).toMatchObject({ rating: "unknown", measured: false, qualified: false, deciding: "probe.crashed" });
    expect(row(r, "openmixer-pi-8gb")).toMatchObject({ rating: "unknown", measured: false, deciding: "probe.crashed" });
    expect(r.tiers.offeredOn).toEqual([]);
    expect(d.pins()[0]!.verdict).toBeUndefined();
    expect(Object.values(d.state().entries)[0]!.plugins[0]).toMatchObject({ outcome: "crashed", code: "probe.crashed" });
    expect(owesOf(r)).toEqual([]);
  });
});

describe("--rejudge: memory", () => {
  it("no figure reads unknown on every host with a budget, never as fitting", async () => {
    const d = device([CLAP_RT]);
    await rejudge(d);
    const r = d.record(CLAP_RT);
    for (const host of ["openmixer-pi-4gb", "openmixer-pi-8gb"]) {
      expect(row(r, host)).toMatchObject({ rating: "unknown", qualified: false, deciding: HOSTING_CODE.memoryUnmeasured });
    }
    const codes = row(r, "openmixer-pi-8gb").reasons.map((x) => x.code);
    expect(codes).not.toContain(HOSTING_CODE.memoryWithinCeiling);
    expect(codes).not.toContain(HOSTING_CODE.memoryWithinProvisionalCeiling);
  });

  it("a host with no budget is not judged on it: omx-clap-host's verdict is the figures'", async () => {
    const d = device([CLAP_RT]);
    await rejudge(d);
    expect(row(d.record(CLAP_RT), "omx-clap-host").reasons.map((x) => x.dimension)).not.toContain("memory");
  });
});

describe("--rejudge: a tier lacking its adapter run", () => {
  it("is listed as owed, the verdict unknown, the tier not offered, the pin with no word: nothing guessed", async () => {
    const d = device([LV2_CLEAN]);
    expect(row(stored(LV2_CLEAN), "omx-clap-host").rating).toBe("suitable");
    const summary = await rejudge(d);
    const r = d.record(LV2_CLEAN);
    expect(row(r, "omx-clap-host")).toMatchObject({ rating: "unknown", qualified: false, arm: "declaration", deciding: OWED_CODE.adapterRun });
    expect(r.tiers.isolated).toMatchObject({ host: "omx-clap-host", qualified: false, deciding: OWED_CODE.adapterRun });
    expect(r.tiers.offeredOn).toEqual([]);
    expect(r.tiers.dimmed).toContain(OWED_CODE.adapterRun);
    expect(r.rejudged!.owes).toEqual([{ measurement: "adapter-run", host: "omx-clap-host", code: OWED_CODE.adapterRun }]);
    expect(d.pins()[0]!.verdict).toBeUndefined();
    expect(Object.values(d.state().entries)[0]!.plugins[0]).toMatchObject({ outcome: "unmeasured", code: OWED_CODE.adapterRun });
    expect(summary!.rejudge).toEqual({ changed: 1, unchanged: 0, owing: 1 });
    expect(readJson(owedFile(d.settings.stateFile))).toEqual({
      schema: OWED_SCHEMA,
      owing: [{ plugin: stored(LV2_CLEAN).plugin.id, record: recordFile(LV2_CLEAN), owes: [{ measurement: "adapter-run", host: "omx-clap-host", code: OWED_CODE.adapterRun }] }],
    });
    expect(summaryLine(summary!)).toContain("rejudged 1, unchanged 0, owing 1");
  });

  it("an adapter that could not run owes it too, saying what the last try was", async () => {
    const notRun = { host: "omx-clap-host", measured: false, admitted: false, code: "omx-clap-host.not-started", params: {} };
    const d = device([LV2_CLEAN], { patch: (r) => ({ ...r, adapter: notRun } as QualificationRecord) });
    await rejudge(d);
    expect(d.record(LV2_CLEAN).rejudged!.owes).toEqual([{ measurement: "adapter-run", host: "omx-clap-host", code: OWED_CODE.adapterRun, detail: "omx-clap-host.not-started" }]);
    expect(row(d.record(LV2_CLEAN), "omx-clap-host").rating).toBe("unknown");
  });

  it("the control: the same record with its run qualifies, and owes nothing", async () => {
    const d = device([LV2_CLEAN], { patch: (r) => ({ ...r, adapter: adapterAdmitted } as QualificationRecord) });
    await rejudge(d);
    const r = d.record(LV2_CLEAN);
    expect(row(r, "omx-clap-host")).toMatchObject({ rating: "suitable", qualified: true, arm: "run" });
    expect(r.tiers.offeredOn).toEqual(["isolated"]);
    expect(owesOf(r)).toEqual([]);
    expect(d.pins()[0]!.verdict).toBe("in-process");
  });

  it("a CLAP plugin owes no adapter run, and an RT violation is still seen beside an owed run", async () => {
    const clap = device([CLAP_RT]);
    await rejudge(clap);
    expect(owesOf(clap.record(CLAP_RT))).toEqual([]);
    const lv2 = device([LV2_RT]);
    await rejudge(lv2);
    const r = row(lv2.record(LV2_RT), "omx-clap-host");
    expect(r).toMatchObject({ rating: "unknown", deciding: OWED_CODE.adapterRun });
    expect(r.reasons.map((x) => [x.code, x.rating])).toContainEqual([HOSTING_CODE.rtSafetyViolations, "conditional"]);
  });
});

describe("--rejudge: what it cannot stand on is left alone", () => {
  it("a plugin whose bytes changed: the record and the pin untouched, a qualification owed", async () => {
    const d = device([CLAP_RT]);
    const before = readFileSync(join(d.dir, recordFile(CLAP_RT)));
    writeFileSync(join(Object.values(d.state().entries)[0]!.root, "plugin.bin"), "another build");
    const summary = await rejudge(d);
    expect(readFileSync(join(d.dir, recordFile(CLAP_RT))).equals(before)).toBe(true);
    expect(d.pins()[0]!.verdict).toBe("refused");
    expect(summary!.rejudge).toEqual({ changed: 0, unchanged: 0, owing: 1 });
    expect(readJson<{ owing: { owes: { code: string }[] }[] }>(owedFile(d.settings.stateFile)).owing[0]!.owes[0]!.code).toBe(OWED_CODE.bytesChanged);
  });

  it("a probe output that is not the copy the record names: the same", async () => {
    const d = device([CLAP_RT]);
    const before = readFileSync(join(d.dir, recordFile(CLAP_RT)));
    writeFileSync(join(d.dir, probeFile(CLAP_RT)), readFileSync(join(d.dir, probeFile(CLAP_RT)), "utf8").replace("\"allocations\"", "\"allocations\" "));
    await rejudge(d);
    expect(readFileSync(join(d.dir, recordFile(CLAP_RT))).equals(before)).toBe(true);
    expect(readJson<{ owing: { owes: { code: string }[] }[] }>(owedFile(d.settings.stateFile)).owing[0]!.owes[0]!.code).toBe(OWED_CODE.figuresUnreadable);
  });
});

describe("--rejudge: a second run", () => {
  it("changes nothing: every file the same bytes and the same modification time", async () => {
    const stems = [CLAP_RT, CLAP_NOTES, LV2_RT, LV2_CRASHED, LV2_CLEAN];
    const d = device(stems, { host: "omx-clap-host" });
    await rejudge(d);
    const paths = [...stems.flatMap((s) => [recordFile(s), probeFile(s)]).map((f) => join(d.dir, f)), d.settings.stateFile, d.settings.pinFile, owedFile(d.settings.stateFile)];
    const before = paths.map((p) => [p, readFileSync(p, "utf8"), statSync(p).mtimeMs]);
    await new Promise((r) => setTimeout(r, 20));
    const summary = await rejudge(d);
    expect(paths.map((p) => [p, readFileSync(p, "utf8"), statSync(p).mtimeMs])).toEqual(before);
    expect(summary!.rejudge).toEqual({ changed: 0, unchanged: 5, owing: 2 });
  });

  it("the function itself returns the record it was given", () => {
    const bytes = readFileSync(join(FIXTURES, probeFile(CLAP_RT)));
    const opts = { host: "omx-clap-host", by: "plugin-qualify 9.9.9", at: "2026-10-31T00:00:00.000Z" };
    const once = rejudgeRecord(stored(CLAP_RT), bytes, opts).record;
    const reread = JSON.parse(JSON.stringify(once)) as QualificationRecord;
    expect(rejudgeRecord(reread, bytes, { ...opts, at: "2030-01-01T00:00:00.000Z" }).record).toBe(reread);
  });
});

// --- the memory-only pass ---------------------------------------------------------------------------------------------

const FOOTPRINT = { afterInstantiateKb: 700, afterActivateKb: 900, atRestKb: 950, secondInstanceKb: 300 };

/** A stand-in for the runner: writes the document of the cells it is asked for, and notes what it was asked. */
function fakeRunner(id: string, sha: string, format: string, seen: { args: readonly string[]; env: Readonly<Record<string, string | undefined>> }[], ending: "ok" | "crash" | "none" = "ok"): ProbeRun {
  return (_tool, args, env) => {
    seen.push({ args, env });
    if (ending === "none") return { status: 2, stderr: "no such limit" };
    const at = (flag: string): string => args[args.indexOf(flag) + 1]!;
    const doc = fixtureJson("success-msi");
    doc["plugin"] = { format, id };
    doc["binary"] = { path: "/x", sha256: sha, files: [] };
    doc["offer"] = { id: args.includes("--offer") ? "custom" : "default" };
    doc["run"]["id"] = "memory-run-1";
    doc["run"]["startedAt"] = "2026-10-31T01:00:00+00:00";
    doc["run"]["tools"] = { runner: "plugin-hostd-probe 0.15.3", child: format === "clap" ? "clap-qualify" : "lv2_measure" };
    doc["steps"] = [];
    if (ending === "crash") {
      doc["run"]["outcome"] = "probe.crashed";
      doc["run"]["complete"] = false;
      doc["grid"] = [];
    } else {
      doc["grid"] = at("--rates").split(",").map((rate) => ({ rate: Number(rate), quantum: Number(at("--quantum")), outcome: "probe.ok", memory: FOOTPRINT }));
    }
    writeFileSync(at("--out"), JSON.stringify(doc));
    return { status: ending === "crash" ? 1 : 0, stderr: "" };
  };
}

const memoryEnv = { OMX_CLAP_QUALIFY: "/bin/true", OMX_RT_INTERPOSE: "/bin/true", OMX_PROBE_RUNNER: "/bin/true", OMX_LV2_MEASURE: "/bin/true" };
const memoryPassOf = (d: Device, run: ProbeRun, force = false) => runSync(d.settings, { memoryOnly: true, force, env: memoryEnv, probeRun: run, pinFilesRun: () => ({ status: 1, stdout: "", stderr: "" }) });
const idOf = (stem: string): { id: string; sha: string; format: string } => {
  const r = stored(stem);
  return { id: r.plugin.id, sha: r.binary.sha256, format: r.plugin.format };
};
const cell = (r: QualificationRecord, quantum: number) => r.measurements.grid.find((p) => p.rate === 48000 && p.quantum === quantum);

describe("--memory-only", () => {
  it("merges the footprint at 48000/128 and 48000/256 and leaves every other figure byte for byte", async () => {
    const d = device([CLAP_RT]);
    const { id, sha, format } = idOf(CLAP_RT);
    const path = join(d.dir, recordFile(CLAP_RT));
    const was = readJson(path);
    const copy = readFileSync(join(d.dir, probeFile(CLAP_RT)));
    expect(was.measurements.grid.map((p) => p.quantum)).toEqual([512]);
    const summary = await memoryPassOf(d, fakeRunner(id, sha, format, []));
    expect(summary!.memoryOnly).toEqual({ measured: 1, already: 0, failed: 0 });
    const now = readJson(path);
    // the cost figures, as text: the cell they sit in serialises the same, its cost and latency keys untouched
    const asMeasured = JSON.stringify(was.measurements.grid[0]);
    expect(JSON.stringify(now.measurements.grid[0])).toBe(asMeasured);
    expect(JSON.stringify(now.cost)).toBe(JSON.stringify(was.cost));
    expect(JSON.stringify(now.verdicts)).toBe(JSON.stringify(was.verdicts));
    expect(JSON.stringify(now.probe)).toBe(JSON.stringify(was.probe));
    expect(readFileSync(join(d.dir, probeFile(CLAP_RT))).equals(copy)).toBe(true);
    for (const q of [128, 256]) {
      expect(cell(now, q)).toMatchObject({ outcome: "probe.ok", memory: { ...FOOTPRINT, firstInstanceKb: 950, perInstanceKb: 300 } });
      expect(cell(now, q)!.cost).toBeUndefined();
      expect(cell(now, q)!.latency).toMatchObject({ unmeasuredReason: "not-attempted" });
    }
  });

  it("a footprint at a cell that has one replaces only the memory of it, the cost beside it the same bytes", async () => {
    const withCell = (r: QualificationRecord): QualificationRecord => {
      const cost = { median: 2073.5, percentile: { p: 95, value: 36416.6 }, blocks: 512, warmupBlocks: 64 };
      return { ...r, measurements: { ...r.measurements, grid: [{ ...r.measurements.grid[0]!, quantum: 128, cost, memory: { atRestKb: 1 } }, ...r.measurements.grid.slice(1)] } };
    };
    const d = device([CLAP_RT], { patch: withCell });
    const { id, sha, format } = idOf(CLAP_RT);
    const was = cell(d.record(CLAP_RT), 128)!;
    await memoryPassOf(d, fakeRunner(id, sha, format, []));
    const now = cell(d.record(CLAP_RT), 128)!;
    expect(JSON.stringify(now.cost)).toBe(JSON.stringify(was.cost));
    expect(JSON.stringify(now.latency)).toBe(JSON.stringify(was.latency));
    expect(now.memory).toMatchObject(FOOTPRINT);
  });

  it("runs under an ordinary run's limits, with the footprint alone asked for, each cell through the runner; LV2 in a world of its bundle", async () => {
    const clap = device([CLAP_RT]);
    const c = idOf(CLAP_RT);
    const seenClap: { args: readonly string[]; env: Readonly<Record<string, string | undefined>> }[] = [];
    await memoryPassOf(clap, fakeRunner(c.id, c.sha, c.format, seenClap));
    expect(seenClap.map((s) => s.args[s.args.indexOf("--quantum") + 1])).toEqual(["128", "256"]);
    for (const s of seenClap) {
      expect(s.args[s.args.indexOf("--wall-s") + 1]).toBe("17");
      expect(s.args[s.args.indexOf("--data-bytes") + 1]).toBe(String(2 * 2 ** 30));
      expect(s.args[s.args.indexOf("--rates") + 1]).toBe("48000");
      expect(s.args).toContain("--offer");
      expect(s.env).toMatchObject({ OMX_PROBE_MEMORY_ONLY: "1", OMX_PROBE_NOTES: String(MEMORY_PASS_PROBE_NOTES), OMX_RT_OOM_EXIT: "1", LD_PRELOAD: "/bin/true" });
    }
    const lv2 = device([LV2_CLEAN]);
    const l = idOf(LV2_CLEAN);
    const seenLv2: { args: readonly string[]; env: Readonly<Record<string, string | undefined>> }[] = [];
    await memoryPassOf(lv2, fakeRunner(l.id, l.sha, l.format, seenLv2));
    expect(seenLv2.length).toBe(2);
    expect(seenLv2[0]!.args.at(-1)).toBe(`lv2:${l.id}`);
    expect(seenLv2[0]!.env["LV2_PATH"]).toContain("plugin-qualify-sync-world-");
  });

  it("says a leak is not measured: the record names growth as unmeasured, and the summary says so", async () => {
    const d = device([CLAP_RT]);
    const { id, sha, format } = idOf(CLAP_RT);
    const summary = await memoryPassOf(d, fakeRunner(id, sha, format, []));
    expect(d.record(CLAP_RT).notMeasured).toContainEqual(MEMORY_PASS_NOT_MEASURED);
    expect(MEMORY_PASS_NOT_MEASURED).toEqual({ dimension: "memoryGrowth", code: HOSTING_CODE.stabilityUnsoaked });
    expect(summaryLine(summary!)).toContain("leaks not measured");
    expect(d.record(CLAP_RT).memoryRun).toEqual({
      tool: { runner: "plugin-hostd-probe 0.15.3", child: "clap-qualify" },
      measuredAt: "2026-10-31T01:00:00+00:00",
      runId: "memory-run-1",
      cells: [{ rate: 48000, quantum: 128, outcome: "probe.ok" }, { rate: 48000, quantum: 256, outcome: "probe.ok" }],
    });
  });

  it("a plugin already merged is not measured again, unless forced", async () => {
    const d = device([CLAP_RT]);
    const { id, sha, format } = idOf(CLAP_RT);
    const seen: { args: readonly string[]; env: Readonly<Record<string, string | undefined>> }[] = [];
    await memoryPassOf(d, fakeRunner(id, sha, format, seen));
    const after = readFileSync(join(d.dir, recordFile(CLAP_RT)));
    const again = await memoryPassOf(d, fakeRunner(id, sha, format, seen));
    expect(again!.memoryOnly).toEqual({ measured: 0, already: 1, failed: 0 });
    expect(seen.length).toBe(2);
    expect(readFileSync(join(d.dir, recordFile(CLAP_RT))).equals(after)).toBe(true);
    await memoryPassOf(d, fakeRunner(id, sha, format, seen), true);
    expect(seen.length).toBe(4);
  });

  it("a crash in the pass is a reason beside no figure, read as unknown, never as fitting; a pass with no document leaves the record", async () => {
    const d = device([CLAP_RT]);
    const { id, sha, format } = idOf(CLAP_RT);
    await memoryPassOf(d, fakeRunner(id, sha, format, [], "crash"));
    const r = d.record(CLAP_RT);
    expect(cell(r, 128)!.memory).toMatchObject({ unmeasuredReason: "probe-crashed" });
    expect(cell(r, 128)!.memory!.firstInstanceKb).toBeUndefined();
    expect(r.memoryRun!.cells[0]!.outcome).toBe("probe.crashed");
    await rejudge(d);
    expect(row(d.record(CLAP_RT), "openmixer-pi-8gb")).toMatchObject({ rating: "unknown", deciding: HOSTING_CODE.memoryUnmeasured });
    expect(row(d.record(CLAP_RT), "openmixer-pi-8gb").reasons.find((x) => x.dimension === "memory")!.params).toMatchObject({ unmeasuredReason: "probe-crashed" });

    const e = device([CLAP_NOTES]);
    const n = idOf(CLAP_NOTES);
    const before = readFileSync(join(e.dir, recordFile(CLAP_NOTES)));
    const summary = await memoryPassOf(e, fakeRunner(n.id, n.sha, n.format, [], "none"));
    expect(summary!.memoryOnly).toEqual({ measured: 0, already: 0, failed: 1 });
    expect(readFileSync(join(e.dir, recordFile(CLAP_NOTES))).equals(before)).toBe(true);
  });

  it("a footprint of other bytes than the record's is not merged", async () => {
    const d = device([CLAP_RT]);
    const { id, format } = idOf(CLAP_RT);
    const before = readFileSync(join(d.dir, recordFile(CLAP_RT)));
    const summary = await memoryPassOf(d, fakeRunner(id, "a".repeat(64), format, []));
    expect(summary!.memoryOnly!.failed).toBe(1);
    expect(readFileSync(join(d.dir, recordFile(CLAP_RT))).equals(before)).toBe(true);
  });
});

describe("--memory-only then --rejudge", () => {
  it("the Pi's verdict reads the merged footprint: within a provisional ceiling it is conditional, and says provisional", async () => {
    const d = device([CLAP_RT]);
    const { id, sha, format } = idOf(CLAP_RT);
    await memoryPassOf(d, fakeRunner(id, sha, format, []));
    await rejudge(d);
    const r = d.record(CLAP_RT);
    const memory = row(r, "openmixer-pi-4gb").reasons.find((x) => x.dimension === "memory")!;
    expect(memory).toMatchObject({ rating: "conditional", code: HOSTING_CODE.memoryWithinProvisionalCeiling, params: { provisional: "yes", perInstanceKb: 300, firstInstanceKb: 950 } });
    expect(r.rejudged!.figures.memory).toEqual({ tool: { runner: "plugin-hostd-probe 0.15.3", child: "clap-qualify" }, measuredAt: "2026-10-31T01:00:00+00:00" });
    expect(r.rejudged!.figures.measuredAt).toBe(stored(CLAP_RT).measuredAt);
    expect(row(r, "omx-clap-host")).toMatchObject({ rating: "conditional", deciding: HOSTING_CODE.rtSafetyViolations });
  });

  it("a footprint above the ceiling: unsuitable on the Pi, though the same record is conditional on omx-clap-host", async () => {
    const d = device([CLAP_RT]);
    const { id, sha, format } = idOf(CLAP_RT);
    const big = fakeRunner(id, sha, format, []);
    const hog: ProbeRun = (tool, args, env) => {
      const r = big(tool, args, env);
      const out = args[args.indexOf("--out") + 1]!;
      writeFileSync(out, readFileSync(out, "utf8").replaceAll('"secondInstanceKb":300', `"secondInstanceKb":${String(2 * 1024 * 1024)}`));
      return r;
    };
    await memoryPassOf(d, hog);
    await rejudge(d);
    const r = d.record(CLAP_RT);
    expect(row(r, "openmixer-pi-4gb")).toMatchObject({ rating: "unsuitable", deciding: HOSTING_CODE.memoryAboveCeiling });
    expect(row(r, "omx-clap-host").rating).toBe("conditional");
  });

  it("a memory pass does not launder a crash: the run's failed outcome still decides", async () => {
    const d = device([LV2_CRASHED]);
    const { id, sha, format } = idOf(LV2_CRASHED);
    await memoryPassOf(d, fakeRunner(id, sha, format, []));
    await rejudge(d);
    expect(row(d.record(LV2_CRASHED), "openmixer-pi-8gb")).toMatchObject({ rating: "unknown", measured: false, deciding: "probe.crashed" });
  });
});

describe("the flags", () => {
  it("--rejudge measures nothing, so it goes with no flag that would", () => {
    expect(parseSyncArgs(["--rejudge"])).toMatchObject({ ok: true, args: { rejudge: true, memoryOnly: false } });
    expect(parseSyncArgs(["--rejudge", "--force"]).ok).toBe(false);
    expect(parseSyncArgs(["--rejudge", "--memory-only"]).ok).toBe(false);
    expect(parseSyncArgs(["--rejudge", "--refresh-pins"]).ok).toBe(false);
    expect(parseSyncArgs(["--memory-only", "--force"])).toMatchObject({ ok: true, args: { memoryOnly: true, force: true } });
  });
});
