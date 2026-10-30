/**
 * A pin written before plugin-qualify 0.17.3 holds an LV2's binary, plugin TTL and manifest, not the preset files its
 * manifest names; plugin-hostd 0.15.0 checks those too, and answers -509 until the plugin is qualified again
 * (plugin-qualify#239). refreshPins brings every pin's files up to the ones plugin-hostd names, measuring nothing and
 * keeping the verdict when no file both lists hold changed. Arms: the refresh itself with a stand-in --pin-files; the
 * --refresh-pins run writing the pin file; and the real plugin-hostd refusing the old pin (-509) and adding the
 * refreshed one, which needs PLUGIN_HOSTD and PLUGIN_HOSTD_FAKE_HOST and skips visibly without them off CI.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { startDaemon } from "./hostd-daemon.support.js";
import { hostdPinFiles, type PinFilesRun } from "./hostd-pin-files.js";
import { pinsFile, parsePinLine, type PinEntry } from "./pins-file.js";
import {
  SYNC_STATE_SCHEMA,
  parseSyncArgs,
  refreshPins,
  resolveSyncSettings,
  runSync,
  type SyncContext,
  type SyncState,
} from "./qualify-sync.js";

const HOSTD = process.env["PLUGIN_HOSTD"];
const FAKE_HOST = process.env["PLUGIN_HOSTD_FAKE_HOST"];
const URI = "urn:plugin-qualify:test:refresh";
const scratch = mkdtempSync(join(tmpdir(), "pin-refresh-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/** An LV2 bundle whose manifest names a preset file beside the plugin's own TTL, as mda Piano's does. */
function bundle(name: string): string {
  const dir = join(scratch, "lv2", `${name}.lv2`);
  mkdirSync(dir, { recursive: true });
  const prefixes = "@prefix lv2: <http://lv2plug.in/ns/lv2core#> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n" +
    "@prefix pset: <http://lv2plug.in/ns/ext/presets#> .\n";
  // the plugin's rdfs:seeAlso names its presets' file too: plugin-hostd 0.15.0 pins what the plugin's subject names
  writeFileSync(join(dir, "manifest.ttl"), `${prefixes}<${URI}> a lv2:Plugin ; lv2:binary <refresh.so> ; rdfs:seeAlso <refresh.ttl> , <presets.ttl> .\n`);
  writeFileSync(join(dir, "refresh.so"), "the plugin's code\n");
  writeFileSync(join(dir, "refresh.ttl"), `${prefixes}<${URI}> a lv2:Plugin ; lv2:binary <refresh.so> .\n`);
  writeFileSync(join(dir, "presets.ttl"), `${prefixes}<${URI}#bright> a pset:Preset ; lv2:appliesTo <${URI}> .\n`);
  return dir;
}

/** What plugin-hostd --pin-files prints for the bundle: its root and the four files. */
const standIn = (dir: string): PinFilesRun => () => ({
  status: 0,
  stdout: `root ${dir}\n${["manifest.ttl", "presets.ttl", "refresh.so", "refresh.ttl"].map((f) => `file ${f}`).join("\n")}\n`,
  stderr: "",
});

/** The pin plugin-qualify 0.17.2 wrote: the probe's three files, with a verdict. */
function oldPin(dir: string, layout = { scheme: "omx-layout/1", sha256: "0".repeat(64) }): PinEntry {
  const files = ["manifest.ttl", "refresh.so", "refresh.ttl"].map((path) => ({ path, sha256: sha256(join(dir, path)) }));
  return { uri: URI, integrity: { files, layout }, verdict: "in-process" } as unknown as PinEntry;
}

function stateOf(dir: string, pin: PinEntry): SyncState {
  return {
    schema: SYNC_STATE_SCHEMA,
    entries: {
      [`lv2:${dir}`]: {
        format: "lv2",
        root: dir,
        files: pin.integrity.files ?? [],
        plugins: [{ uri: URI, outcome: "qualified", pin, record: "" }],
        qualifiedAt: "2026-10-29T00:00:00.000Z",
        seconds: 1,
      },
    },
  } as unknown as SyncState;
}

function ctxOf(dir: string, logs: string[]): SyncContext {
  return { settings: settingsFor(join(scratch, "lv2")), env: {}, log: (l) => logs.push(l), pinFilesRun: standIn(dir) };
}

function settingsFor(lv2: string) {
  const args = parseSyncArgs([]);
  if (!args.ok) throw new Error(args.error);
  const r = resolveSyncSettings(new Map([["lv2_path", lv2], ["lv2_extra", ""]]), args.args, {}, scratch);
  if (!r.ok) throw new Error(r.error);
  return r.settings;
}

const pinOf = (state: SyncState): PinEntry => Object.values(state.entries)[0]!.plugins[0]!.pin!;

