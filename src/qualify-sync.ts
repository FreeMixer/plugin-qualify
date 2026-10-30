// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * `plugin-qualify-sync`: every plugin on the machine qualified once, and again only when its files change, so
 * plugin-hostd can run with `require_pins 1` and chain what it was given.
 *
 * A run finds every plugin binary on the search paths (each `.clap` under the CLAP directories, each plugin of each
 * `.lv2` bundle under the LV2 ones), and takes each one's file set as plugin-hostd collects it for a pin: the `.clap`
 * alone, or the bundle's `manifest.ttl` and every file the manifest names for the plugin. A plugin whose files hash
 * as recorded is skipped. Every other one gets the quick qualification: the probe runner's pin, RT-safety sweep, cost
 * and latency, then its descriptor; no soak, which its record says. Each plugin runs in processes of its own under a
 * wall clock, so a crash, a hang or a refusal is recorded and the run goes on to the next one.
 *
 * What a run leaves: the state file (what was qualified, from which bytes, and how it ended), the qualification
 * records and the descriptors in their directories, and the pin file plugin-hostd loads as `pin_file`, written whole.
 * When a daemon answers on the command port, the pins that changed are also sent to it with `pin_set`, and the ones
 * of a plugin that is gone with `pin_clear`. What a gone plugin left in the records and the descriptors is removed.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { clapQualifyTools } from "./clap-qualify.js";
import { DISTRIBUTED_DIR_SYSTEM, EMPTY_LAYER, applyDistributed, distributedUri, hostClassOfBoard, matchDistributed, readBoardModel, readDistributedLayer, type DistributedLayer } from "./distributed-records.js";
import { clapSearchPath, parseClapScan } from "./clap-loader.js";
import { HOSTING_CODE } from "./hosting-codes.js";
import { shippedHostProfile, type HostProfile } from "./host-profiles.js";
import { lv2BundlesOnPath, manifestPlugins } from "./lv2-loader.js";
import { judgmentPinEntries, pinsFile, type PinEntry } from "./pins-file.js";
import { hostdPinFiles, type PinFilesRun } from "./hostd-pin-files.js";
import type { Judgment } from "./probe-judge.js";
import { qualifyTargets } from "./probe-runner.js";
import { GRID_FULL, parseGridSpec, type GridSpec } from "./measurement-grid.js";
import { memoryBoundOf, parseMemoryLimit, type MemoryBound } from "./memory-bound.js";
import { writeQualification, type NotMeasured } from "./qualification-record.js";
import { DESCRIPTOR_DIR_STATE_SUBDIR, DESCRIPTOR_DIR_SYSTEM, QUALIFY_QUANTA, QUALIFY_RATES } from "./qualify-declarations.js";
import { toolsDir } from "./tool-paths.js";
import { writeFileWhole } from "./whole-file.js";

// --- the settings -----------------------------------------------------------------------------------------------------

/** The settings file a system service reads, `key value` per line. */
export const SYNC_CONF = "/etc/omx/qualify.conf";

/** The LV2 directories plugin-hostd searches when `LV2_PATH` is unset (its `lv2_path` default). */
export const HOSTD_LV2_PATH = ["/usr/lib64/lv2", "/usr/lib/lv2", "/usr/local/lib/lv2"];

/** Zynthian's own LV2 directories: the image's plugins and the ones its user installs. */
export const ZYNTHIAN_LV2_DIRS = ["/zynthian/zynthian-plugins/lv2", "/zynthian/zynthian-my-data/plugins/lv2"];

export interface SyncSetting {
  readonly key: string;
  readonly meaning: string;
  /** The default as `--help` and the README print it. */
  readonly default: string;
}

/** Every setting, declared once: the settings file, the flags (`--pin-file` for `pin_file`) and `--help` read this. */
export const SYNC_SETTINGS: readonly SyncSetting[] = [
  { key: "lv2_path", meaning: "the LV2 directories, colon-separated, in the order plugin-hostd searches them", default: "$LV2_PATH, else " + HOSTD_LV2_PATH.join(":") },
  { key: "lv2_extra", meaning: "more LV2 directories, searched after lv2_path", default: ZYNTHIAN_LV2_DIRS.join(":") },
  { key: "clap_path", meaning: "the CLAP directories, colon-separated", default: "$CLAP_PATH, then ~/.clap, then /usr/lib/clap" },
  { key: "clap_extra", meaning: "more CLAP directories, searched after clap_path", default: "" },
  { key: "pin_file", meaning: "the pin file plugin-hostd loads as pin_file", default: "/var/lib/omx/qualified.pins (system), else $XDG_STATE_HOME/omx/qualified.pins" },
  { key: "qualification_dir", meaning: "where the qualification records go", default: "/var/lib/omx/qualification (system), else $XDG_STATE_HOME/omx/qualification" },
  { key: "descriptor_dir", meaning: "where the scanned descriptors go", default: `${DESCRIPTOR_DIR_SYSTEM} (system), else $XDG_STATE_HOME/${DESCRIPTOR_DIR_STATE_SUBDIR}` },
  { key: "state_file", meaning: "what was qualified, from which bytes, and how it ended", default: "/var/lib/omx/qualify-sync.json (system), else $XDG_STATE_HOME/omx/qualify-sync.json" },
  { key: "budget_s", meaning: "the wall clock one run gets (one cell of an LV2 plugin, one quantum of a CLAP one), in seconds; past it the plugin is recorded as hung", default: "60" },
  { key: "host_profile", meaning: "the host the verdict is for (a shipped profile id)", default: "omx-clap-host" },
  { key: "grid", meaning: "the cells measured: full (every rate at every block size, 16 cells), hosts (the fast option: the host's and the console tiers' rate/quantum, then 512 at every rate; also --grid-hosts), or <rate>/<quantum>,...", default: "full" },
  { key: "cells_per_plugin_budget", meaning: "measure at most the first n cells of the grid a plugin; 0 is every cell", default: "0" },
  { key: "memory_limit", meaning: "the memory bound of every run: bytes, or with K, M, G; off for none; past it a cell is probe.oom", default: "half of the RAM" },
  { key: "hostd_port", meaning: "plugin-hostd's command port the new pins are sent to; 0 sends none", default: "5555" },
  { key: "hostd_feedback_port", meaning: "plugin-hostd's feedback port, connected before the command port; 0 is the command port's next", default: "0" },
  { key: "settle_s", meaning: "wait until the plugin directories have been quiet this long before a run", default: "0" },
  { key: "host_class", meaning: "the machine class whose distributed records are read (a directory name)", default: "the board's own from the device tree (rpi5 on a Raspberry Pi 5), else none" },
  { key: "distributed_dir", meaning: "the directories of distributed records, colon-separated, each holding <host class>/<set>/", default: `${DISTRIBUTED_DIR_SYSTEM} (system), else $XDG_DATA_HOME/omx/qualification and each $XDG_DATA_DIRS/omx/qualification` },
];

export interface SyncSettings {
  readonly lv2Dirs: readonly string[];
  readonly clapDirs: readonly string[];
  readonly pinFile: string;
  readonly qualificationDir: string;
  readonly descriptorDir: string;
  readonly stateFile: string;
  readonly budgetS: number;
  readonly hostProfile: HostProfile;
  /** The cells measured, and at most how many a plugin (0: every cell). */
  readonly grid: GridSpec;
  readonly cellsPerPluginBudget: number;
  /** The memory bound of every run; `undefined` is `off`. */
  readonly memory?: MemoryBound;
  readonly hostdPort: number;
  readonly hostdFeedbackPort: number;
  readonly settleS: number;
  /** The machine class the distributed records are read for; none, and the layer is not read. */
  readonly hostClass?: string;
  readonly distributedDirs: readonly string[];
  /** False under `--no-distributed`. */
  readonly distributed: boolean;
}

