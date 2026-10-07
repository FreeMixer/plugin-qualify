// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The CLAP implementation of the one discovery seam (`loader.ts`, spec
 * `docs/design/specs/2026-09-25-plugin-qualify.md` §7). A target that is a `.clap` file, or a
 * directory holding one, is scanned by `omx-clap-scan --json` (the scanner of omx-clap-host),
 * located by the ONE declared setting; `urn:clap:<id>` is one plugin without a scan. The
 * scanner's JSON is the input: {@link clapScanDescriptors} normalises it into the interchange
 * rows. A scan that cannot be read is a {@link ClapScanError}, never an empty result.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { PluginLoader, PluginTarget } from "./loader.js";
import { CLAP_SCAN_TIMEOUT_S, CLAP_SCAN_TOOL_DEFAULT, CLAP_SCAN_TOOL_ENV } from "./qualify-declarations.js";

/** The scanner's own name in its document — anything else is not its output. */
const SCANNER_NAME = "omx-clap-scan";
const CLAP_URI = /^urn:clap:(\S+)$/;
const CLAP_SUFFIX = ".clap";
/** A `.clap` directory listing can be tens of megabytes of JSON. */
const MAX_SCAN_BYTES = 1 << 30;

export class ClapScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClapScanError";
  }
}

// --- the scanner's document ----------------------------------------------------------------------

export interface ClapScanParam {
  readonly id: number;
  readonly name: string;
  readonly module: string;
  /** null where the plugin leaves the bound open (JSON has no infinity). */
  readonly min: number | null;
  readonly max: number | null;
  readonly default: number | null;
  readonly flags: readonly string[];
}

export interface ClapScanPort {
  readonly id: number;
  readonly name: string;
  readonly role: "main" | "aux";
  readonly channels: number;
}

/** A plugin the scanner created and read. */
export interface ClapScanPlugin {
  readonly id: string;
  readonly name: string;
  readonly vendor: string;
  readonly version: string;
  readonly description: string;
  readonly url: string;
  readonly features: readonly string[];
  readonly params: readonly ClapScanParam[];
  readonly audio_ports: { readonly inputs: readonly ClapScanPort[]; readonly outputs: readonly ClapScanPort[] };
  readonly note_ports: { readonly inputs: number; readonly outputs: number };
  /** Frames, present only when the plugin reported more than 0 before it was activated. */
  readonly latency?: number;
}

/** A plugin whose descriptor was read but which could not be created or initialised. */
export interface ClapScanPluginError {
  readonly id: string;
  readonly name: string;
  readonly error: string;
}

export type ClapScanFile =
  | { readonly path: string; readonly plugins: readonly (ClapScanPlugin | ClapScanPluginError)[] }
  | { readonly path: string; readonly error: string };