describe("refreshPins: a pin from before 0.17.3, brought up to plugin-hostd's files", () => {
  it("takes the preset file the manifest names, keeps the verdict, and says so", () => {
    const dir = bundle("refresh-a");
    const logs: string[] = [];
    const before = stateOf(dir, oldPin(dir));
    const { state, refreshed } = refreshPins(ctxOf(dir, logs), before);
    expect(refreshed).toEqual([URI]);
    expect(pinOf(state).integrity.files!.map((f) => f.path)).toEqual(["manifest.ttl", "presets.ttl", "refresh.so", "refresh.ttl"]);
    expect(pinOf(state).integrity.files!.find((f) => f.path === "presets.ttl")!.sha256).toBe(sha256(join(dir, "presets.ttl")));
    expect(pinOf(state).verdict).toBe(pinOf(before).verdict);
    expect(logs).toEqual([`${URI}: pin files refreshed, presets.ttl added`]);
  });

  it("leaves a pin alone when a file both lists hold changed: those are other bytes, the sync's to measure", () => {
    const dir = bundle("refresh-b");
    const pin = oldPin(dir);
    writeFileSync(join(dir, "refresh.so"), "another build of the plugin\n");
    const logs: string[] = [];
    const before = stateOf(dir, pin);
    const { state, refreshed } = refreshPins(ctxOf(dir, logs), before);
    expect(refreshed).toEqual([]);
    expect(state).toBe(before);
    expect(logs).toEqual([`${URI}: refresh.so changed since it was qualified; its pin waits for the sync`]);
  });

  it("changes nothing when the pin already holds plugin-hostd's files", () => {
    const dir = bundle("refresh-c");
    const first = refreshPins(ctxOf(dir, []), stateOf(dir, oldPin(dir))).state;
    const again = refreshPins(ctxOf(dir, []), first);
    expect(again.refreshed).toEqual([]);
    expect(again.state).toBe(first);
  });
});

describe("plugin-qualify-sync --refresh-pins", () => {
  it("writes the refreshed pins into the pin file and the state, and measures nothing", async () => {
    const dir = bundle("refresh-d");
    const ctx = ctxOf(dir, []);
    const settings = { ...ctx.settings, stateFile: join(scratch, "d.json"), pinFile: join(scratch, "d.pins"), hostdPort: 0 };
    writeFileSync(settings.stateFile, `${JSON.stringify(stateOf(dir, oldPin(dir)))}\n`);
    writeFileSync(settings.pinFile, pinsFile([oldPin(dir)]).text);
    const logs: string[] = [];
    const summary = await runSync(settings, { refreshOnly: true, pinFilesRun: standIn(dir), log: (l) => logs.push(l) });
    expect(summary).toMatchObject({ qualified: 0, skipped: 0, refreshed: 1 });
    const line = readFileSync(settings.pinFile, "utf8").split("\n").find((l) => l.includes(URI))!;
    expect(parsePinLine(line)!.files.map((f) => f.path)).toContain("presets.ttl");
    expect(JSON.stringify(JSON.parse(readFileSync(settings.stateFile, "utf8")))).toContain("presets.ttl");
    expect(logs).not.toContain("sync run begins");
  });
});

describe("plugin-hostd on a pin from before 0.17.3, and on the same pin refreshed", () => {
  it("refuses the old pin with -509 and adds the refreshed one", async (ctx) => {
    if (HOSTD === undefined || FAKE_HOST === undefined) {
      if (process.env["CI"]) throw new Error("PLUGIN_HOSTD and PLUGIN_HOSTD_FAKE_HOST are needed: CI installs plugin-hostd and plugin-hostd-tests");
      ctx.skip("needs plugin-hostd 0.15.0 and its fake worker: PLUGIN_HOSTD, PLUGIN_HOSTD_FAKE_HOST (plugin-hostd-tests)");
    }
    const dir = bundle("refresh-e");
    const lv2 = join(scratch, "lv2");
    // the fake worker's layout, which it checks a pin against
    const fake = spawnSync(FAKE_HOST!, ["-L"], { encoding: "utf8" }).stdout.trim();
    const layout = { scheme: fake.slice(0, fake.lastIndexOf(":")), sha256: fake.slice(fake.lastIndexOf(":") + 1) };
    // the real --pin-files, as the sync runs it
    const named = hostdPinFiles(URI, [lv2], { ...process.env, PLUGIN_HOSTD: HOSTD });
    expect(named.ok && named.files.map((f) => f.path)).toContain("presets.ttl");
    const refreshed = refreshPins({ settings: settingsFor(lv2), env: { PLUGIN_HOSTD: HOSTD }, log: () => {} }, stateOf(dir, oldPin(dir, layout))).state;
    const oldFile = join(scratch, "e.old.pins");
    const newFile = join(scratch, "e.new.pins");
    writeFileSync(oldFile, pinsFile([oldPin(dir, layout)]).text);
    writeFileSync(newFile, pinsFile([pinOf(refreshed)]).text);
    const base = { mod_host: FAKE_HOST!, clap_host: FAKE_HOST!, state_root: scratch, lv2_path: lv2, require_pins: 1, pin_mode: "strict", pin_store: join(scratch, "no-store") };
    const withOld = await startDaemon(HOSTD!, scratch, { ...base, pin_file: oldFile });
    try {
      expect(await withOld.control.send(`add ${URI} 0`)).toBe("resp -509");
    } finally {
      withOld.close();
    }
    const withNew = await startDaemon(HOSTD!, scratch, { ...base, pin_file: newFile });
    try {
      expect(await withNew.control.send(`add ${URI} 0`)).toBe("resp 0");
    } finally {
      withNew.close();
    }
  });
});
