// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * `plugin-qualify-sync --adapter-only`: an LV2 plugin's verdict on omx-clap-host is decided by its run under plugin-hostd's
 * LV2 adapter, and a record without one owes it (`qualify-rejudge.ts`). This pass makes only that run, for each plugin, at
 * each cell a Pi runs, and puts the block in the record; every other figure stays as it was, and `--rejudge` reads it.
 *
 * Each cell has a private JACK server of its own (`jackd -d dummy`, the rate and quantum on its command line), so that the
 * run can never reach the device's live server (plugin-qualify#187), and each run a fresh host, its time limited by
 * `budget_s` a command and its address space by the limit of a direct spawn. A crash or a timeout is the plugin's recorded
 * outcome. A pass does not start without the versions of the hosts it runs, or without a private server: nothing it could
 * write would say what it measured. A plugin is finished when its block was taken at these host versions at every cell,
 * so a pass cut short can be run again; a host that could not be run decides nothing, and that plugin is tried again.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { ADAPTER_HOST, ADAPTER_SILENT_CODE, SPAWNED_ADMISSIONS, admitUnderAdapter, type AdmissionRuns, type HostAdmission } from "./host-admission.js";
import { HOSTD_ENV } from "./hostd-pin-files.js";
import { cellKey, type GridCell } from "./measurement-grid.js";
import { defaultAddressSpaceLimit } from "./direct-limit.js";
import { PROBE_OK } from "./probe-output.js";
import { QUALIFICATION_RECORD_SCHEMA, type AdapterBlock, type QualificationRecord } from "./qualification-record.js";
import { ADMIT_ADDRESS_KB_ENV, ADMIT_STATE_DIR_ENV, ADMIT_STEP_MS_ENV, PI_CELLS } from "./qualify-declarations.js";
import { digestFiles, type SyncContext, type SyncState } from "./qualify-sync.js";
import { writeFileWhole } from "./whole-file.js";

/** The cells the pass runs at: the ones a Pi runs. */
export const ADAPTER_PASS_CELLS: readonly GridCell[] = PI_CELLS;

/** The code of a cell no private server could be had for: the run did not happen. */
export const NO_PRIVATE_SERVER = `${ADAPTER_HOST}.no-private-server`;

const RECORD_SUFFIX = ".qualification.json";
const SERVER_WAIT_MS = 5000;
const SERVER_SETTLE_MS = 300;
const SERVER_STOP_MS = 2000;

/** What a program answers to `--version`: its last word on the line that says `version`. */
export function parseVersion(text: string): string | undefined {
  return /version:?\s+(\S+)/.exec(text)?.[1];
}

export type VersionRun = (tool: string) => { readonly status: number | null; readonly stdout: string };

const spawnVersion: VersionRun = (tool) => {
  const r = spawnSync(tool, ["--version"], { encoding: "utf8", timeout: 10000, killSignal: "SIGKILL" });
  return { status: r.status, stdout: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
};

/** The versions of the hosts as installed now, or which of them could not say. */
export function hostVersions(env: Readonly<Record<string, string | undefined>>, run: VersionRun = spawnVersion): { ok: true; versions: Readonly<Record<string, string>> } | { ok: false; error: string } {
  const versions: Record<string, string> = {};
  for (const [name, tool] of [[ADAPTER_HOST, ADAPTER_HOST], ["plugin-hostd", env[HOSTD_ENV] ?? "plugin-hostd"]] as const) {
    const r = run(tool);
    const version = r.status === 0 ? parseVersion(r.stdout) : undefined;
    if (version === undefined) return { ok: false, error: `${tool} --version names no version, so a run could not say which host it was under` };
    versions[name] = version;
  }
  return { ok: true, versions };
}

/** A private JACK server for one cell, for as long as a pass needs it. */
export interface PrivateJack {
  readonly name: string;
  alive(): boolean;
  stop(): void;
}

export type JackStarter = (cell: GridCell) => PrivateJack | undefined;

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * jackd under a shell that waits for it. A pass is synchronous, so this process cannot reap a child; an unreaped jackd
 * that had a client stays in JACK's server table as alive, and the next start under its name reads "server already active".
 * The shell outlives jackd whatever happens: a TERM reaches jackd once, and HUP is how a stop that gives up kills jackd alone.
 * Killed with its group, the shell could not reap it.
 */
const REAPING_JACKD = `trap : TERM; trap 'kill -KILL $p 2>/dev/null' HUP; jackd "$@" & p=$!; while kill -0 $p 2>/dev/null; do wait $p; done`;

/** `jackd` on a name of its own and the dummy driver, at the cell's rate and quantum; `undefined` when none came up. */
export const startPrivateJack: JackStarter = (cell) => {
  const name = `omx-qualify-${String(process.pid)}-${String(cell.quantum)}`;
  let child: ChildProcess;
  let ended = false;
  try {
    child = spawn("sh", ["-c", REAPING_JACKD, "sh", "-r", "-n", name, "-d", "dummy", "-r", String(cell.rate), "-p", String(cell.quantum)], { stdio: "ignore", detached: true });
  } catch {
    return undefined;
  }
  child.on("error", () => (ended = true));
  child.on("exit", () => (ended = true));
  child.unref();
  const running = (): boolean => {
    if (ended || child.pid === undefined) return false;
    // the exit event needs the loop this synchronous pass holds: the process table says
    return existsSync(`/proc/${String(child.pid)}`) && !/^\S+ \(.*\) Z/.test(readStat(child.pid));
  };
  // a TERM first: jackd frees the shared memory it holds under /dev/shm itself, which a KILL would leave behind for good
  const signal = (sig: NodeJS.Signals): void => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, sig);
    } catch {
      // already gone
    }
  };
  const stop = (): void => {
    signal("SIGTERM");
    const until = Date.now() + SERVER_STOP_MS;
    while (running() && Date.now() < until) sleepSync(20);
    if (running()) {
      try {
        if (child.pid !== undefined) process.kill(child.pid, "SIGHUP");
      } catch {
        // already gone
      }
      const killed = Date.now() + SERVER_STOP_MS;
      while (running() && Date.now() < killed) sleepSync(20);
    }
    signal("SIGKILL");
    for (const d of serverDirs(name)) rmSync(d, { recursive: true, force: true });
  };
  const until = Date.now() + SERVER_WAIT_MS;
  while (Date.now() < until) {
    if (child.pid === undefined || !running()) {
      stop();
      return undefined;
    }
    if (serverDirs(name).length > 0) {
      sleepSync(SERVER_SETTLE_MS);
      return { name, alive: running, stop };
    }
    sleepSync(50);
  }
  stop();
  return undefined;
};