/** A settings file read: one `key value` per line, `#` starts a comment; a key alone is the empty value. An unknown key is refused by line. */
export function parseSyncConf(text: string, source = SYNC_CONF): { ok: true; values: Map<string, string> } | { ok: false; error: string } {
  const known = new Set(SYNC_SETTINGS.map((s) => s.key));
  const values = new Map<string, string>();
  const lines = text.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const m = /^(\S+)(?:\s+(.*))?$/.exec(line)!;
    const key = m[1]!;
    if (!known.has(key)) return { ok: false, error: `${source}:${String(n + 1)}: ${key} is not a setting` };
    values.set(key, (m[2] ?? "").trim());
  }
  return { ok: true, values };
}

export interface SyncArgs {
  readonly config?: string;
  readonly system: boolean;
  readonly force: boolean;
  readonly noDistributed: boolean;
  readonly noWait: boolean;
  readonly help: boolean;
  /** The settings given as flags, by key. */
  readonly values: ReadonlyMap<string, string>;
}

export const flagOf = (key: string): string => `--${key.replace(/_/g, "-")}`;

export function parseSyncArgs(argv: readonly string[]): { ok: true; args: SyncArgs } | { ok: false; error: string } {
  const byFlag = new Map(SYNC_SETTINGS.map((s) => [flagOf(s.key), s.key]));
  const values = new Map<string, string>();
  let config: string | undefined;
  let system = false;
  let force = false;
  let noDistributed = false;
  let noWait = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--system") system = true;
    else if (a === "--force") force = true;
    else if (a === "--no-distributed") noDistributed = true;
    else if (a === "--no-wait") noWait = true;
    else if (a === "--help") help = true;
    else if (a === "--grid-hosts") values.set("grid", "hosts");
    else if (a === "--config" || byFlag.has(a)) {
      const v = argv[++i];
      if (v === undefined) return { ok: false, error: `${a} needs a value` };
      if (a === "--config") config = v;
      else values.set(byFlag.get(a)!, v);
    } else return { ok: false, error: `unknown argument ${a}` };
  }
  return { ok: true, args: { ...(config === undefined ? {} : { config }), system, force, noDistributed, noWait, help, values } };
}

export function syncHelpText(): string {
  const rows = SYNC_SETTINGS.map((s) => `  ${`${flagOf(s.key)} <value>`.padEnd(36)}${s.meaning}${s.default === "" ? "" : ` (default: ${s.default})`}`);
  return [
    "plugin-qualify-sync: qualify every plugin on the search paths once, and again when its files change",
    "",
    `  ${"--config <file>".padEnd(36)}the settings file (default: ${SYNC_CONF}; a missing file is the defaults)`,
    "  --system                            a system service's directories, under /var/lib/omx",
    "  --force                             qualify every plugin again, recorded or not; no distributed record is read",
    "  --no-wait                           a run in progress is not waited for: exit 0, and the holder runs once more at its end",
    "  --no-distributed                    read no distributed record: every plugin not recorded is measured",
    "  --grid-hosts                        the fast grid, the same as --grid hosts (7 cells with the shipped hosts)",
    "  --help                              this text",
    ...rows,
    "",
    "every setting is also a line of the settings file, its key as the first word",
    "exit 0 the run went through (whatever the verdicts), 2 it could not run",
    "",
  ].join("\n");
}

const dirList = (text: string): string[] => text.split(":").filter((d) => d !== "");

/** The settings of a run: a flag over the settings file over the default. */
export function resolveSyncSettings(
  file: ReadonlyMap<string, string>,
  args: SyncArgs,
  env: Readonly<Record<string, string | undefined>>,
  home: string = homedir(),
  boardModel: () => string | undefined = readBoardModel,
): { ok: true; settings: SyncSettings } | { ok: false; error: string } {
  const get = (key: string): string | undefined => args.values.get(key) ?? file.get(key);
  const state = env["XDG_STATE_HOME"] !== undefined && env["XDG_STATE_HOME"] !== "" ? env["XDG_STATE_HOME"] : join(home, ".local", "state");
  const place = (key: string, system: string, user: string): string => {
    const v = get(key);
    return v !== undefined && v !== "" ? v : args.system ? system : join(state, user);
  };
  const lv2Named = get("lv2_path");
  const lv2Base = lv2Named !== undefined && lv2Named !== "" ? dirList(lv2Named) : dirList(env["LV2_PATH"] ?? "").length > 0 ? dirList(env["LV2_PATH"]!) : HOSTD_LV2_PATH;
  const clapNamed = get("clap_path");
  const clapBase = clapNamed !== undefined && clapNamed !== "" ? dirList(clapNamed) : clapSearchPath(env, home);
  const number = (key: string, min: number): number | undefined => {
    const v = Number(get(key) ?? SYNC_SETTINGS.find((s) => s.key === key)!.default);
    return Number.isFinite(v) && v >= min ? v : undefined;
  };
  const budgetS = number("budget_s", 1);
  const hostdPort = number("hostd_port", 0);
  const feedbackPort = number("hostd_feedback_port", 0);
  const settleS = number("settle_s", 0);
  if (budgetS === undefined) return { ok: false, error: "budget_s must be a number of seconds, 1 or more" };
  if (hostdPort === undefined || !Number.isInteger(hostdPort) || hostdPort > 65535) return { ok: false, error: "hostd_port must be a port number, or 0" };
  if (feedbackPort === undefined || !Number.isInteger(feedbackPort) || feedbackPort > 65535) return { ok: false, error: "hostd_feedback_port must be a port number, or 0" };
  if (settleS === undefined) return { ok: false, error: "settle_s must be a number of seconds" };
  const gridText = get("grid");
  const grid = gridText === undefined || gridText === "" ? { ok: true as const, spec: GRID_FULL } : parseGridSpec(gridText);
  if (!grid.ok) return { ok: false, error: `grid: ${grid.error}` };
  const cellsPerPluginBudget = number("cells_per_plugin_budget", 0);
  if (cellsPerPluginBudget === undefined || !Number.isInteger(cellsPerPluginBudget)) return { ok: false, error: "cells_per_plugin_budget must be a whole number, 0 or more" };
  const memoryText = get("memory_limit");
  const memoryLimit = memoryText === undefined || memoryText === "" ? undefined : parseMemoryLimit(memoryText);
  if (memoryLimit !== undefined && !memoryLimit.ok) return { ok: false, error: `memory_limit: ${memoryLimit.error}` };
  const memory = memoryBoundOf(memoryLimit?.bytes);
  const profileId = get("host_profile") || "omx-clap-host";
  const hostProfile = shippedHostProfile(profileId);
  if (hostProfile === undefined) return { ok: false, error: `host_profile ${profileId} is not a shipped host profile` };
  const once = (dirs: readonly string[]): string[] => [...new Set(dirs.map((d) => resolve(d)))];
  const dataHome = env["XDG_DATA_HOME"] !== undefined && env["XDG_DATA_HOME"] !== "" ? env["XDG_DATA_HOME"] : join(home, ".local", "share");
  const dataDirs = dirList(env["XDG_DATA_DIRS"] ?? "").length > 0 ? dirList(env["XDG_DATA_DIRS"]!) : ["/usr/local/share", "/usr/share"];
  const distributedNamed = get("distributed_dir");
  const distributedDirs =
    distributedNamed !== undefined && distributedNamed !== ""
      ? dirList(distributedNamed)
      : args.system
        ? [DISTRIBUTED_DIR_SYSTEM]
        : [dataHome, ...dataDirs].map((d) => join(d, "omx", "qualification"));
  const classNamed = get("host_class");
  const hostClass = classNamed !== undefined && classNamed !== "" ? classNamed : hostClassOfBoard(boardModel());
  if (hostClass !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(hostClass)) return { ok: false, error: `host_class ${hostClass} is not a directory name` };
  return {
    ok: true,
    settings: {
      lv2Dirs: once([...lv2Base, ...dirList(get("lv2_extra") ?? ZYNTHIAN_LV2_DIRS.join(":"))]),
      clapDirs: once([...clapBase, ...dirList(get("clap_extra") ?? "")]),
      pinFile: place("pin_file", "/var/lib/omx/qualified.pins", join("omx", "qualified.pins")),
      qualificationDir: place("qualification_dir", "/var/lib/omx/qualification", join("omx", "qualification")),
      descriptorDir: place("descriptor_dir", DESCRIPTOR_DIR_SYSTEM, DESCRIPTOR_DIR_STATE_SUBDIR),
      stateFile: place("state_file", "/var/lib/omx/qualify-sync.json", join("omx", "qualify-sync.json")),
      budgetS,
      hostProfile,
      grid: grid.spec,
      cellsPerPluginBudget,
      ...(memory === undefined ? {} : { memory }),
      hostdPort,
      hostdFeedbackPort: feedbackPort === 0 && hostdPort !== 0 ? hostdPort + 1 : feedbackPort,
      settleS,
      ...(hostClass === undefined ? {} : { hostClass }),
      distributedDirs: once(distributedDirs),
      distributed: !args.noDistributed,
    },
  };
}