export interface ClapScanDocument {
  readonly scanner: string;
  readonly version: string;
  readonly files: readonly ClapScanFile[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Object.prototype.toString.call(v) === "[object Object]";
}

function bad(what: string): never {
  throw new ClapScanError(`${SCANNER_NAME} output is not its document: ${what}`);
}

function str(o: Record<string, unknown>, key: string, where: string): string {
  const v = o[key];
  return typeof v === "string" ? v : bad(`${where} has no string ${key}`);
}

function num(o: Record<string, unknown>, key: string, where: string): number {
  const v = o[key];
  return typeof v === "number" ? v : bad(`${where} has no number ${key}`);
}

function list(o: Record<string, unknown>, key: string, where: string): unknown[] {
  const v = o[key];
  return Array.isArray(v) ? v : bad(`${where} has no array ${key}`);
}

function bound(o: Record<string, unknown>, key: string, where: string): number | null {
  const v = o[key];
  return v === null ? null : typeof v === "number" ? v : bad(`${where} has no number or null ${key}`);
}

function parsePort(v: unknown, where: string): ClapScanPort {
  if (!isRecord(v)) return bad(`${where} is not an object`);
  const role = str(v, "role", where);
  if (role !== "main" && role !== "aux") return bad(`${where} has role ${role}`);
  return { id: num(v, "id", where), name: str(v, "name", where), role, channels: num(v, "channels", where) };
}

function parsePlugin(v: unknown, where: string): ClapScanPlugin | ClapScanPluginError {
  if (!isRecord(v)) return bad(`${where} is not an object`);
  const id = str(v, "id", where);
  const name = str(v, "name", where);
  if (typeof v["error"] === "string") return { id, name, error: v["error"] };
  const ports = v["audio_ports"];
  const notes = v["note_ports"];
  if (!isRecord(ports)) return bad(`${where} has no audio_ports`);
  if (!isRecord(notes)) return bad(`${where} has no note_ports`);
  const params = list(v, "params", where).map((p, i): ClapScanParam => {
    const w = `${where} param ${i}`;
    if (!isRecord(p)) return bad(`${w} is not an object`);
    return {
      id: num(p, "id", w),
      name: str(p, "name", w),
      module: str(p, "module", w),
      min: bound(p, "min", w),
      max: bound(p, "max", w),
      default: bound(p, "default", w),
      flags: list(p, "flags", w).map((f) => (typeof f === "string" ? f : bad(`${w} has a flag that is not a string`))),
    };
  });
  return {
    id,
    name,
    vendor: str(v, "vendor", where),
    version: str(v, "version", where),
    description: str(v, "description", where),
    url: str(v, "url", where),
    features: list(v, "features", where).map((f) => (typeof f === "string" ? f : bad(`${where} has a feature that is not a string`))),
    params,
    audio_ports: {
      inputs: list(ports, "inputs", `${where} audio_ports`).map((p, i) => parsePort(p, `${where} input ${i}`)),
      outputs: list(ports, "outputs", `${where} audio_ports`).map((p, i) => parsePort(p, `${where} output ${i}`)),
    },
    note_ports: { inputs: num(notes, "inputs", `${where} note_ports`), outputs: num(notes, "outputs", `${where} note_ports`) },
    ...(v["latency"] === undefined ? {} : { latency: num(v, "latency", where) }),
  };
}

/** The scanner's stdout as its document, or a {@link ClapScanError} saying how it differs. */
export function parseClapScan(text: string): ClapScanDocument {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ClapScanError(`${SCANNER_NAME} printed something that is not JSON`);
  }
  if (!isRecord(doc)) return bad("not an object");
  if (doc["scanner"] !== SCANNER_NAME) return bad(`scanner is ${JSON.stringify(doc["scanner"])}`);
  const files = list(doc, "files", "the document").map((f, i): ClapScanFile => {
    const where = `file ${i}`;
    if (!isRecord(f)) return bad(`${where} is not an object`);
    const path = str(f, "path", where);
    if (typeof f["error"] === "string") return { path, error: f["error"] };
    return { path, plugins: list(f, "plugins", `file ${path}`).map((p, j) => parsePlugin(p, `plugin ${j} of ${path}`)) };
  });
  return { scanner: SCANNER_NAME, version: str(doc, "version", "the document"), files };
}

// --- the interchange row -------------------------------------------------------------------------

/** One control, shaped as the catalog's `PluginParam` (structurally; this package imports no other). */
export interface ClapDescriptorParam extends ClapControlBounds {
  readonly isInteger: boolean;
  readonly isToggle: boolean;
  readonly isEnumeration: boolean;
  readonly kind: "control";
  /** The CLAP parameter id in decimal — the key `param_set` takes. */
  readonly symbol: string;
  readonly name: string;
}

/** Each bound is absent where the plugin leaves it open. */
interface ClapControlBounds {
  readonly min?: number;
  readonly max?: number;
  readonly default?: number;
}

/** A scanned CLAP plugin as the catalog's `PluginDescriptor` reads it — a declared fact of the scan. */
export interface ClapDescriptorRow {
  readonly uri: string;
  readonly name: string;
  readonly lv2Class: null;
  readonly audioInputs: number;
  readonly audioOutputs: number;
  readonly hasMidiIn: boolean;
  readonly params: readonly ClapDescriptorParam[];
  readonly format: "clap";
  readonly binaryPath: string;
  readonly latency?: { readonly reportedFrames: number };
}

function isPlugin(p: ClapScanPlugin | ClapScanPluginError): p is ClapScanPlugin {
  return !("error" in p);
}

function controlOf(p: ClapScanParam): ClapDescriptorParam {
  const stepped = p.flags.includes("stepped");
  return {
    kind: "control",
    symbol: String(p.id),
    name: p.name,
    ...(p.min === null ? {} : { min: p.min }),
    ...(p.max === null ? {} : { max: p.max }),
    ...(p.default === null ? {} : { default: p.default }),
    isInteger: stepped,
    isToggle: stepped && p.min === 0 && p.max === 1,
    isEnumeration: p.flags.includes("enum"),
  };
}