const readStat = (pid: number): string => {
  try {
    return readFileSync(`/proc/${String(pid)}/stat`, "utf8");
  } catch {
    return "";
  }
};

/** Where jackd keeps a server's sockets, and its semaphores: the socket appears as the server opens it. */
function serverDirs(name: string): string[] {
  try {
    return readdirSync("/dev/shm").filter((d) => d.startsWith(`jack_${name}_`) || new RegExp(`^jack_sem\\.\\d+_${name}_`).test(d)).map((d) => join("/dev/shm", d));
  } catch {
    return [];
  }
}

/** Whether a machine can give a pass its private server at all: the program is there. */
function jackdInstalled(env: Readonly<Record<string, string | undefined>>): boolean {
  return (env["PATH"] ?? process.env["PATH"] ?? "").split(":").some((d) => d !== "" && existsSync(join(d, "jackd")));
}

// --- the block --------------------------------------------------------------------------------------------------------

/**
 * The runs of every cell as one block. Its top is what the judge reads: a refusal or a crash at any cell decides, with the
 * cell it happened at, whatever the others say; then a cell where the host could not be run leaves it not measured, so
 * still owed; only every cell admitted is admitted. Pure.
 */
export function adapterBlockOf(runs: readonly { readonly cell: GridCell; readonly run: HostAdmission }[], versions: Readonly<Record<string, string>>, measuredAt: string): AdapterBlock {
  const cells = runs.map(({ cell, run }) => ({ rate: cell.rate, quantum: cell.quantum, measured: run.measured, admitted: run.admitted, ...(run.code === undefined ? {} : { code: run.code }), params: run.params }));
  const worst = cells.find((c) => c.measured && !c.admitted) ?? cells.find((c) => !c.measured);
  const top =
    worst === undefined
      ? { measured: true, admitted: true, params: {} }
      : { measured: worst.measured, admitted: false, ...(worst.code === undefined ? {} : { code: worst.code }), params: { ...worst.params, rate: worst.rate, quantum: worst.quantum } };
  return { host: ADAPTER_HOST, ...top, versions, measuredAt, cells };
}

/** The record with the block, and every other byte of it as it was. Pure. */
export const mergeAdapterRun = (record: QualificationRecord, block: AdapterBlock): QualificationRecord => ({ ...record, adapter: block });

/** Whether a record's adapter run is done: at these host versions, measured, at every cell. */
export function adapterFinished(record: QualificationRecord, versions: Readonly<Record<string, string>>, cells: readonly GridCell[] = ADAPTER_PASS_CELLS): boolean {
  const a = record.adapter;
  if (a === undefined || !a.measured || a.versions === undefined || a.cells === undefined) return false;
  // silence under the one key the run once played says nothing of a plugin that maps others: it is run again
  if (a.cells.some((c) => c.code === ADAPTER_SILENT_CODE && c.params["notes"] === undefined)) return false;
  const same = Object.keys(versions).length === Object.keys(a.versions).length && Object.entries(versions).every(([k, v]) => a.versions![k] === v);
  return same && cells.every((c) => a.cells!.some((x) => cellKey(x) === cellKey(c)));
}

// --- the pass ---------------------------------------------------------------------------------------------------------

