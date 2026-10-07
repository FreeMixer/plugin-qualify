// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The CLAP arm of the one discovery seam (`docs/design/specs/2026-09-25-plugin-qualify.md` §7):
 * the loader runs `omx-clap-scan`, located by ONE declared setting, and turns its JSON into
 * targets and interchange rows. The goldens in `fixtures/clap-scan/` are the real tool's output
 * (against omx-clap-host's `tests/fake.clap`, and a directory holding a crashing and a broken
 * `.clap` beside it); the live test runs the built tool and requires it to say the same.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { CLAP_SCAN_TIMEOUT_S, CLAP_SCAN_TOOL_DEFAULT, CLAP_SCAN_TOOL_ENV } from "./qualify-declarations.js";
import {
  ClapScanError,
  clapLoader,
  clapScanDescriptors,
  clapScanTool,
  parseClapScan,
  type ClapScanRun,
} from "./clap-loader.js";
import { lv2Loader } from "./lv2-loader.js";
import { resolveTargets } from "./qualify-cli.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_JSON = readFileSync(join(PKG, "fixtures", "clap-scan", "fake.json"), "utf8");
const MIXED_JSON = readFileSync(join(PKG, "fixtures", "clap-scan", "mixed.json"), "utf8");
const ZERO_PATH_BUNDLE = join(PKG, "fixtures", "zero-path.lv2");
const FAKE_ID = "org.omx-clap-host.test";

const scratch = mkdtempSync(join(tmpdir(), "clap-loader-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function touch(relative: string): string {
  const file = join(scratch, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "");
  return file;
}

/** A runner that answers with `stdout` and records what it was asked. */
function answering(stdout: string, status = 0): { run: ClapScanRun; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: (tool, args) => {
      calls.push([tool, ...args]);
      return { status, stdout };
    },
  };
}

describe("parseClapScan — the tool's document, refused when it is not one", () => {
  it("the real fake.clap golden: one file, the four plugins, one parameter each", () => {
    const doc = parseClapScan(FAKE_JSON);
    expect(doc.files).toHaveLength(1);
    const file = doc.files[0]!;
    expect("plugins" in file && file.plugins.map((p) => p.id)).toEqual(
      ["wide", "sidechain", "notes", "passthrough"].map((n) => `${FAKE_ID}.${n}`),
    );
    expect("plugins" in file && file.plugins.every((p) => "params" in p && p.params.length === 1)).toBe(true);
  });

  it("refuses what is not the scanner's document, naming the way it differs", () => {
    expect(() => parseClapScan("not json")).toThrow(ClapScanError);
    expect(() => parseClapScan("{}")).toThrow(/scanner/);
    expect(() => parseClapScan('{"scanner":"other","files":[]}')).toThrow(/scanner/);
    expect(() => parseClapScan('{"scanner":"omx-clap-scan","files":[{"path":"x","plugins":[{"id":"a"}]}]}')).toThrow(/name/);
  });
});

describe("clapScanDescriptors — the interchange rows", () => {
  const rows = clapScanDescriptors(parseClapScan(FAKE_JSON));
  const byId = (id: string) => rows.find((r) => r.uri === `urn:clap:${FAKE_ID}.${id}`)!;

  it("a plugin is `urn:clap:<id>`, format clap, its binary path resolved", () => {
    expect(rows.map((r) => r.uri)).toEqual(["wide", "sidechain", "notes", "passthrough"].map((n) => `urn:clap:${FAKE_ID}.${n}`));
    expect(rows.every((r) => r.format === "clap" && r.binaryPath.endsWith("/fake.clap") && r.binaryPath.startsWith("/"))).toBe(true);
  });

  it("the parameter is a control keyed by its CLAP id, the range and default as declared", () => {
    expect(byId("passthrough").params).toEqual([
      { kind: "control", symbol: "0", name: "latency", min: 0, max: 4096, default: 64, isInteger: true, isToggle: false, isEnumeration: false },
    ]);
  });

  it("ports are channels summed, a note input is the MIDI flag", () => {
    expect([byId("passthrough").audioInputs, byId("passthrough").audioOutputs]).toEqual([2, 2]);
    expect([byId("wide").audioInputs, byId("wide").audioOutputs]).toEqual([4, 4]);
    expect(byId("sidechain").audioInputs).toBe(3);
    expect(byId("passthrough").hasMidiIn).toBe(false);
    expect(byId("notes").hasMidiIn).toBe(true);
  });

  it("the latency read off the unactivated instance is carried; a plugin that reported none has none", () => {
    expect(byId("passthrough").latency).toEqual({ reportedFrames: 64 });
    const noLatency = JSON.parse(FAKE_JSON);
    delete noLatency.files[0].plugins[3].latency;
    const [, , , bare] = clapScanDescriptors(parseClapScan(JSON.stringify(noLatency)));
    expect(bare).toBeDefined();
    expect("latency" in bare!).toBe(false);
  });

  it("makes no qualification claim: no clap measurement, no stability", () => {
    expect(rows.every((r) => !("clap" in r) && !("stability" in r))).toBe(true);
  });

  it("a hidden or read-only parameter is not offered as a control; a bypass one is kept", () => {
    const doc = JSON.parse(FAKE_JSON);
    const p = doc.files[0].plugins[3];
    const param = (id: number, flags: string[]) => ({ id, name: `p${id}`, module: "", min: 0, max: 1, default: 0, flags });
    p.params = [param(1, ["hidden"]), param(2, ["readonly"]), param(3, ["bypass", "stepped"]), param(4, ["stepped", "enum"])];
    const [, , , row] = clapScanDescriptors(parseClapScan(JSON.stringify(doc)));
    expect(row!.params.map((x) => [x.symbol, x.isToggle, x.isEnumeration])).toEqual([["3", true, false], ["4", true, true]]);
  });

  it("an open bound (null) is left off the param, never turned into a number", () => {
    const doc = JSON.parse(FAKE_JSON);
    doc.files[0].plugins[3].params[0].max = null;
    const [, , , row] = clapScanDescriptors(parseClapScan(JSON.stringify(doc)));
    expect("max" in row!.params[0]!).toBe(false);
    expect(row!.params[0]!.min).toBe(0);
  });
});

