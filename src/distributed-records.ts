// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The distributed layer: qualification records another device of the same machine class wrote for a plugin set,
 * installed read-only under `<dir>/<host class>/<set>/` beside the set's `provenance.json`. plugin-qualify-sync reads
 * it before measuring a plugin, and takes a plugin from it instead of measuring it only when every file the record
 * names hashes, here, as it did where it was measured. The name of a plugin finds its record and never decides
 * anything: a record is never trusted by name alone.
 *
 * What applies is copied into the device's own `qualification_dir`, the record with the set's provenance added and
 * its probe output byte for byte, and the plugin's pin is the one that probe output holds. From then on the sync
 * treats the plugin as one it measured.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { clapPinUri, pinVerdictOf, type PinEntry } from "./pins-file.js";
import { integrityOfProbeOutput } from "./probe-judge.js";
import { readProbeOutput, sha256Hex } from "./probe-output.js";
import { QUALIFICATION_RECORD_SCHEMA, type QualificationRecord, type RecordVerdict } from "./qualification-record.js";
import type { FileDigest, SyncItem, SyncOutcome, SyncPlugin } from "./qualify-sync.js";
import type { SuitabilityRating } from "./rating.js";
import { writeFileWhole } from "./whole-file.js";

/** Where a system's packages install the distributed records. */
export const DISTRIBUTED_DIR_SYSTEM = "/usr/share/omx/qualification";

/** The file of a set that says where its records come from. */
export const DISTRIBUTED_PROVENANCE_FILE = "provenance.json";
export const DISTRIBUTED_PROVENANCE_SCHEMA = "plugin-qualify.distributed-provenance/1";

/** The first plugin-qualify that reads the layer: what a package of records depends on. */
export const DISTRIBUTED_LAYER_SINCE = "0.17.0";

/** Where the records of a set come from. The keys below are always there; the rest is what the builder was given. */
export interface DistributedProvenance {
  readonly schema: typeof DISTRIBUTED_PROVENANCE_SCHEMA;
  readonly set: string;
  readonly hostClass: string;
  /** The package that installed the set. */
  readonly package: { readonly name: string; readonly version: string };
  /** The day the package was built (YYYY-MM-DD). */
  readonly date: string;
  readonly [key: string]: unknown;
}

/** The device tree's model file, where a board names itself. */
export const BOARD_MODEL_FILE = "/proc/device-tree/model";

/** The board's own model, or `undefined` on a machine without a device tree. */
export function readBoardModel(): string | undefined {
  try {
    return readFileSync(BOARD_MODEL_FILE, "utf8");
  } catch {
    return undefined;
  }
}

/** The host class of a board the layer knows by its device-tree model: `rpi5` for a Raspberry Pi 5 or its compute module. */
export function hostClassOfBoard(model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  const m = /^Raspberry Pi (?:Compute Module )?(\d)(?:\s|$)/.exec(model.replace(/\0/g, "").trim());
  return m === null ? undefined : `rpi${m[1]!}`;
}

/** One distributed record, read: where it is, what it says, and the set it came with. */
export interface DistributedRecord {
  readonly path: string;
  readonly record: QualificationRecord;
  readonly set: string;
  readonly provenance: DistributedProvenance;
}

/** The layer as one run reads it: the records of the host class, by what finds them. */
export interface DistributedLayer {
  /** By the `.clap` path the record measured, made absolute. */
  readonly clap: ReadonlyMap<string, readonly DistributedRecord[]>;
  /** By the LV2 plugin's uri. */
  readonly lv2: ReadonlyMap<string, readonly DistributedRecord[]>;
  readonly sets: readonly string[];
  readonly records: number;
}

export const EMPTY_LAYER: DistributedLayer = { clap: new Map(), lv2: new Map(), sets: [], records: 0 };

const RECORD_SUFFIX = ".qualification.json";

const names = (dir: string): string[] => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};

/**
 * The records of one host class under each directory, in the order given. A set without a provenance that reads, or
 * whose provenance names another set or class, is not read; a record that does not read as a record of this schema is
 * named and left out.
 */
