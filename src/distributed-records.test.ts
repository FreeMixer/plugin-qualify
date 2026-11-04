// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The distributed layer: a record another device of the machine class wrote applies only when every file it names
 * hashes as measured here. The sync runs whole over a CLAP directory of plain bytes; a record that applies means the
 * sweep never runs, so no prober is needed. A record that does not apply sends the plugin to the sweep, which finds no
 * plugin in the bytes: the test reads only that it was not taken from the layer.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { DISTRIBUTED_DIR_SYSTEM, hostClassOfBoard } from "./distributed-records.js";
import { FIXTURE_CLAP_ID, fixtureProvenance, writeFakeClap, writeFixtureSet } from "./distributed-records.support.js";
import { parsePinLine } from "./pins-file.js";
import { parseSyncArgs, resolveSyncSettings, runSync, summaryLine, type SyncSettings } from "./qualify-sync.js";

const scratch = mkdtempSync(join(tmpdir(), "distributed-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const CLASS = "test-class";
const SET = "test-set";

/** A machine: a CLAP directory with one `.clap`, an empty LV2 one, the state under `state/`, the layer under `share/`. */
function machine(name: string, flags: readonly string[] = []): { root: string; clap: string; settings: SyncSettings; share: string } {
  const root = join(scratch, name);
  const clap = join(root, "clap", "plate.clap");
  writeFakeClap(clap);
  mkdirSync(join(root, "lv2"), { recursive: true });
  const share = join(root, "share");
  const args = parseSyncArgs([
    "--clap-path", join(root, "clap"),
    "--lv2-path", join(root, "lv2"),
    "--lv2-extra", "",
    "--qualification-dir", join(root, "state", "qualification"),
    "--descriptor-dir", join(root, "state", "descriptors"),
    "--state-file", join(root, "state", "sync.json"),
    "--pin-file", join(root, "state", "qualified.pins"),
    "--hostd-port", "0",
    "--budget-s", "5",
    "--host-class", CLASS,
    "--distributed-dir", share,
    ...flags,
  ]);
  if (!args.ok) throw new Error(args.error);
  const r = resolveSyncSettings(new Map(), args.args, {}, root);
  if (!r.ok) throw new Error(r.error);
  return { root, clap, settings: r.settings, share };
}

async function sync(settings: SyncSettings, force = false, flags: readonly string[] = []) {
  const lines: string[] = [];
  const run = flags.includes("--no-distributed") ? { ...settings, distributed: false } : settings;
  const summary = await runSync(run, { force, env: {}, log: (l) => lines.push(l) });
  if (summary === undefined) throw new Error("the run held no lock");
  return { summary, lines };
}

/** The measurements of a record as a probe from before the latency pass left them: no point holds a latency, none is named unmeasured. */
const stripLatency = (m: Record<string, unknown>): Record<string, unknown> => {
  const { unmeasured, ...rest } = m as { unmeasured?: { dimension: string }[] };
  const kept = (unmeasured ?? []).filter((u) => u.dimension !== "latency");
  return {
    ...rest,
    grid: (m["grid"] as Record<string, unknown>[]).map(({ latency: _latency, ...p }) => p),
    ...(kept.length === 0 ? {} : { unmeasured: kept }),
  };
};

const measured = (s: { qualified: number; refused: number; crashed: number; hung: number; unmeasured: number }): number =>
  s.qualified + s.refused + s.crashed + s.hung + s.unmeasured;

describe("the host class", () => {
  it("is the board's name from the device tree, for the boards it names; none for any other", () => {
    expect(hostClassOfBoard("Raspberry Pi 5 Model B Rev 1.0\0")).toBe("rpi5");
    expect(hostClassOfBoard("Raspberry Pi 4 Model B Rev 1.4")).toBe("rpi4");
    expect(hostClassOfBoard("Raspberry Pi Compute Module 5 Rev 1.0")).toBe("rpi5");
    expect(hostClassOfBoard("Raspberry Pi 400 Rev 1.0")).toBeUndefined();
    expect(hostClassOfBoard("")).toBeUndefined();
    expect(hostClassOfBoard(undefined)).toBeUndefined();
  });

  it("is the setting when one is given, the board's otherwise, and the layer's directories are the system's or the XDG ones", () => {
    const sys = parseSyncArgs(["--system"]);
    const user = parseSyncArgs(["--host-class", "x86-desk"]);
    if (!sys.ok || !user.ok) throw new Error("args");
    const s = resolveSyncSettings(new Map(), sys.args, {}, "/home/u", () => "Raspberry Pi 5 Model B Rev 1.0");
    const u = resolveSyncSettings(new Map(), user.args, { XDG_DATA_HOME: "/d", XDG_DATA_DIRS: "/a:/b" }, "/home/u", () => "Raspberry Pi 5 Model B Rev 1.0");
    if (!s.ok || !u.ok) throw new Error("settings");
    expect([s.settings.hostClass, s.settings.distributedDirs, s.settings.distributed]).toEqual(["rpi5", [DISTRIBUTED_DIR_SYSTEM], true]);
    expect([u.settings.hostClass, u.settings.distributedDirs]).toEqual(["x86-desk", ["/d/omx/qualification", "/a/omx/qualification", "/b/omx/qualification"]]);
    const plain = parseSyncArgs([]);
    if (!plain.ok) throw new Error("args");
    const p = resolveSyncSettings(new Map(), plain.args, {}, "/home/u", () => undefined);
    if (!p.ok) throw new Error("settings");
    expect([p.settings.hostClass, p.settings.distributedDirs]).toEqual([undefined, ["/home/u/.local/share/omx/qualification", "/usr/local/share/omx/qualification", "/usr/share/omx/qualification"]]);
    const off = parseSyncArgs(["--no-distributed"]);
    expect(off.ok && off.args.noDistributed).toBe(true);
  });
});

describe("a distributed record", () => {
  const editRecord = (m: { share: string }, change: (r: Record<string, unknown>) => Record<string, unknown>): void => {
    const dir = join(m.share, CLASS, SET);
    const name = readdirSync(dir).find((f) => f.endsWith(".qualification.json"))!;
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(change(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)));
  };

  it("with a run that lacks a step its outcome calls for is refused, and the plugin is measured here", async () => {
    const m = machine("run-lacks-step");
    writeFixtureSet(m.share, CLASS, SET, m.clap);
    editRecord(m, (r) => ({ ...r, run: { id: "r", steps: [{ step: "scan", result: "ok" }, { step: "probe", result: "probe.ok" }] } }));
    const { summary, lines } = await sync(m.settings);
    expect(lines.some((l) => /its record lacks the steps describe, rt-safety; measured here/.test(l)), lines.join("\n")).toBe(true);
    expect(summary.distributed).toBe(0);
  });

  it("refused by an older judge for RT-safety alone is judged again: it is taken, isolated, never refused", async () => {
    const m = machine("older-judge-rt");
    // the probe counted syscalls in the run; plugin-qualify 0.16.1 rated that unsuitable, today's judge conditional (#196)
    writeFixtureSet(m.share, CLASS, SET, m.clap, (doc) => {
      for (const p of doc["grid"]) if (p["rtSafety"] !== undefined) p["rtSafety"]["syscalls"] = 7;
    });
    editRecord(m, (r) => ({
      ...r,
      verdicts: (r["verdicts"] as Record<string, unknown>[]).map((v) =>
        v["host"] === "omx-clap-host" ? { ...v, rating: "unsuitable", qualified: false, deciding: "hosting.rt-safety.violations-in-run" } : v,
      ),
    }));
    const { summary, lines } = await sync(m.settings);
    expect(summary.distributed, lines.join("\n")).toBe(1);
    expect(summary.refused).toBe(0);
    const pins = readFileSync(m.settings.pinFile, "utf8").split("\n").filter((l) => l.startsWith("pin_set"));
    expect(pins.map((l) => parsePinLine(l)!.verdict)).toEqual(["isolated"]);
    const copied = readdirSync(m.settings.qualificationDir).find((f) => f.endsWith(".qualification.json"))!;
    const record = JSON.parse(readFileSync(join(m.settings.qualificationDir, copied), "utf8"));
    expect(record.verdicts.find((v: { host: string }) => v.host === "omx-clap-host")).toMatchObject({ rating: "conditional", deciding: "hosting.rt-safety.violations-in-run" });
    expect(record.rejudged?.figures?.measuredAt).toBe(record.measuredAt);
  });

  it("that never took the latency figure (a probe from before that pass) is not taken: the plugin is measured here", async () => {
    const m = machine("no-latency");
    writeFixtureSet(m.share, CLASS, SET, m.clap);
    editRecord(m, (r) => ({ ...r, measurements: stripLatency(r["measurements"] as Record<string, unknown>) }));
    const { summary, lines } = await sync(m.settings);
    expect(lines.some((l) => /its record never took the latency figure \(a probe from before that pass\); measured here/.test(l)), lines.join("\n")).toBe(true);
    expect(summary.distributed).toBe(0);
  });

  it("recorded here from a probe that never took the latency figure is measured again, its bytes unchanged", async () => {
    const m = machine("owed-here");
    writeFixtureSet(m.share, CLASS, SET, m.clap);
    expect((await sync(m.settings)).summary.distributed).toBe(1);
    const again = await sync(m.settings);
    expect(again.summary.skipped).toBe(1);
    const name = readdirSync(m.settings.qualificationDir).find((f) => f.endsWith(".qualification.json"))!;
    const path = join(m.settings.qualificationDir, name);
    const r = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...r, measurements: stripLatency(r["measurements"] as Record<string, unknown>) }));
    const owed = await sync(m.settings, false, ["--no-distributed"]);
    expect(owed.lines.some((l) => /never took the latency figure \(a probe from before that pass\); measured again/.test(l)), owed.lines.join("\n")).toBe(true);
    expect(owed.summary.skipped).toBe(0);
  });

  it("with no run is from before the steps: it is taken, and keeps its word", async () => {
    const m = machine("no-run");
    writeFixtureSet(m.share, CLASS, SET, m.clap);
    editRecord(m, ({ run: _run, ...r }) => r);
    const { summary } = await sync(m.settings);
    expect(summary.distributed).toBe(1);
  });

  it("applies on a matching SHA-256: the plugin is not measured, its record is the device's own with the provenance kept, its pin is written", async () => {
    const m = machine("applies");
    writeFixtureSet(m.share, CLASS, SET, m.clap);
    const { summary, lines } = await sync(m.settings);
    const uri = `clap:${m.clap}#${FIXTURE_CLAP_ID}`;
    expect(lines).toContain(`distributed: ${uri}: applied (${SET})`);
    expect(summary.distributed).toBe(1);
    expect(measured(summary)).toBe(0);
    expect(summaryLine(summary)).toMatch(/, distributed 1, /);

    const copied = readdirSync(m.settings.qualificationDir).sort();
    expect(copied.map((f) => f.replace(/^.*\.(qualification|probe)\.json$/, "$1"))).toEqual(["probe", "qualification"]);
    const record = JSON.parse(readFileSync(join(m.settings.qualificationDir, copied.find((f) => f.endsWith(".qualification.json"))!), "utf8"));
    expect(record.provenance).toEqual(fixtureProvenance(CLASS, SET));
    expect(record.binary.files).toEqual([{ path: "plate.clap", sha256: record.binary.sha256 }]);

    const pins = readFileSync(m.settings.pinFile, "utf8").split("\n").filter((l) => l.startsWith("pin_set"));
    expect(pins).toHaveLength(1);
    const pin = parsePinLine(pins[0]!)!;
    expect(pin.uri).toBe(uri);
    expect(pin.files).toEqual([{ path: "plate.clap", sha256: record.binary.sha256 }]);
    expect(pin.verdict).toBeDefined();

    // the next run finds the plugin recorded from these bytes, as if it had measured it
    const again = await sync(m.settings);
    expect([again.summary.skipped, again.summary.distributed, measured(again.summary)]).toEqual([1, 0, 0]);
  });

  it("is ignored when a byte of the binary differs: the plugin is measured as today", async () => {
    const m = machine("differs");
    writeFixtureSet(m.share, CLASS, SET, m.clap);
    appendFileSync(m.clap, "one byte more");
    const { summary, lines } = await sync(m.settings);
    expect(lines).toContain(`distributed: clap:${m.clap}#${FIXTURE_CLAP_ID}: binary differs`);
    expect(lines.some((l) => l.includes(": applied ("))).toBe(false);
    expect(summary.distributed).toBe(0);
    expect(measured(summary)).toBeGreaterThan(0);
    expect(readdirSync(m.settings.qualificationDir).some((f) => f.endsWith(".probe.json"))).toBe(false);
  });

  it("applies beside a record of earlier bytes of the same plugin in the set, which is passed over", async () => {
    const m = machine("two-builds");
    const earlier = join(m.root, "earlier", "plate.clap");
    writeFakeClap(earlier, "an earlier build\n");
    const { dir } = writeFixtureSet(m.share, CLASS, SET, earlier);
    // the earlier build's record names the installed path, as a set measured across an upgrade holds it
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".qualification.json"))) {
      writeFileSync(join(dir, f), readFileSync(join(dir, f), "utf8").split(earlier).join(m.clap));
    }
    writeFixtureSet(m.share, CLASS, SET, m.clap);
    expect(readdirSync(dir).filter((n) => n.endsWith(".qualification.json"))).toHaveLength(2);
    const { summary, lines } = await sync(m.settings);
    expect(lines).toContain(`distributed: clap:${m.clap}#${FIXTURE_CLAP_ID}: applied (${SET})`);
    expect(lines.some((l) => l.endsWith(": binary differs"))).toBe(false);
    expect([summary.distributed, measured(summary)]).toEqual([1, 0]);
    expect(readdirSync(m.settings.qualificationDir).filter((n) => n.endsWith(".qualification.json"))).toHaveLength(1);
  });

  it("is ignored when its probe output is not the copy the record names", async () => {
    const m = machine("tampered");
    const { probePath } = writeFixtureSet(m.share, CLASS, SET, m.clap);
    writeFileSync(probePath, readFileSync(probePath, "utf8").replace('"probe.ok"', '"probe.ok" '));
    const { summary, lines } = await sync(m.settings);
    expect(summary.distributed).toBe(0);
    expect(lines.some((l) => l.startsWith(`distributed: clap:${m.clap}#${FIXTURE_CLAP_ID}: `) && l.includes(basename(probePath)))).toBe(true);
  });

  it("is ignored for another host class, under --no-distributed, and under --force", async () => {
    for (const [name, flags, force] of [
      ["other-class", ["--host-class", "another"], false],
      ["off", ["--no-distributed"], false],
      ["forced", [], true],
    ] as const) {
      const m = machine(name, flags);
      writeFixtureSet(m.share, CLASS, SET, m.clap);
      const { summary } = await sync(m.settings, force);
      expect([name, summary.distributed]).toEqual([name, 0]);
      expect([name, measured(summary)]).toEqual([name, 1]);
    }
  });

  it("is not read from a set without its provenance", async () => {
    const m = machine("no-provenance");
    const { dir } = writeFixtureSet(m.share, CLASS, SET, m.clap);
    rmSync(join(dir, "provenance.json"));
    const { summary, lines } = await sync(m.settings);
    expect(summary.distributed).toBe(0);
    expect(lines).toContain(`distributed: ${dir}: no provenance.json, not read`);
  });
});