describe("clapLoader — the seam", () => {
  it("a .clap path runs the tool with --json and the path, and returns each plugin as a target", () => {
    const file = touch("one/fake.clap");
    const { run, calls } = answering(FAKE_JSON);
    const targets = clapLoader({ run, env: {} }).resolve(file);
    expect(calls).toEqual([[CLAP_SCAN_TOOL_DEFAULT, "--json", file]]);
    expect(targets?.map((t) => t.uri)).toEqual(["wide", "sidechain", "notes", "passthrough"].map((n) => `urn:clap:${FAKE_ID}.${n}`));
    expect(targets?.[0]).toMatchObject({ format: "clap", binary: "fake.clap" });
    expect(targets?.[0]?.binaryPath?.endsWith("/fake.clap")).toBe(true);
  });

  it("a directory holding a .clap, however deep, is scanned; one holding none is not this loader's", () => {
    const withClap = join(scratch, "tree");
    touch("tree/sub/deep/x.clap");
    const { run, calls } = answering(FAKE_JSON);
    expect(clapLoader({ run, env: {} }).resolve(withClap)).toHaveLength(4);
    expect(calls).toEqual([[CLAP_SCAN_TOOL_DEFAULT, "--json", withClap]]);
    touch("empty/readme.txt");
    const none = answering(FAKE_JSON);
    expect(clapLoader({ run: none.run, env: {} }).resolve(join(scratch, "empty"))).toBeUndefined();
    expect(none.calls).toEqual([]);
  });

  it("`urn:clap:<id>` is one plugin without a scan, like an LV2 URI", () => {
    const { run, calls } = answering("unused");
    expect(clapLoader({ run, env: {} }).resolve("urn:clap:com.example.thing")).toEqual([
      { format: "clap", uri: "urn:clap:com.example.thing" },
    ]);
    expect(calls).toEqual([]);
  });

  it("what is not CLAP's is left alone and the tool is never run: an LV2 URI and bundle, a missing .clap", () => {
    const { run, calls } = answering("unused");
    const loader = clapLoader({ run, env: {} });
    expect(loader.resolve("urn:openmixer:eval:zero-path")).toBeUndefined();
    expect(loader.resolve(ZERO_PATH_BUNDLE)).toBeUndefined();
    expect(loader.resolve(join(scratch, "no-such.clap"))).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("a file or plugin the scanner reported an error for is left out; the rest are the targets", () => {
    const file = touch("mixed/fake.clap");
    const targets = clapLoader({ run: answering(MIXED_JSON).run, env: {} }).resolve(join(scratch, "mixed"));
    expect(targets).toHaveLength(4);
    expect(targets?.every((t) => t.binary === "fake.clap")).toBe(true);
    expect(file).toBeTruthy();
  });

  it("a target naming only plugins that failed is the empty array, which the CLI refuses by name", () => {
    const file = touch("broken/broken.clap");
    const broken = JSON.stringify({
      scanner: "omx-clap-scan",
      version: "0.1.0",
      files: [{ path: file, error: "can't open: file too short" }],
    });
    const loader = clapLoader({ run: answering(broken).run, env: {} });
    expect(loader.resolve(file)).toEqual([]);
    const r = resolveTargets([file], [loader, lv2Loader]);
    expect(r).toEqual({ ok: false, refused: [file] });
  });

  it("with clap first, the seam gives a .clap directory to CLAP and a bundle to LV2", () => {
    touch("seam/y.clap");
    const loaders = [clapLoader({ run: answering(FAKE_JSON).run, env: {} }), lv2Loader];
    const clap = resolveTargets([join(scratch, "seam")], loaders);
    expect(clap.ok && clap.plugins.map((p) => p.format)).toEqual(["clap", "clap", "clap", "clap"]);
    const lv2 = resolveTargets([ZERO_PATH_BUNDLE], loaders);
    expect(lv2.ok && lv2.plugins.map((p) => p.format)).toEqual(["lv2"]);
  });
});

describe("the tool is refused loudly, never read as an empty result", () => {
  const file = () => touch("refuse/z.clap");

  it("absent: the error names the setting", () => {
    const run: ClapScanRun = () => ({ status: null, stdout: "", error: Object.assign(new Error("spawn"), { code: "ENOENT" }) });
    expect(() => clapLoader({ run, env: {} }).resolve(file())).toThrow(new RegExp(CLAP_SCAN_TOOL_ENV));
  });

  it("exit 1 (no path could be read), and a document that is not the scanner's", () => {
    expect(() => clapLoader({ run: answering("{}", 1).run, env: {} }).resolve(file())).toThrow(ClapScanError);
    expect(() => clapLoader({ run: answering("garbage").run, env: {} }).resolve(file())).toThrow(ClapScanError);
  });
});

describe("the one declared setting", () => {
  it("names the binary when set and falls back to the declared default", () => {
    expect(clapScanTool({ [CLAP_SCAN_TOOL_ENV]: "/opt/x/omx-clap-scan" })).toBe("/opt/x/omx-clap-scan");
    expect(clapScanTool({})).toBe(CLAP_SCAN_TOOL_DEFAULT);
    expect(clapScanTool({ [CLAP_SCAN_TOOL_ENV]: "" })).toBe(CLAP_SCAN_TOOL_DEFAULT);
  });

  it("the default runner spawns exactly what the setting names, with --json and the path", () => {
    const stub = join(scratch, "stub-scan.sh");
    const record = join(scratch, "stub-args");
    writeFileSync(stub, `#!/bin/sh\necho "$@" > '${record}'\ncat '${join(PKG, "fixtures", "clap-scan", "fake.json")}'\n`);
    chmodSync(stub, 0o755);
    const file = touch("stub/s.clap");
    const targets = clapLoader({ env: { [CLAP_SCAN_TOOL_ENV]: stub } }).resolve(file);
    expect(targets).toHaveLength(4);
    expect(readFileSync(record, "utf8").trim()).toBe(`--json ${file}`);
  });

  it("the timeout is the declared one", () => {
    expect(CLAP_SCAN_TIMEOUT_S).toBeGreaterThan(0);
    const seen: number[] = [];
    const run: ClapScanRun = (_tool, _args, timeoutMs) => {
      seen.push(timeoutMs);
      return { status: 0, stdout: FAKE_JSON };
    };
    clapLoader({ run, env: {} }).resolve(touch("t/t.clap"));
    expect(seen).toEqual([CLAP_SCAN_TIMEOUT_S * 1000]);
  });
});

describe("the real tool", () => {
  /** The built scanner, when the setting (or PATH) resolves one — else absent, and the test skips saying so. */
  function builtTool(): string | undefined {
    const tool = clapScanTool(process.env);
    const probe = spawnSync(tool, ["--help"], { encoding: "utf8" });
    return probe.error === undefined && probe.status === 0 ? tool : undefined;
  }

  it("scans a .clap and says what the golden says — a stale golden fails here", (ctx) => {
    const tool = builtTool();
    if (tool === undefined) {
      ctx.skip(`omx-clap-scan not found: set ${CLAP_SCAN_TOOL_ENV} to the binary built by omx-clap-host (make omx-clap-scan)`);
      return;
    }
    const fake = process.env["OMX_CLAP_FAKE"];
    if (fake === undefined) {
      ctx.skip("OMX_CLAP_FAKE not set: name omx-clap-host's built tests/fake.clap to run the live scan");
      return;
    }
    const live = clapLoader({ env: process.env }).resolve(fake);
    expect(live?.map((t) => t.uri)).toEqual(clapLoader({ run: answering(FAKE_JSON).run, env: {} }).resolve(touch("live/f.clap"))?.map((t) => t.uri));
    const run = spawnSync(tool, ["--json", fake], { encoding: "utf8" });
    const [liveRows, goldenRows] = [clapScanDescriptors(parseClapScan(run.stdout)), clapScanDescriptors(parseClapScan(FAKE_JSON))];
    expect(liveRows.map(({ binaryPath: _b, ...row }) => row)).toEqual(goldenRows.map(({ binaryPath: _b, ...row }) => row));
    expect(liveRows.length).toBe(4);
  });
});