export function readDistributedLayer(dirs: readonly string[], hostClass: string, log: (line: string) => void = () => {}): DistributedLayer {
  const clap = new Map<string, DistributedRecord[]>();
  const lv2 = new Map<string, DistributedRecord[]>();
  const sets: string[] = [];
  let records = 0;
  const add = (map: Map<string, DistributedRecord[]>, key: string, r: DistributedRecord): void => {
    map.set(key, [...(map.get(key) ?? []), r]);
  };
  for (const base of dirs) {
    const classDir = join(base, hostClass);
    for (const set of names(classDir)) {
      const dir = join(classDir, set);
      let provenance: DistributedProvenance;
      try {
        provenance = JSON.parse(readFileSync(join(dir, DISTRIBUTED_PROVENANCE_FILE), "utf8")) as DistributedProvenance;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOTDIR") continue;
        log(`distributed: ${dir}: ${(e as NodeJS.ErrnoException).code === "ENOENT" ? `no ${DISTRIBUTED_PROVENANCE_FILE}` : `${DISTRIBUTED_PROVENANCE_FILE} does not read`}, not read`);
        continue;
      }
      if (provenance.schema !== DISTRIBUTED_PROVENANCE_SCHEMA || provenance.set !== set || provenance.hostClass !== hostClass) {
        log(`distributed: ${dir}: its ${DISTRIBUTED_PROVENANCE_FILE} is not of set ${set} and host class ${hostClass} (${DISTRIBUTED_PROVENANCE_SCHEMA}), not read`);
        continue;
      }
      sets.push(set);
      for (const name of names(dir)) {
        if (!name.endsWith(RECORD_SUFFIX)) continue;
        const path = join(dir, name);
        let record: QualificationRecord;
        try {
          record = JSON.parse(readFileSync(path, "utf8")) as QualificationRecord;
        } catch {
          log(`distributed: ${path}: does not read, left out`);
          continue;
        }
        if (record.schema !== QUALIFICATION_RECORD_SCHEMA || typeof record.binary?.path !== "string" || !Array.isArray(record.binary.files) || record.binary.files.length === 0) {
          log(`distributed: ${path}: not a ${QUALIFICATION_RECORD_SCHEMA} with its binary's files, left out`);
          continue;
        }
        const r: DistributedRecord = { path, record, set, provenance };
        records++;
        if (record.plugin.format === "clap") add(clap, resolve(record.binary.path), r);
        else if (record.plugin.format === "lv2") add(lv2, record.plugin.id, r);
      }
    }
  }
  return { clap, lv2, sets, records };
}

/** The uri a record's plugin has on this machine: the installed `.clap`'s path and the id, or the LV2 uri. */
export function distributedUri(item: SyncItem, r: DistributedRecord): string {
  return item.format === "clap" ? clapPinUri(join(item.root, item.files[0]!), `urn:clap:${r.record.plugin.id}`) : r.record.plugin.id;
}

/** What the sync's own judgment would make of the record's verdict for the host, as `outcomeOf` reads a run. */
function outcomeOfVerdict(v: RecordVerdict): SyncOutcome {
  if (!v.measured) return v.deciding === "probe.crashed" ? "crashed" : v.deciding === "probe.timeout" ? "hung" : "unmeasured";
  if (v.rating === "suitable" || v.rating === "conditional") return "qualified";
  return v.rating === "unsuitable" ? "refused" : "unmeasured";
}

/** What the layer makes of one item. */
export type DistributedMatch =
  /** No distributed record names the plugin: it is measured, and nothing is said. */
  | { readonly status: "none" }
  /** Every reason a record found was not taken, one line each; the plugin is measured. */
  | { readonly status: "ignored"; readonly lines: readonly string[] }
  | { readonly status: "applies"; readonly set: string; readonly records: readonly DistributedRecord[]; readonly files: readonly string[] };

/**
 * Whether the item is taken from the layer. The records that find it are tried one set at a time, in the order the
 * layer read them. Of a set, only the records whose every file is installed with the SHA-256 it recorded (computed
 * here by `digest`) count: a record of other bytes is another build of the plugin and is passed over. The set applies
 * when at least one record of these bytes holds a verdict for `host`, and none of those verdicts is one the source
 * could not measure; a set with no record of these bytes is a binary that differs.
 */
