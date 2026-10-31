// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * A device holding records a Raspberry Pi 5 wrote under plugin-qualify 0.16.1 (`fixtures/records-0.16.1/`), for the tests of
 * what is done to them later. Kept out of the test files: a `.test.ts` imported for a helper runs its whole suite in each importer.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parsePinLine } from "./pins-file.js";
import { sha256Hex } from "./probe-output.js";
import type { QualificationRecord } from "./qualification-record.js";
import { SYNC_STATE_SCHEMA, parseSyncArgs, resolveSyncSettings, runSync, type SyncEntry, type SyncPlugin, type SyncSettings, type SyncState } from "./qualify-sync.js";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "records-0.16.1");
export const CLAP_RT = "in.lsp-plug.impulse_responses_mono@unversioned-d5235d2f5f53.custom";
export const CLAP_NOTES = "in.lsp-plug.trigger_midi_mono@unversioned-d5235d2f5f53.custom";
export const LV2_RT = "https___github.com_lucianodato_noise-repellent@unversioned-c3b5e21dd9a7.default";
export const LV2_CRASHED = "http___example.org_raffo@unversioned-2060c09ff626.default";
export const LV2_CLEAN = "http___lv2plug.in_plugins_eg-amp@unversioned-f046a60efd45.default";

const scratch = mkdtempSync(join(tmpdir(), "qualify-rejudge-"));
export const removeDevices = (): void => rmSync(scratch, { recursive: true, force: true });
let devices = 0;

export const recordFile = (stem: string): string => `${stem}.qualification.json`;
export const probeFile = (stem: string): string => `${stem}.probe.json`;
export const readJson = <T = QualificationRecord>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
export const stored = (stem: string): QualificationRecord => readJson(join(FIXTURES, recordFile(stem)));
export const adapterAdmitted = { host: "omx-clap-host", measured: true, admitted: true, params: {} };

export interface Device {
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
export function device(stems: readonly string[], options: { patch?: (r: QualificationRecord) => QualificationRecord; host?: string } = {}): Device {
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
export const rejudge = (d: Device) =>
  runSync(d.settings, { rejudge: true, env: { OMX_PROBE_RUNNER: "/nonexistent", OMX_CLAP_QUALIFY: "/nonexistent" }, pinFilesRun: () => ({ status: 1, stdout: "", stderr: "" }) });

export const row = (r: QualificationRecord, host: string) => r.verdicts.find((v) => v.host === host)!;
export const owesOf = (r: QualificationRecord) => r.rejudged?.owes?.map((o) => o.measurement) ?? [];