const channels = (ports: readonly ClapScanPort[]): number => ports.reduce((n, p) => n + p.channels, 0);

/**
 * The rows for every plugin the scanner created. A hidden or read-only parameter is not a
 * control anyone may set, so it is not offered as one. Nothing here claims a qualification:
 * the `clap` measurement stays absent, which the verdict reads as `unknown`.
 */
export function clapScanDescriptors(doc: ClapScanDocument): ClapDescriptorRow[] {
  const rows: ClapDescriptorRow[] = [];
  for (const file of doc.files) {
    if (!("plugins" in file)) continue;
    const binaryPath = resolve(file.path);
    for (const p of file.plugins) {
      if (!isPlugin(p)) continue;
      rows.push({
        uri: `urn:clap:${p.id}`,
        name: p.name,
        lv2Class: null,
        audioInputs: channels(p.audio_ports.inputs),
        audioOutputs: channels(p.audio_ports.outputs),
        hasMidiIn: p.note_ports.inputs > 0,
        params: p.params.filter((q) => !q.flags.includes("hidden") && !q.flags.includes("readonly")).map(controlOf),
        format: "clap",
        binaryPath,
        ...(p.latency === undefined ? {} : { latency: { reportedFrames: p.latency } }),
      });
    }
  }
  return rows;
}

// --- the loader ----------------------------------------------------------------------------------

/** What a run of the scanner gave back; `error` is a spawn failure (absent binary, timeout). */
export interface ClapScanRunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly error?: Error;
}

export type ClapScanRun = (tool: string, args: readonly string[], timeoutMs: number) => ClapScanRunResult;

const spawnScan: ClapScanRun = (tool, args, timeoutMs) => {
  const r = spawnSync(tool, [...args], { encoding: "utf8", timeout: timeoutMs, maxBuffer: MAX_SCAN_BYTES });
  return { status: r.status, stdout: r.stdout ?? "", ...(r.error === undefined ? {} : { error: r.error }) };
};

/** The scanner binary: the declared setting when set, else the declared default (on `PATH`). */
export function clapScanTool(env: Readonly<Record<string, string | undefined>>): string {
  const named = env[CLAP_SCAN_TOOL_ENV];
  return named === undefined || named === "" ? CLAP_SCAN_TOOL_DEFAULT : named;
}

function holdsClap(dir: string): boolean {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const isDir = e.isDirectory() || (e.isSymbolicLink() && existsSync(p) && statSync(p).isDirectory());
    if (isDir ? holdsClap(p) : e.name.endsWith(CLAP_SUFFIX)) return true;
  }
  return false;
}

export interface ClapLoaderOptions {
  /** Runs the scanner; the default spawns it. Injectable so the seam is testable without the binary. */
  readonly run?: ClapScanRun;
  /** Where the one setting is read from; the default is `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function scan(target: string, options: ClapLoaderOptions): ClapScanDocument {
  const tool = clapScanTool(options.env ?? process.env);
  const r = (options.run ?? spawnScan)(tool, ["--json", target], CLAP_SCAN_TIMEOUT_S * 1000);
  if (r.error !== undefined) {
    throw new ClapScanError(
      `cannot run the CLAP scanner "${tool}" (${r.error.message}): set ${CLAP_SCAN_TOOL_ENV} to the omx-clap-scan binary of omx-clap-host`,
    );
  }
  if (r.status !== 0) throw new ClapScanError(`${tool} exited ${String(r.status)} scanning ${target}`);
  return parseClapScan(r.stdout);
}

export function clapLoader(options: ClapLoaderOptions = {}): PluginLoader {
  return {
    format: "clap",
    resolve(target: string): readonly PluginTarget[] | undefined {
      const named = CLAP_URI.exec(target);
      if (named !== null) return [{ format: "clap", uri: target }];
      if (!existsSync(target)) return undefined;
      const st = statSync(target);
      if (st.isFile() ? !target.endsWith(CLAP_SUFFIX) : !st.isDirectory() || !holdsClap(target)) return undefined;
      return clapScanDescriptors(scan(target, options)).map((row) => ({
        format: "clap",
        uri: row.uri,
        bundle: dirname(row.binaryPath),
        binary: basename(row.binaryPath),
        binaryPath: row.binaryPath,
      }));
    },
  };
}