export function matchDistributed(
  layer: DistributedLayer,
  item: SyncItem,
  host: string,
  digest: (files: readonly string[]) => readonly FileDigest[] | undefined,
): DistributedMatch {
  const found = item.format === "clap" ? layer.clap.get(resolve(join(item.root, item.files[0]!))) : layer.lv2.get(item.uri ?? "");
  if (found === undefined || found.length === 0) return { status: "none" };
  const lines: string[] = [];
  const say = (line: string): void => {
    if (!lines.includes(line)) lines.push(line);
  };
  for (const set of [...new Set(found.map((r) => r.set))]) {
    // a set may hold records of earlier bytes of the plugin beside the ones of these: only the ones of these bytes count
    const records = found.filter((r) => {
      if (r.set !== set || r.record.plugin.format !== item.format) return false;
      const wanted = r.record.binary.files;
      const now = digest(wanted.map((f) => f.path));
      return now !== undefined && wanted.every((f) => now.find((d) => d.path === f.path)?.sha256 === f.sha256);
    });
    if (records.length === 0) {
      say(`distributed: ${distributedUri(item, found.find((r) => r.set === set)!)}: binary differs`);
      continue;
    }
    const judged = records.filter((r) => r.record.verdicts.some((v) => v.host === host));
    if (judged.length === 0) {
      say(`distributed: ${distributedUri(item, records[0]!)}: no verdict for ${host} in ${set}`);
      continue;
    }
    const unmeasured = judged.find((r) => outcomeOfVerdict(r.record.verdicts.find((v) => v.host === host)!) === "unmeasured");
    if (unmeasured !== undefined) {
      say(`distributed: ${distributedUri(item, unmeasured)}: unmeasured in ${set}, measured here`);
      continue;
    }
    return { status: "applies", set, records, files: [...new Set(records.flatMap((r) => r.record.binary.files.map((f) => f.path)))] };
  }
  return { status: "ignored", lines };
}

/**
 * The records of a match copied into `qualificationDir` and the plugins they make: the probe output first, byte for
 * byte and read back through this version's reader, its SHA-256 the one the record names; then the record with the
 * set's provenance added. A record whose probe output is missing, altered or unreadable throws, naming it, and the
 * caller measures the plugin instead. Records of the other tier (no verdict for `host`) are copied and make no plugin,
 * as the sweep writes them.
 */
export function applyDistributed(qualificationDir: string, item: SyncItem, match: Extract<DistributedMatch, { status: "applies" }>, host: string): SyncPlugin[] {
  const copies = match.records.map((r) => {
    const probeName = r.record.probe.file;
    const probePath = join(r.path, "..", probeName);
    let bytes: Buffer;
    try {
      bytes = readFileSync(probePath);
    } catch (e) {
      throw new Error(`${probeName}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`);
    }
    if (sha256Hex(bytes) !== r.record.probe.sha256) throw new Error(`${probeName}: not the probe output the record names (its SHA-256 differs)`);
    const read = readProbeOutput(bytes.toString("utf8"));
    if (!read.ok) throw new Error(`${probeName}: ${read.code}: ${read.problem}`);
    return { r, bytes, output: read.output };
  });
  const plugins: SyncPlugin[] = [];
  for (const { r, bytes, output } of copies) {
    writeFileWhole(join(qualificationDir, r.record.probe.file), bytes);
    const recordPath = join(qualificationDir, r.path.slice(r.path.lastIndexOf("/") + 1));
    writeFileWhole(recordPath, `${JSON.stringify({ ...r.record, provenance: r.provenance }, null, 2)}\n`);
    const v = r.record.verdicts.find((x) => x.host === host);
    if (v === undefined) continue;
    const word = v.measured ? pinVerdictOf(v.rating as SuitabilityRating) : undefined;
    const pin: PinEntry = { uri: distributedUri(item, r), integrity: integrityOfProbeOutput(output), ...(word === undefined ? {} : { verdict: word }) };
    const outcome = outcomeOfVerdict(v);
    plugins.push({ uri: pin.uri, outcome, ...(v.deciding === undefined ? {} : { code: v.deciding }), pin, record: recordPath });
  }
  return plugins;
}