export interface AdapterPassOptions {
  readonly force?: boolean;
  readonly runs?: AdmissionRuns;
  readonly jack?: JackStarter;
  readonly versions?: VersionRun;
  /** The test's stand-in for jackd says it is there; the real pass looks. */
  readonly jackdPresent?: boolean;
  readonly now?: () => string;
}

export interface AdapterPassResult {
  readonly measured: number;
  readonly already: number;
  readonly failed: number;
  readonly versions: Readonly<Record<string, string>>;
}

/** The pass could not start: nothing was run and nothing written. */
export class AdapterPassRefused extends Error {}

const readRecord = (path: string): QualificationRecord | undefined => {
  try {
    const r = JSON.parse(readFileSync(path, "utf8")) as QualificationRecord;
    return r.schema === QUALIFICATION_RECORD_SCHEMA ? r : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The run of each LV2 plugin of the state whose probe ended well (one that did not has no verdict a run could decide), at
 * each cell. Each record is written whole as its plugin ends.
 */
export function adapterPass(ctx: SyncContext, state: SyncState, options: AdapterPassOptions = {}): AdapterPassResult {
  const read = hostVersions(ctx.env, options.versions);
  if (!read.ok) throw new AdapterPassRefused(read.error);
  if (!(options.jackdPresent ?? jackdInstalled(ctx.env))) throw new AdapterPassRefused(`no jackd on the path: ${NO_PRIVATE_SERVER}, and the device's own JACK server is never used for this`);
  const { versions } = read;
  const starter = options.jack ?? startPrivateJack;
  const runs = options.runs ?? SPAWNED_ADMISSIONS;
  const now = options.now ?? (() => new Date().toISOString());
  const servers = new Map<string, PrivateJack>();
  const serverFor = (cell: GridCell): PrivateJack | undefined => {
    const key = cellKey(cell);
    const had = servers.get(key);
    if (had?.alive() === true) return had;
    had?.stop();
    servers.delete(key);
    const fresh = starter(cell);
    if (fresh !== undefined) servers.set(key, fresh);
    return fresh;
  };
  const count = { measured: 0, already: 0, failed: 0 };
  const limit = { [ADMIT_STEP_MS_ENV]: String(ctx.settings.budgetS * 1000), [ADMIT_ADDRESS_KB_ENV]: String(Math.ceil(defaultAddressSpaceLimit() / 2 ** 10)) };
  try {
    for (const [key, entry] of Object.entries(state.entries)) {
      if (entry.format !== "lv2") continue;
      const files = digestFiles(entry.root, entry.files.map((f) => f.path), entry.files);
      if (files === undefined || !files.every((f) => entry.files.some((x) => x.path === f.path && x.sha256 === f.sha256))) {
        ctx.log(`${key}: its files changed since it was measured; the sync measures it whole`);
        continue;
      }
      for (const plugin of entry.plugins) {
        if (plugin.record === undefined || !plugin.record.endsWith(RECORD_SUFFIX)) continue;
        const path = join(ctx.settings.qualificationDir, basename(plugin.record));
        const record = readRecord(path);
        if (record === undefined) {
          ctx.log(`${plugin.uri}: its record does not read; no adapter run`);
          count.failed++;
          continue;
        }
        if (record.probe.outcome !== PROBE_OK) continue;
        if (options.force !== true && adapterFinished(record, versions)) {
          count.already++;
          continue;
        }
        const started = Date.now();
        const done = ADAPTER_PASS_CELLS.map((cell) => {
          const server = serverFor(cell);
          if (server === undefined) return { cell, run: { host: ADAPTER_HOST, measured: false, admitted: false, code: NO_PRIVATE_SERVER, params: {} } as HostAdmission };
          const stateDir = mkdtempSync(join(tmpdir(), "plugin-qualify-adapter-state-"));
          try {
            const env = { ...ctx.env, ...limit, [ADMIT_STATE_DIR_ENV]: stateDir, LV2_PATH: ctx.settings.lv2Dirs.join(":"), JACK_DEFAULT_SERVER: server.name, JACK_NO_START_SERVER: "1" };
            return { cell, run: admitUnderAdapter(record.plugin.id, runs, env) ?? ({ host: ADAPTER_HOST, measured: false, admitted: false, code: `${ADAPTER_HOST}.admission-failed`, params: {} } as HostAdmission) };
          } finally {
            rmSync(stateDir, { recursive: true, force: true });
          }
        });
        const block = adapterBlockOf(done, versions, now());
        writeFileWhole(path, `${JSON.stringify(mergeAdapterRun(record, block), null, 2)}\n`);
        if (block.measured) count.measured++;
        else count.failed++;
        ctx.log(`${plugin.uri}: adapter ${block.measured ? (block.admitted ? "admitted" : `refused (${block.code ?? ""})`) : `not run (${block.code ?? ""})`} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
      }
    }
  } finally {
    for (const s of servers.values()) s.stop();
  }
  return { ...count, versions };
}
