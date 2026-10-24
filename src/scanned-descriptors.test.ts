// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The CLAP half of the scanned descriptors' round trip (owner spec 6.6(f), step 5.2): the prober
 * scans every CLAP fixture, `tools/descriptors.py clap` writes their descriptors into a
 * descriptor_dir, and the interchange row rebuilt from each descriptor equals the row
 * `clapScanDescriptors` makes from the same scan, field by field. What that row drops, the
 * descriptor carries: those additions are listed and read back here. The LV2 half is
 * `tools/test_descriptors.py`.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { type ClapDescriptorParam, type ClapDescriptorRow, clapScanDescriptors, parseClapScan } from "./clap-loader.js";
import {
  DESCRIPTOR_CODE_BINARY_UNHASHED,
  DESCRIPTOR_CODE_DIR_UNWRITABLE,
  DESCRIPTOR_CODE_SCHEMA,
  DESCRIPTOR_CODE_SCHEMA_MISSING,
  DESCRIPTOR_DIR_KEY,
  DESCRIPTOR_DIR_STATE_SUBDIR,
  DESCRIPTOR_DIR_SYSTEM,
  DESCRIPTOR_HASH_PREFIX,
  DESCRIPTOR_SCHEMA_ENV,
  DESCRIPTOR_SCHEMA_INSTALLED,
} from "./qualify-declarations.js";
import { clapQualifyToolPath } from "./tool-paths.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(PKG, "native", "build", "fixtures");
const WRITER = join(PKG, "tools", "descriptors.py");
const scratch = mkdtempSync(join(tmpdir(), "scanned-descriptors-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Control {
  readonly id: number;
  readonly name: string;
  readonly kind: string;
  readonly travel?: { readonly min: number; readonly max: number; readonly default?: number; readonly scale: string };
  readonly ids?: readonly string[];
  readonly labels?: readonly string[];
  readonly values?: readonly number[];
  readonly default?: string;
  readonly group?: readonly string[];
  readonly hidden?: boolean;
  readonly readonly?: boolean;
}

interface Port {
  readonly id: number;
  readonly kind: string;
  readonly direction: string;
  readonly role?: string;
  readonly channels?: number;
  readonly dialects?: readonly string[];
}

interface Descriptor {
  readonly origin: string;
  readonly plugin: { readonly id: string; readonly name: string; readonly version?: string; readonly features: readonly string[] };
  readonly controls: readonly Control[];
  readonly ports: readonly Port[];
  readonly latency?: { readonly reports: boolean };
  readonly extensions?: { readonly clap?: Readonly<Record<string, unknown>> };
}

interface Page {
  readonly id: number;
  readonly section: string;
  readonly name: string;
  readonly params: readonly (number | null)[];
  readonly forPreset: boolean;
}

/** The interchange row, as the catalog would rebuild it from a scanned CLAP descriptor alone. */
function rowOf(d: Descriptor): Omit<ClapDescriptorRow, "binaryPath"> {
  const bag = d.extensions?.clap ?? {};
  const channels = (dir: string): number =>
    d.ports.filter((p) => p.kind === "audio" && p.direction === dir).reduce((n, p) => n + (p.channels ?? 0), 0);
  const params = d.controls
    .filter((c) => c.hidden !== true && c.readonly !== true)
    .map((c): ClapDescriptorParam => {
      const module = c.group === undefined ? {} : { module: c.group.join("/") };
      if (c.kind === "choice") {
        const values = c.values!;
        const min = Math.min(...values);
        const max = Math.max(...values);
        const at = c.default === undefined ? -1 : c.ids!.indexOf(c.default);
        return {
          kind: "control",
          symbol: String(c.id),
          name: c.name,
          min,
          max,
          ...(at < 0 ? {} : { default: values[at]! }),
          isInteger: true,
          isToggle: min === 0 && max === 1,
          isEnumeration: true,
          ...module,
          scalePoints: values.map((value, i) => ({ label: c.labels?.[i] ?? c.ids![i]!, value })),
        };
      }
      const t = c.travel!;
      const stepped = t.scale === "stepped";
      return {
        kind: "control",
        symbol: String(c.id),
        name: c.name,
        min: t.min,
        max: t.max,
        ...(t.default === undefined ? {} : { default: t.default }),
        isInteger: stepped,
        isToggle: stepped && t.min === 0 && t.max === 1,
        isEnumeration: false,
        ...module,
      };
    });
  const latency = bag["clap_plugin_latency.get"];
  const pages = (bag["clap_plugin_remote_controls.get"] ?? []) as readonly Page[];
  return {
    uri: `urn:clap:${d.plugin.id}`,
    name: d.plugin.name,
    lv2Class: null,
    audioInputs: channels("in"),
    audioOutputs: channels("out"),
    hasMidiIn: d.ports.some((p) => p.kind === "note" && p.direction === "in"),
    params,
    format: "clap",
    ...(typeof latency === "number" ? { latency: { reportedFrames: latency } } : {}),
    remoteControls: pages
      .filter((r) => !r.forPreset)
      .map((r) => ({ id: r.id, section: r.section, name: r.name, params: r.params.map((id) => (id === null ? null : String(id))) })),
  };
}

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const safe = (text: string): string => text.replace(/[^A-Za-z0-9._-]/g, "_");

function scan(paths: readonly string[]): string {
  const run = spawnSync(clapQualifyToolPath(), ["--json", ...paths], { encoding: "utf8", maxBuffer: 1 << 28 });
  expect(run.status).toBe(0);
  return run.stdout;
}

function write(doc: string, dir: string): { status: number | null; stderr: string } {
  const run = spawnSync("python3", [WRITER, "clap", "--descriptor-dir", dir, "-"], { input: doc, encoding: "utf8", maxBuffer: 1 << 28 });
  return { status: run.status, stderr: run.stderr };
}

function readDir(dir: string): Map<string, { file: string; doc: Descriptor }> {
  const out = new Map<string, { file: string; doc: Descriptor }>();
  for (const file of readdirSync(dir).sort()) {
    const doc = JSON.parse(readFileSync(join(dir, file), "utf8")) as Descriptor;
    out.set(doc.plugin.id, { file, doc });
  }
  return out;
}

function built(ctx: { skip: (note?: string) => void }): boolean {
  if (existsSync(clapQualifyToolPath()) && existsSync(join(FIXTURES, "controls.clap"))) return true;
  if (process.env["CI"]) throw new Error("native/build is missing: CI builds it with make -C native deps all");
  ctx.skip("native/build is missing: make -C native deps all");
  return false;
}

describe("the CLAP fixture set through clap-qualify and descriptors.py", () => {
  it("every fixture plugin is written, named by id, version and its file's SHA-256, and its row rebuilt from it equals clapScanDescriptors'", (ctx) => {
    if (!built(ctx)) return;
    const text = scan([FIXTURES]);
    const dir = join(scratch, "all");
    const w = write(text, dir);
    expect(w.stderr).toBe("");
    expect(w.status).toBe(0);
    const doc = parseClapScan(text);
    const rows = clapScanDescriptors(doc);
    const written = readDir(dir);
    expect(rows.length).toBe(18);
    expect([...written.keys()].sort()).toEqual(rows.map((r) => r.uri.replace(/^urn:clap:/, "")).sort());
    for (const row of rows) {
      const id = row.uri.replace(/^urn:clap:/, "");
      const { file, doc: d } = written.get(id)!;
      expect(d.origin).toBe("scanned");
      expect(file).toBe(`${safe(id)}@${safe(d.plugin.version ?? "unversioned")}-${sha256(row.binaryPath).slice(0, DESCRIPTOR_HASH_PREFIX)}.json`);
      const { binaryPath: _b, ...expected } = row;
      expect(rowOf(d), id).toEqual(expected);
    }
  });

  it("what clapScanDescriptors drops, the descriptor adds: features, note ports and their dialects, hidden and read-only controls, latency", (ctx) => {
    if (!built(ctx)) return;
    const dir = join(scratch, "additions");
    expect(write(scan([FIXTURES]), dir).status).toBe(0);
    const d = (id: string): Descriptor => readDir(dir).get(`org.freemixer.plugin-qualify.fixture.${id}`)!.doc;
    expect(d("synth").plugin.features).toEqual(["instrument"]);
    expect(d("rt-safe").plugin.features).toEqual(["audio-effect"]);
    expect(d("synth").extensions?.clap?.["clap_plugin_descriptor.features"]).toEqual(["instrument", "stereo"]);
    expect(d("synth").ports.filter((p) => p.kind === "note")).toEqual([{ id: 0, name: "notes", kind: "note", direction: "in", dialects: ["clap", "midi"] }]);
    expect(d("synth-midi").ports.find((p) => p.kind === "note")?.dialects).toEqual(["midi"]);
    expect(d("controls").ports.map((p) => [p.direction, p.role, p.channels])).toEqual([["in", "main", 2], ["out", "main", 2]]);
    const hidden = d("params-2048").controls.filter((c) => c.hidden === true && c.readonly === true);
    expect(hidden.length).toBeGreaterThan(0);
    expect(d("params-2048").controls).toHaveLength(2048);
    expect(rowOf(d("params-2048")).params.length).toBe(2048 - hidden.length);
    expect(d("leaky-delay").latency).toEqual({ reports: true });
    expect(d("rt-safe").latency).toEqual({ reports: false });
  });

  it("a changed binary is a new file name, and the old file stays", (ctx) => {
    if (!built(ctx)) return;
    const plugin = join(scratch, "changed", "controls.clap");
    mkdirSync(dirname(plugin), { recursive: true });
    copyFileSync(join(FIXTURES, "controls.clap"), plugin);
    const dir = join(scratch, "changed-out");
    expect(write(scan([plugin]), dir).status).toBe(0);
    const before = readdirSync(dir);
    appendFileSync(plugin, Buffer.from([0]));
    expect(write(scan([plugin]), dir).status).toBe(0);
    const after = readdirSync(dir).sort();
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(2);
    expect(after).toContain(before[0]);
    const hashes = after.map((f) => /-([0-9a-f]{12})\.json$/.exec(f)?.[1]);
    expect(new Set(hashes).size).toBe(2);
    expect(hashes).toContain(sha256(plugin).slice(0, DESCRIPTOR_HASH_PREFIX));
    expect(after.every((f) => f.startsWith("org.freemixer.plugin-qualify.fixture.controls@1-"))).toBe(true);
  });

  it("a descriptor the schema refuses is not written: contract.file.invalid, exit 2", (ctx) => {
    if (!built(ctx)) return;
    const doc = JSON.parse(scan([join(FIXTURES, "controls.clap")]));
    // a port role the schema has no word for: the writer refuses the file rather than write it
    doc.files[0].plugins[0].audio_ports.inputs[0].role = "sidechain-ish";
    const dir = join(scratch, "refused");
    const w = write(JSON.stringify(doc), dir);
    expect(w.status).toBe(2);
    expect(w.stderr).toContain(`descriptor refused: org.freemixer.plugin-qualify.fixture.controls: ${DESCRIPTOR_CODE_SCHEMA}: ports/0/role`);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });
});

describe("the README states the directory, its key and the name as the code declares them", () => {
  const readme = readFileSync(join(PKG, "README.md"), "utf8");
  it("the key, the user and system defaults, the file name and the codes", () => {
    expect(readme).toContain(`the key \`${DESCRIPTOR_DIR_KEY}\``);
    expect(readme).toContain(`\`$XDG_STATE_HOME/${DESCRIPTOR_DIR_STATE_SUBDIR}\`, else \`~/.local/state/${DESCRIPTOR_DIR_STATE_SUBDIR}\``);
    expect(readme).toContain(`\`${DESCRIPTOR_DIR_SYSTEM}\``);
    expect(readme).toContain(`\`<id>@<version>-<sha256 first ${DESCRIPTOR_HASH_PREFIX}>.json\``);
    for (const code of [DESCRIPTOR_CODE_SCHEMA, DESCRIPTOR_CODE_BINARY_UNHASHED, DESCRIPTOR_CODE_DIR_UNWRITABLE, DESCRIPTOR_CODE_SCHEMA_MISSING]) {
      expect(readme).toContain(`\`${code}\``);
    }
    expect(readme).toContain(`\`${DESCRIPTOR_SCHEMA_INSTALLED}\``);
    expect(readme).toContain(`\`${DESCRIPTOR_SCHEMA_ENV}\``);
  });

  it("the writer resolves the same defaults the README states", () => {
    const run = spawnSync("python3", ["-c",
      "import sys; sys.path.insert(0, sys.argv[1]); import descriptors as d; "
      + "print(d.descriptor_dir(env={'XDG_STATE_HOME': '/s'})); print(d.descriptor_dir(env={}, home='/h')); print(d.descriptor_dir(system=True))",
      join(PKG, "tools")], { encoding: "utf8" });
    expect(run.stdout.trim().split("\n")).toEqual([
      `/s/${DESCRIPTOR_DIR_STATE_SUBDIR}`,
      `/h/.local/state/${DESCRIPTOR_DIR_STATE_SUBDIR}`,
      DESCRIPTOR_DIR_SYSTEM,
    ]);
  });
});