// --- what is on the machine -------------------------------------------------------------------------------------------

/** One thing that is qualified as a unit: a `.clap` file (every plugin in it), or one plugin of an LV2 bundle. */
export interface SyncItem {
  /** `clap:<path of the .clap>`, or `lv2:<uri>`. */
  readonly key: string;
  readonly format: "clap" | "lv2";
  /** The directory the files are relative to: the `.clap`'s, or the bundle. */
  readonly root: string;
  /** The files plugin-hostd's pin holds, relative to `root`. */
  readonly files: readonly string[];
  /** The LV2 plugin's uri. */
  readonly uri?: string;
}

const CLAP_SUFFIX = ".clap";

/** Every `.clap` under a directory, its subdirectories included, in name order; a directory reached twice is walked once. */
function clapFiles(dir: string, seen: Set<string>, problems: string[]): string[] {
  let real: string;
  try {
    real = resolve(dir);
    const st = statSync(real);
    if (!st.isDirectory() || seen.has(`${st.dev}:${st.ino}`)) return [];
    seen.add(`${st.dev}:${st.ino}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") problems.push(`cannot read ${dir}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`);
    return [];
  }
  let names: string[];
  try {
    names = readdirSync(real).sort();
  } catch (e) {
    problems.push(`cannot read ${dir}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`);
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue; // a dangling link
    }
    if (st.isDirectory()) out.push(...clapFiles(path, seen, problems));
    else if (st.isFile() && name.endsWith(CLAP_SUFFIX)) out.push(path);
  }
  return out;
}

/**
 * Every item on the search paths. A `.clap` is one item; an LV2 plugin is one item, found in the first bundle on the
 * LV2 directories that declares it, as plugin-hostd finds it. A directory that cannot be read is a problem named, and
 * the others are still walked.
 */
export function discoverSyncItems(settings: Pick<SyncSettings, "lv2Dirs" | "clapDirs">): { items: SyncItem[]; problems: string[] } {
  const items: SyncItem[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  const clap = new Set<string>();
  for (const dir of settings.clapDirs) {
    for (const file of clapFiles(dir, seen, problems)) {
      const path = resolve(file);
      if (clap.has(path)) continue;
      clap.add(path);
      items.push({ key: `clap:${path}`, format: "clap", root: dirname(path), files: [basename(path)] });
    }
  }
  const lv2 = new Set<string>();
  for (const dir of settings.lv2Dirs) {
    let bundles: string[];
    try {
      bundles = lv2BundlesOnPath({ LV2_PATH: dir });
    } catch (e) {
      problems.push(`cannot read ${dir}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`);
      continue;
    }
    for (const bundle of bundles) {
      let ttl: string;
      try {
        ttl = readFileSync(join(bundle, "manifest.ttl"), "utf8");
      } catch (e) {
        problems.push(`cannot read ${join(bundle, "manifest.ttl")}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`);
        continue;
      }
      for (const p of manifestPlugins(ttl)) {
        if (lv2.has(p.uri)) continue;
        lv2.add(p.uri);
        items.push({ key: `lv2:${p.uri}`, format: "lv2", root: bundle, files: ["manifest.ttl", ...p.files.filter((f) => f !== "manifest.ttl")], uri: p.uri });
      }
    }
  }
  return { items, problems };
}

// --- the file set -----------------------------------------------------------------------------------------------------

/** One file of a set: its SHA-256, as plugin-hostd's `pin.h` digests it, and the stat it was taken at. */
export interface FileDigest {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
}

/** The SHA-256 of a file's bytes, read in pieces over one descriptor. */
export function fileSha256(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const piece = Buffer.alloc(1 << 20);
    for (let got = readSync(fd, piece); got > 0; got = readSync(fd, piece)) hash.update(piece.subarray(0, got));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * The digests of the files under `root`. A file whose size, modification time and inode are the ones `known` holds
 * keeps that digest without being read again, so a run over an unchanged machine reads no binary; any other is hashed.
 * `undefined` when a file is gone or cannot be read.
 */
export function digestFiles(root: string, files: readonly string[], known: readonly FileDigest[] = []): FileDigest[] | undefined {
  const out: FileDigest[] = [];
  for (const path of [...new Set(files)].sort()) {
    const full = join(root, path);
    try {
      const st = statSync(full);
      if (!st.isFile()) return undefined;
      const prior = known.find((k) => k.path === path);
      const same = prior !== undefined && prior.size === st.size && prior.mtimeMs === st.mtimeMs && prior.ino === st.ino;
      out.push({ path, sha256: same ? prior.sha256 : fileSha256(full), size: st.size, mtimeMs: st.mtimeMs, ino: st.ino });
    } catch {
      return undefined;
    }
  }
  return out;
}

// --- the state --------------------------------------------------------------------------------------------------------

export const SYNC_STATE_SCHEMA = "plugin-qualify.sync-state/1";

/** How the quick qualification of one plugin ended. */
export const SYNC_OUTCOMES = ["qualified", "refused", "crashed", "hung", "unmeasured"] as const;
export type SyncOutcome = (typeof SYNC_OUTCOMES)[number];

/** The codes of a plugin the sync could not measure, beside the probe runner's own. */
export const SYNC_CODE = {
  /** The scanner died loading the `.clap`: no plugin of it could be listed. */
  scanCrashed: "qualify.sync.scan-crashed",
  /** The scanner did not finish listing the `.clap` in its time. */
  scanHung: "qualify.sync.scan-hung",
  /** The scanner listed the plugin but could not create or init it. */
  scanRefused: "qualify.sync.scan-refused",
  /** The probe runner wrote no document to judge. */
  notMeasured: "qualify.sync.not-measured",
} as const;

/** What the quick qualification never measures, stated in every record it writes. */
export const QUICK_NOT_MEASURED: readonly NotMeasured[] = [{ dimension: "stability", code: HOSTING_CODE.stabilityUnsoaked }];

export interface SyncPlugin {
  /** plugin-hostd's uri of the plugin (`clap:<path>#<id>` or the LV2 uri), or `clap:<path>` when no plugin could be listed. */
  readonly uri: string;
  readonly outcome: SyncOutcome;
  /** The code that decided a plugin that is not qualified. */
  readonly code?: string;
  readonly detail?: string;
  /** Why its descriptor was not written, when the descriptor writer failed or timed out on it. */
  readonly descriptorProblem?: string;
  /** Its pin, when the run took a whole one. */
  readonly pin?: PinEntry;
  /** The record written for it. */
  readonly record?: string;
}

export interface SyncEntry {
  readonly format: "clap" | "lv2";
  readonly root: string;
  /** Every file the item's pin and its manifest hold, as they were when it was qualified. */
  readonly files: readonly FileDigest[];
  readonly plugins: readonly SyncPlugin[];
  readonly qualifiedAt: string;
  readonly seconds: number;
  /** The distributed set the plugins were taken from, when they were not measured here. */
  readonly distributed?: string;
}

export interface SyncState {
  readonly schema: typeof SYNC_STATE_SCHEMA;
  readonly entries: Readonly<Record<string, SyncEntry>>;
}

const EMPTY_STATE: SyncState = { schema: SYNC_STATE_SCHEMA, entries: {} };

/** The state file, or an empty state when there is none. One that does not read is moved aside and the run starts over. */
export function readSyncState(path: string, log: (line: string) => void = () => {}): SyncState {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_STATE;
    throw e;
  }
  try {
    const state = JSON.parse(text) as SyncState;
    if (state.schema === SYNC_STATE_SCHEMA && typeof state.entries === "object" && state.entries !== null) return state;
  } catch {
    // read as corrupt below
  }
  renameSync(path, `${path}.unreadable`);
  log(`${path} does not read as a sync state: moved to ${path}.unreadable, and every plugin is qualified again`);
  return EMPTY_STATE;
}

/** Whether an item is recorded from the bytes it has now: every file of its set, and every file of its recorded pin, unchanged. */
export function recordedAsIs(item: SyncItem, entry: SyncEntry | undefined): { same: boolean; files?: FileDigest[] } {
  if (entry === undefined || entry.root !== item.root) return { same: false };
  const names = [...new Set([...item.files, ...entry.files.map((f) => f.path)])];
  const now = digestFiles(item.root, names, entry.files);
  if (now === undefined) return { same: false };
  const same = now.length === entry.files.length && now.every((f) => entry.files.some((e) => e.path === f.path && e.sha256 === f.sha256));
  return { same, files: now };
}

// --- one item ---------------------------------------------------------------------------------------------------------

export interface SyncContext {
  readonly settings: SyncSettings;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: (line: string) => void;
  /** The run of `plugin-hostd --pin-files`, a stand-in in tests. */
  readonly pinFilesRun?: PinFilesRun;
}

/**
 * The pin of a judged run with the files plugin-hostd collects for its plugin (plugin-qualify#228): the probe's list is
 * the probe's view, and an add checks the daemon's, so a pin holds the daemon's. No pin when plugin-hostd cannot name
 * them; the plugin is then pinned on its first add (pin_mode first-use), and the log says why.
 */
function withHostdFiles(ctx: SyncContext, pin: PinEntry | undefined): PinEntry | undefined {
  if (pin === undefined || pin.integrity.files === undefined) return pin;
  const r = hostdPinFiles(pin.uri, ctx.settings.lv2Dirs, ctx.env, ...(ctx.pinFilesRun === undefined ? [] : [ctx.pinFilesRun]));
  if (!r.ok) {
    ctx.log(`${pin.uri}: not pinned: ${r.detail}`);
    return undefined;
  }
  return { ...pin, integrity: { ...pin.integrity, files: r.files } };
}

/** A judged run's outcome for the host: qualified, refused, or why it was not measured. */
function outcomeOf(judgment: Judgment, host: string): { outcome: SyncOutcome; code?: string } {
  const v = judgment.hosts.find((h) => h.verdict.host === host)?.verdict;
  if (v === undefined) return { outcome: "unmeasured", code: SYNC_CODE.notMeasured };
  const code = v.deciding;
  if (!v.measured) return { outcome: code === "probe.crashed" ? "crashed" : code === "probe.timeout" ? "hung" : "unmeasured", ...(code === undefined ? {} : { code }) };
  if (v.rating === "suitable" || v.rating === "conditional") return { outcome: "qualified", ...(code === undefined ? {} : { code }) };
  return { outcome: v.rating === "unsuitable" ? "refused" : "unmeasured", ...(code === undefined ? {} : { code }) };
}

const safe = (text: string): string => text.replace(/[^A-Za-z0-9._-]/g, "_");

/** The record of a plugin no probe output exists for: what it is, the bytes it was, and why nothing was measured. */
function writeUnmeasuredRecord(ctx: SyncContext, item: SyncItem, files: readonly FileDigest[], plugin: Omit<SyncPlugin, "record">): string {
  const main = files.find((f) => f.path === item.files[item.format === "clap" ? 0 : 1]) ?? files[0];
  const path = join(ctx.settings.qualificationDir, `${safe(basename(plugin.uri))}-${(main?.sha256 ?? "").slice(0, 12)}.unmeasured.json`);
  const record = {
    schema: "plugin-qualify.unmeasured-record/1",
    plugin: { format: item.format, uri: plugin.uri },
    binary: { root: item.root, files: files.map((f) => ({ path: f.path, sha256: f.sha256 })) },
    outcome: plugin.outcome,
    code: plugin.code,
    ...(plugin.detail === undefined ? {} : { detail: plugin.detail }),
    notMeasured: [{ dimension: "all", code: plugin.code ?? SYNC_CODE.notMeasured }, ...QUICK_NOT_MEASURED],
    measuredAt: new Date().toISOString(),
  };
  writeFileWhole(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

/** Each judged run of a pass as the plugins it qualified: the record written, the pin taken, the outcome. */
function judgedPlugins(ctx: SyncContext, runs: readonly { bytes: Buffer; judgment: Judgment }[]): SyncPlugin[] {
  const host = ctx.settings.hostProfile.id;
  const entries = runs.map(({ bytes, judgment }) => {
    const { recordPath } = writeQualification(ctx.settings.qualificationDir, bytes, judgment, QUICK_NOT_MEASURED);
    const pin = withHostdFiles(ctx, judgmentPinEntries(judgment, host)[0]);
    const { outcome, code } = outcomeOf(judgment, host);
    const plugin: SyncPlugin = { uri: pin?.uri ?? judgment.output.plugin.id, outcome, ...(code === undefined ? {} : { code }), ...(pin === undefined ? {} : { pin }), record: recordPath };
    return { plugin, judgedHere: judgment.hosts.some((h) => h.verdict.host === host) };
  });
  // The pass also judges the console's other tier, which writes its own record; that run is no second plugin of this
  // sweep, so only the runs that judged this host count, and a plugin none of them judged is counted once.
  const here = entries.filter((e) => e.judgedHere).map((e) => e.plugin);
  return here.length > 0 || entries.length === 0 ? here : [entries[0]!.plugin];
}

function runPass(ctx: SyncContext, target: Parameters<typeof qualifyTargets>[0][number], env: Readonly<Record<string, string | undefined>>) {
  const s = ctx.settings;
  return qualifyTargets([target], {
    rates: QUALIFY_RATES,
    quanta: QUALIFY_QUANTA,
    grid: s.grid,
    cellsPerPluginBudget: s.cellsPerPluginBudget,
    ...(s.memory === undefined ? {} : { memory: s.memory }),
    profiles: [s.hostProfile],
    wallS: s.budgetS,
    env,
    // mod-host and jalv are admitted on the device's LV2 directories, not on the one-bundle world the probe measures in
    admissionLv2Path: s.lv2Dirs,
  });
}

/**
 * The descriptors of a scanned `.clap`, through the one descriptor writer, one plugin to a run so that each has the
 * budget to itself and a plugin that hangs the writer costs only its own descriptor. What failed is returned by plugin
 * id, so the outcome of that plugin records it; the run goes on.
 */
function writeClapDescriptors(ctx: SyncContext, scan: string): Map<string, string> {
  const failed = new Map<string, string>();
  let doc: { files?: { plugins?: { id?: string }[] }[] };
  try {
    doc = JSON.parse(scan);
  } catch (e) {
    ctx.log(`descriptors of a .clap not written (the scan is not JSON): ${(e as Error).message}`);
    return failed;
  }
  for (const file of doc.files ?? []) {
    for (const p of file.plugins ?? []) {
      const id = p.id ?? "";
      const r = spawnSync("python3", [join(toolsDir(), "descriptors.py"), "clap", "--descriptor-dir", ctx.settings.descriptorDir], {
        input: JSON.stringify({ ...doc, files: [{ ...file, plugins: [p] }] }),
        encoding: "utf8",
        timeout: ctx.settings.budgetS * 1000,
        killSignal: "SIGKILL",
        env: { ...ctx.env },
      });
      if (r.status === 0) continue;
      const problem = `descriptor not written (${r.error?.message ?? `exit ${String(r.status)}`}): ${(r.stderr ?? "").trim()}`;
      failed.set(id, problem);
      ctx.log(`${id}: ${problem}`);
    }
  }
  return failed;
}

function qualifyClap(ctx: SyncContext, item: SyncItem): SyncPlugin[] {
  const file = join(item.root, item.files[0]!);
  const fileUri = `clap:${file}`;
  let tool: string;
  try {
    tool = clapQualifyTools(ctx.env, existsSync).tool;
  } catch (e) {
    return [{ uri: fileUri, outcome: "unmeasured", code: SYNC_CODE.notMeasured, detail: (e as Error).message }];
  }
  // the scanner lists the plugins of the file in a child of its own, and says how that child ended
  const r = spawnSync(tool, ["--json", file], { encoding: "utf8", timeout: Math.max(ctx.settings.budgetS, 35) * 1000, killSignal: "SIGKILL", maxBuffer: 64 << 20 });
  let scanned;
  try {
    if (r.error !== undefined) throw r.error;
    scanned = parseClapScan(r.stdout).files.find((f) => resolve(f.path) === file);
    if (scanned === undefined) throw new Error("the scan holds no entry for the file");
  } catch (e) {
    const hung = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    return [{ uri: fileUri, outcome: hung ? "hung" : "unmeasured", code: hung ? SYNC_CODE.scanHung : SYNC_CODE.notMeasured, detail: (e as Error).message }];
  }
  if ("error" in scanned) {
    const hung = /timed out/.test(scanned.error);
    return [{ uri: fileUri, outcome: hung ? "hung" : "crashed", code: hung ? SYNC_CODE.scanHung : SYNC_CODE.scanCrashed, detail: scanned.error }];
  }
  const descriptorFailed = writeClapDescriptors(ctx, r.stdout);
  const out: SyncPlugin[] = [];
  for (const p of scanned.plugins) {
    const uri = `${fileUri}#${p.id}`;
    if ("error" in p) {
      out.push({ uri, outcome: "unmeasured", code: SYNC_CODE.scanRefused, detail: p.error });
      continue;
    }
    const pass = runPass(ctx, { format: "clap", uri: `urn:clap:${p.id}`, bundle: item.root, binary: item.files[0]!, binaryPath: file }, ctx.env);
    for (const f of pass.failures) out.push({ uri, outcome: "unmeasured", code: SYNC_CODE.notMeasured, detail: f.problem });
    const problem = descriptorFailed.get(p.id);
    out.push(...judgedPlugins(ctx, pass.runs).map((j) => (problem === undefined ? j : { ...j, descriptorProblem: problem })));
  }
  return out;
}

/** An LV2 plugin, measured in a world of its own bundle only, as plugin-hostd runs a pinned LV2 plugin. */
function qualifyLv2(ctx: SyncContext, item: SyncItem): SyncPlugin[] {
  const world = mkdtempSync(join(tmpdir(), "plugin-qualify-sync-world-"));
  try {
    symlinkSync(item.root, join(world, basename(item.root)));
    const pass = runPass(ctx, { format: "lv2", uri: item.uri!, bundle: item.root }, { ...ctx.env, LV2_PATH: world });
    return [...pass.failures.map((f): SyncPlugin => ({ uri: item.uri!, outcome: "unmeasured", code: SYNC_CODE.notMeasured, detail: f.problem })), ...judgedPlugins(ctx, pass.runs)];
  } finally {
    rmSync(world, { recursive: true, force: true });
  }
}

/** One item qualified, whatever happens to it: an error of the sync's own while measuring it is its outcome, not the run's end. */
export function qualifyItem(ctx: SyncContext, item: SyncItem, files: readonly FileDigest[]): SyncEntry {
  const started = Date.now();
  let plugins: SyncPlugin[];
  try {
    plugins = item.format === "clap" ? qualifyClap(ctx, item) : qualifyLv2(ctx, item);
  } catch (e) {
    plugins = [{ uri: item.uri ?? item.key, outcome: "unmeasured", code: SYNC_CODE.notMeasured, detail: (e as Error).message }];
  }
  if (plugins.length === 0) plugins = [{ uri: item.uri ?? item.key, outcome: "unmeasured", code: SYNC_CODE.notMeasured, detail: "no plugin was listed" }];
  plugins = plugins.map((p) => (p.record !== undefined ? p : { ...p, record: writeUnmeasuredRecord(ctx, item, files, p) }));
  // the pin's own files join the set, so a file the manifest reader missed still makes a change seen
  const pinned = plugins.flatMap((p) => p.pin?.integrity.files?.map((f) => f.path) ?? []);
  const all = digestFiles(item.root, [...item.files, ...pinned], files) ?? [...files];
  return { format: item.format, root: item.root, files: all, plugins, qualifiedAt: new Date(started).toISOString(), seconds: (Date.now() - started) / 1000 };
}

// --- the distributed records ----------------------------------------------------------------------------------------

/** The layer a run reads: none under `--force` or `--no-distributed`, or without a host class. */
function distributedLayerOf(settings: SyncSettings, force: boolean, log: (line: string) => void): DistributedLayer {
  if (force || !settings.distributed) return EMPTY_LAYER;
  if (settings.hostClass === undefined) {
    log("distributed: no host class (host_class unset, and the board names none); no distributed record is read");
    return EMPTY_LAYER;
  }
  const layer = readDistributedLayer(settings.distributedDirs, settings.hostClass, log);
  if (layer.records > 0) log(`distributed: ${String(layer.records)} records of ${layer.sets.join(", ")} for ${settings.hostClass}`);
  return layer;
}

/**
 * The item's entry taken from the distributed records, or `undefined` when it is to be measured: no record finds it,
 * or the ones that do were not taken, each reason said. Its descriptors are written as a measured item's are: a
 * `.clap` is scanned for them (the scan lists the plugins and measures nothing), an LV2 plugin joins the run's
 * descriptor pass.
 */
function takeDistributed(ctx: SyncContext, layer: DistributedLayer, item: SyncItem, files: readonly FileDigest[]): SyncEntry | undefined {
  if (layer.records === 0) return undefined;
  const started = Date.now();
  const host = ctx.settings.hostProfile.id;
  const match = matchDistributed(layer, item, host, (paths) => digestFiles(item.root, paths, files));
  if (match.status === "none") return undefined;
  if (match.status === "ignored") {
    for (const line of match.lines) ctx.log(line);
    return undefined;
  }
  let plugins: SyncPlugin[];
  try {
    plugins = applyDistributed(ctx.settings.qualificationDir, item, match, host);
  } catch (e) {
    ctx.log(`distributed: ${distributedUri(item, match.records[0]!)}: ${(e as Error).message}; measured here`);
    return undefined;
  }
  if (item.format === "clap") scanClapDescriptors(ctx, item);
  const all = digestFiles(item.root, [...item.files, ...match.files], files) ?? [...files];
  return { format: item.format, root: item.root, files: all, plugins, qualifiedAt: new Date(started).toISOString(), seconds: (Date.now() - started) / 1000, distributed: match.set };
}

/** The descriptors of a `.clap` taken from the layer: the scanner lists its plugins, the descriptor writer writes them. */
function scanClapDescriptors(ctx: SyncContext, item: SyncItem): void {
  const file = join(item.root, item.files[0]!);
  let tool: string;
  try {
    tool = clapQualifyTools(ctx.env, existsSync).tool;
  } catch (e) {
    ctx.log(`${file}: descriptors not written: ${(e as Error).message}`);
    return;
  }
  const r = spawnSync(tool, ["--json", file], { encoding: "utf8", timeout: Math.max(ctx.settings.budgetS, 35) * 1000, killSignal: "SIGKILL", maxBuffer: 64 << 20 });
  if (r.error !== undefined || r.status !== 0) {
    ctx.log(`${file}: descriptors not written: the scan ended ${r.error?.message ?? `with exit ${String(r.status)}`}`);
    return;
  }
  writeClapDescriptors(ctx, r.stdout);
}

// --- the outputs ------------------------------------------------------------------------------------------------------

/** The pin file's text: every whole pin of the state, the worse verdict kept for a uri pinned twice. */
export function syncPinsText(state: SyncState): string {
  const entries = Object.values(state.entries).flatMap((e) => e.plugins.flatMap((p) => (p.pin === undefined ? [] : [p.pin])));
  return pinsFile(entries, "plugin-qualify-sync").text;
}

/** The pin lines, by uri. */
function pinLinesOf(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) if (line !== "" && !line.startsWith("#")) out.set(line.split(" ")[1]!, line);
  return out;
}

/** The pin lines of `after` that `before` does not hold as they are. */
export function changedPinLines(before: string, after: string): string[] {
  const was = pinLinesOf(before);
  return [...pinLinesOf(after).entries()].filter(([uri, line]) => was.get(uri) !== line).map(([, line]) => line);
}

/** The uris `before` pins that `after` no longer does: the plugins that went away. */
export function removedPinUris(before: string, after: string): string[] {
  const now = pinLinesOf(after);
  return [...pinLinesOf(before).keys()].filter((uri) => !now.has(uri));
}

/** `<id>@<version>-<binary sha first 12>`, the stem a qualification record, its probe copy and its descriptor share. */
export function recordStem(recordPath: string): string | undefined {
  return /^(.*-[0-9a-f]{12})\.(?:[^.]+\.(?:qualification|probe)|unmeasured)\.json$/.exec(basename(recordPath))?.[1];
}

/**
 * A stem's id and binary hash, its version segment dropped: what a record and its descriptor share even when their
 * version segments differ (a CLAP record is keyed `@unversioned` while its descriptor carries the plugin's declared
 * version). Undefined for a name that is not of the `<id>@<version>-<hash>` shape.
 */
function idAndHash(stem: string): string | undefined {
  const m = /^(.+)@.+-([0-9a-f]{12})$/.exec(stem);
  return m === null ? undefined : `${m[1]}\0${m[2]}`;
}

/**
 * What a plugin the sync no longer finds, or finds as other bytes, leaves behind: its qualification record, the probe
 * output copied beside it and its descriptor. A stem the state before held and the state after does not hold is
 * stale; every record file of that stem is removed, and so is a descriptor of its id and binary hash whichever
 * version suffix it carries — unless that id and hash is still kept under another stem (two copies of one binary, or
 * a record and a descriptor the sync wrote at different version suffixes for the same plugin). A record of an id the
 * state after holds, made from other bytes than it holds, goes too, though no state ever named it (#198). A record another
 * plugin of the state still names (two copies of one binary) is kept, as is a descriptor the sync did not write.
 * Returns the files removed.
 */
export function pruneStale(settings: Pick<SyncSettings, "qualificationDir" | "descriptorDir">, before: SyncState, after: SyncState): string[] {
  const stems = (state: SyncState): Set<string> =>
    new Set(Object.values(state.entries).flatMap((e) => e.plugins.flatMap((p) => (p.record === undefined ? [] : [recordStem(p.record) ?? ""]))).filter((x) => x !== ""));
  const kept = stems(after);
  const stale = [...stems(before)].filter((stem) => !kept.has(stem));
  const keptIdHash = new Set([...kept].map(idAndHash).filter((x): x is string => x !== undefined));
  const staleIdHash = new Set(stale.map(idAndHash).filter((x): x is string => x !== undefined));
  const removed: string[] = [];
  const drop = (dir: string, file: string): void => {
    try {
      unlinkSync(join(dir, file));
      removed.push(join(dir, file));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  };
  let records: string[] = [];
  try {
    records = readdirSync(settings.qualificationDir);
  } catch {
    // no directory, no record
  }
  for (const stem of stale) for (const f of records) if (f.startsWith(`${stem}.`) && recordStem(f) === stem) drop(settings.qualificationDir, f);
  // a record of an installed plugin's id made from other bytes, whether or not any state ever named it (the other
  // tier's record, a lost state entry): the id is kept, the binary hash is not
  const keptIds = new Set([...keptIdHash].map((k) => k.split("\0")[0]!));
  for (const f of records) {
    const s = recordStem(f);
    const key = s === undefined ? undefined : idAndHash(s);
    if (key !== undefined && keptIds.has(key.split("\0")[0]!) && !keptIdHash.has(key)) drop(settings.qualificationDir, f);
  }
  let descriptors: string[] = [];
  try {
    descriptors = readdirSync(settings.descriptorDir);
  } catch {
    // no directory, no descriptor
  }
  for (const f of descriptors) {
    if (!f.endsWith(".json")) continue;
    const key = idAndHash(f.slice(0, -".json".length));
    if (key !== undefined && staleIdHash.has(key) && !keptIdHash.has(key)) drop(settings.descriptorDir, f);
  }
  return removed;
}

/** What became of the pins sent to a daemon: its replies, or why none came. */
export type SentPins =
  | { readonly replies: readonly string[] }
  /** `off`: hostd_port is 0. `absent`: nothing listens on the port. `held`: the port took the connection and no reply
   * came: plugin-hostd serves one controller at a time, and one is connected. */
  | { readonly unsent: "off" | "absent" | "held" };

/**
 * The lines sent to plugin-hostd, one reply awaited for each, connected as a controller connects: the feedback port
 * first, then the command port, since the daemon answers commands only while its feedback port has a controller. Pins
 * that could not be sent apply at the daemon's next start, from the pin file.
 */
export async function sendPins(port: number, feedbackPort: number, lines: readonly string[], timeoutMs = 5000): Promise<SentPins> {
  if (lines.length === 0) return { replies: [] };
  if (port === 0) return { unsent: "off" };
  return new Promise((done) => {
    const feedback = createConnection({ host: "127.0.0.1", port: feedbackPort });
    const socket = createConnection({ host: "127.0.0.1", port });
    const replies: string[] = [];
    let buffer = "";
    const timer = setTimeout(() => finish({ unsent: "held" }), timeoutMs);
    const finish = (result: SentPins): void => {
      clearTimeout(timer);
      socket.destroy();
      feedback.destroy();
      done(result);
    };
    // the daemon's events on the feedback port are not this run's to read: they are drained and dropped
    feedback.on("data", () => {});
    feedback.once("error", () => finish({ unsent: "absent" }));
    socket.setEncoding("utf8");
    socket.once("error", () => finish({ unsent: "absent" }));
    socket.once("connect", () => socket.write(`${lines[0]}\0`));
    socket.on("data", (d: string) => {
      buffer += d;
      for (let nul = buffer.indexOf("\0"); nul >= 0; nul = buffer.indexOf("\0")) {
        replies.push(buffer.slice(0, nul));
        buffer = buffer.slice(nul + 1);
        if (replies.length === lines.length) return finish({ replies });
        socket.write(`${lines[replies.length]}\0`);
      }
    });
  });
}

// --- waiting for quiet ------------------------------------------------------------------------------------------------

/** What the plugin directories look like from outside: each entry's name, size and modification time, two levels down. */
export function directoriesSignature(dirs: readonly string[]): string {
  const parts: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      try {
        const st = lstatSync(path);
        parts.push(`${path}\t${String(st.size)}\t${String(st.mtimeMs)}`);
        if (depth > 0 && st.isDirectory()) walk(path, depth - 1);
      } catch {
        // gone between the listing and the stat: the next look sees it
      }
    }
  };
  for (const dir of dirs) walk(dir, 1);
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Returns once the directories have not changed for `quietS` seconds: a package install writes many files, and one run is enough. */
export async function waitQuiet(dirs: readonly string[], quietS: number, log: (line: string) => void): Promise<void> {
  if (quietS <= 0) return;
  const pollMs = Math.min(5000, quietS * 1000);
  let seen = directoriesSignature(dirs);
  let since = Date.now();
  while (Date.now() - since < quietS * 1000) {
    await sleep(pollMs);
    const now = directoriesSignature(dirs);
    if (now !== seen) {
      log(`the plugin directories changed; waiting for ${String(quietS)} s of quiet`);
      seen = now;
      since = Date.now();
    }
  }
}

// --- the run ----------------------------------------------------------------------------------------------------------

export interface SyncSummary {
  readonly qualified: number;
  readonly skipped: number;
  readonly refused: number;
  readonly crashed: number;
  readonly hung: number;
  readonly unmeasured: number;
  /** The plugins taken from the distributed records, not measured. */
  readonly distributed: number;
  readonly seconds: number;
  /** The pins a running daemon took, when one answered. */
  readonly sent?: number;
}

/**
 * Why a reader that is not the sync's user (the console, #221) cannot read the descriptors: the directory or one of its
 * parent without search permission for others, the directory or a descriptor without read permission for others. One
 * line each; none when the directory does not exist yet or everything is open.
 */
export function descriptorAccessProblems(dir: string): string[] {
  const problems: string[] = [];
  const mode = (path: string): number | undefined => {
    try {
      return statSync(path).mode & 0o777;
    } catch {
      return undefined;
    }
  };
  const octal = (m: number): string => `0${m.toString(8)}`;
  const top = mode(dir);
  if (top === undefined) return problems;
  // the parent too (StateDirectory's /var/lib/omx); not further up, where a private home is a user's own choice
  const parent = dirname(resolve(dir));
  const parentMode = mode(parent);
  if (parentMode !== undefined && (parentMode & 0o001) === 0) problems.push(`${parent} is mode ${octal(parentMode)}: other users, the console among them, cannot enter it to read the descriptors`);
  if ((top & 0o004) === 0) problems.push(`${dir} is mode ${octal(top)}: other users, the console among them, cannot list the descriptors`);
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return problems;
  }
  const closed = files.filter((f) => ((mode(join(dir, f)) ?? 0o004) & 0o004) === 0);
  if (closed.length > 0) problems.push(`${String(closed.length)} descriptor(s) in ${dir} cannot be read by other users, the console among them (first: ${closed[0]!})`);
  return problems;
}

export function summaryLine(s: SyncSummary): string {
  return `qualified ${String(s.qualified)}, skipped ${String(s.skipped)}, refused ${String(s.refused)}, crashed ${String(s.crashed)}, hung ${String(s.hung)}, unmeasured ${String(s.unmeasured)}, distributed ${String(s.distributed)}, ${s.seconds.toFixed(1)} s`;
}

/** The exit status `flock -n` returns when the lock is held (-E), told apart from a failure of flock itself. */
const LOCK_HELD = 99;

export interface SyncLock {
  release(): Promise<void>;
}

/**
 * The lock of one state file: flock(1) on `<state file>.lock`, held by a child process for as long as this one lives or
 * until `release`, so a crashed run frees it. Waits for the holder, or with `wait` false returns `undefined` at once.
 */
export function takeLock(stateFile: string, wait: boolean): Promise<SyncLock | undefined> {
  const lock = `${stateFile}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  const child = spawn("flock", ["-x", "-E", String(LOCK_HELD), ...(wait ? [] : ["-n"]), lock, "sh", "-c", "echo locked; exec cat"], { stdio: ["pipe", "pipe", "inherit"] });
  return new Promise((resolvePromise, reject) => {
    const exited = new Promise<void>((done) => child.once("close", () => done()));
    child.once("error", reject);
    child.stdout.once("data", () =>
      resolvePromise({
        release: () => {
          child.stdin.end();
          return exited;
        },
      }),
    );
    child.once("close", (code) => {
      if (code === LOCK_HELD) resolvePromise(undefined);
      else reject(new Error(`flock ${lock} failed (exit ${String(code)})`));
    });
  });
}

/** What a second run leaves for the holder: one more run at its end, over what changed meanwhile. */
const againMarker = (stateFile: string): string => `${stateFile}.again`;

/** The file a package trigger leaves when it ran without systemd (#237): a sweep is owed, the next sync run makes it. */
export const pendingMarker = (stateFile: string): string => join(dirname(stateFile), "qualify-pending");

export interface SyncRunOptions {
  readonly force?: boolean;
  /** False under `--no-wait`: a run in progress is not waited for; the holder runs once more at its end instead. */
  readonly wait?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly log?: (line: string) => void;
}

/**
 * One run under the lock: waits for a run in progress, or with `wait` false leaves a marker for it and returns
 * `undefined`. The holder runs once more at its end for every marker left meanwhile.
 */
export async function runSync(settings: SyncSettings, options: SyncRunOptions = {}): Promise<SyncSummary | undefined> {
  const log = options.log ?? (() => {});
  const marker = againMarker(settings.stateFile);
  let lock = await takeLock(settings.stateFile, options.wait !== false);
  if (lock === undefined) {
    // the marker first, then the lock once more: a holder that finished in between is not left without a successor
    writeFileSync(marker, "");
    lock = await takeLock(settings.stateFile, false);
    if (lock === undefined) {
      log(`a run is in progress (${settings.stateFile}.lock); it runs once more at its end over what changed`);
      return undefined;
    }
  }
  try {
    let total: SyncSummary | undefined;
    for (;;) {
      rmSync(marker, { force: true });
      const one = await runLocked(settings, options);
      total = total === undefined ? one : addSummaries(total, one);
      if (!existsSync(marker)) {
        // a pass that went through settles what the trigger left behind (#237)
        rmSync(pendingMarker(settings.stateFile), { force: true });
        return total;
      }
      log("a run was asked for while this one ran; running once more");
    }
  } finally {
    await lock.release();
  }
}

function addSummaries(a: SyncSummary, b: SyncSummary): SyncSummary {
  const sent = (a.sent ?? 0) + (b.sent ?? 0);
  return {
    qualified: a.qualified + b.qualified,
    skipped: a.skipped + b.skipped,
    refused: a.refused + b.refused,
    crashed: a.crashed + b.crashed,
    hung: a.hung + b.hung,
    unmeasured: a.unmeasured + b.unmeasured,
    distributed: a.distributed + b.distributed,
    seconds: a.seconds + b.seconds,
    ...(sent === 0 ? {} : { sent }),
  };
}

/**
 * One run: wait for quiet, qualify what is new or changed, drop what is gone, write the state, the records, the
 * descriptors and the pin file, and send the changed pins to a running daemon. The state and the pin file are written
 * whole after every item, so a run cut short keeps all it finished.
 */
async function runLocked(settings: SyncSettings, options: SyncRunOptions): Promise<SyncSummary> {
  const log = options.log ?? (() => {});
  const env = options.env ?? process.env;
  log("sync run begins");
  {
    const started = Date.now();
    const dirs = [...settings.clapDirs, ...settings.lv2Dirs];
    await waitQuiet(dirs, settings.settleS, log);
    const ctx: SyncContext = { settings, env, log };
    const count = { qualified: 0, skipped: 0, refused: 0, crashed: 0, hung: 0, unmeasured: 0, distributed: 0 };
    const layer = distributedLayerOf(settings, options.force === true, log);
    let before: string;
    try {
      before = readFileSync(settings.pinFile, "utf8");
    } catch {
      before = "";
    }
    let state = readSyncState(settings.stateFile, log);
    const stateBefore = state;
    let unreadable = false;
    const lv2Pinned: string[] = [];
    // a change made while a pass ran is caught by one more pass, a few at most
    for (let pass = 0; pass < 3; pass++) {
      const signature = directoriesSignature(dirs);
      const { items, problems } = discoverSyncItems(settings);
      for (const p of problems) log(p);
      unreadable = problems.length > 0;
      const found = new Set(items.map((i) => i.key));
      const entries: Record<string, SyncEntry> = {};
      for (const [key, entry] of Object.entries(state.entries)) if (found.has(key)) entries[key] = entry;
      for (const key of Object.keys(state.entries)) if (!found.has(key)) log(`${key}: gone, its pin is dropped`);
      for (const item of items) {
        const recorded = recordedAsIs(item, entries[item.key]);
        if (recorded.same && options.force !== true) {
          if (pass === 0) count.skipped += entries[item.key]!.plugins.length;
          continue;
        }
        const files = recorded.files ?? digestFiles(item.root, item.files);
        if (files === undefined) {
          log(`${item.key}: a file of it cannot be read; skipped this run`);
          continue;
        }
        const taken = takeDistributed(ctx, layer, item, files);
        if (taken !== undefined) {
          entries[item.key] = taken;
          if (item.format === "lv2") lv2Pinned.push(...taken.plugins.filter((p) => p.pin !== undefined).map((p) => p.uri));
          count.distributed += taken.plugins.length;
          for (const p of taken.plugins) log(`distributed: ${p.uri}: applied (${taken.distributed!})`);
          state = { schema: SYNC_STATE_SCHEMA, entries };
          writeFileWhole(settings.stateFile, `${JSON.stringify(state, null, 1)}\n`);
          writeFileWhole(settings.pinFile, syncPinsText(state));
          continue;
        }
        const entry = qualifyItem(ctx, item, files);
        entries[item.key] = entry;
        if (item.format === "lv2") lv2Pinned.push(...entry.plugins.filter((p) => p.pin !== undefined).map((p) => p.uri));
        for (const p of entry.plugins) {
          count[p.outcome]++;
          log(`${p.uri}: ${p.outcome}${p.code === undefined ? "" : ` (${p.code})`}${p.detail === undefined ? "" : `: ${p.detail}`}`);
        }
        state = { schema: SYNC_STATE_SCHEMA, entries };
        writeFileWhole(settings.stateFile, `${JSON.stringify(state, null, 1)}\n`);
        writeFileWhole(settings.pinFile, syncPinsText(state));
      }
      state = { schema: SYNC_STATE_SCHEMA, entries };
      if (directoriesSignature(dirs) === signature) break;
      log("the plugin directories changed during the run; looking again");
    }
    writeFileWhole(settings.stateFile, `${JSON.stringify(state, null, 1)}\n`);
    const after = syncPinsText(state);
    if (after !== before) writeFileWhole(settings.pinFile, after);
    writeLv2Descriptors(ctx, lv2Pinned);
    for (const line of descriptorAccessProblems(settings.descriptorDir)) log(line);
    // the files of a plugin that is gone, or was replaced by other bytes: only when every directory could be read, so
    // an unreadable one is never taken for an uninstall
    if (unreadable) log("a plugin directory could not be read; no record or descriptor is removed this run");
    else for (const f of pruneStale(settings, stateBefore, state)) log(`${f}: removed, its plugin is gone or changed`);
    // a plugin that was pinned and is not any more is also forgotten by a running daemon
    const changed = [...changedPinLines(before, after), ...removedPinUris(before, after).map((uri) => `pin_clear ${uri}`)];
    const sent = await sendPins(settings.hostdPort, settings.hostdFeedbackPort, changed);
    if ("unsent" in sent) {
      const why = {
        off: "hostd_port is 0",
        absent: `no plugin-hostd listens on port ${String(settings.hostdPort)}`,
        held: `plugin-hostd on port ${String(settings.hostdPort)} did not answer: a controller holds its command socket`,
      }[sent.unsent];
      log(`${why}; the ${String(changed.length)} changed pins apply at its next start, from the pin file`);
    }
    const replies = "replies" in sent ? sent.replies : [];
    for (let i = 0; i < replies.length; i++) if (replies[i] !== "resp 0") log(`plugin-hostd answered ${replies[i]!} to ${changed[i]!.split(" ")[1]!}`);
    const taken = replies.filter((r) => r === "resp 0").length;
    return { ...count, seconds: (Date.now() - started) / 1000, ...(taken === 0 ? {} : { sent: taken }) };
  }
}

/** What a failed descriptor pass says: plainly, once, when the lilv binding is what is missing (a suite without python3-lilv). */
export function lv2DescriptorFailure(status: number | null, error: string | undefined, stderr: string): string {
  if (/No module named '?lilv/.test(stderr)) return "LV2 descriptors are not written: python3-lilv is not installed (install it, or the plugins are still qualified and pinned without descriptors)";
  return `LV2 descriptors not all written (${error ?? `exit ${String(status)}`}): ${stderr.trim().split("\n").slice(-3).join("; ")}`;
}

/** The descriptors of the LV2 plugins qualified this run, in one pass of the LV2 scanner; a failure is named. */
function writeLv2Descriptors(ctx: SyncContext, uris: readonly string[]): void {
  if (uris.length === 0) return;
  const out = mkdtempSync(join(tmpdir(), "plugin-qualify-sync-scan-"));
  try {
    const r = spawnSync(
      "python3",
      [join(toolsDir(), "scan.py"), "--descriptor-dir", ctx.settings.descriptorDir, "--out", join(out, "catalog.json"), ...uris],
      { encoding: "utf8", timeout: ctx.settings.budgetS * 1000 * Math.max(1, Math.ceil(uris.length / 10)), env: { ...ctx.env, LV2_PATH: ctx.settings.lv2Dirs.join(":") } },
    );
    if (r.status !== 0) ctx.log(lv2DescriptorFailure(r.status, r.error?.message, r.stderr ?? ""));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
