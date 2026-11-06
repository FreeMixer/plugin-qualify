// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { OMX_CLAP_HOST_PROFILE, OPENMIXER_CONSOLE_PROFILE } from "./host-profiles.js";
import { judgeProbeOutput } from "./probe-judge.js";
import { readProbeOutput } from "./probe-output.js";
import { fixtureText } from "./probe-output-fixtures.js";
import { QUALIFICATION_RECORD_SCHEMA, mergeRunsByRecord, probeCopyFileName, qualificationBaseName, recordFileName, tiersOf, writeQualification } from "./qualification-record.js";

const scratch = mkdtempSync(join(tmpdir(), "qualification-record-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const sha = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

function judge(text: string) {
  const r = readProbeOutput(text);
  if (!r.ok) throw new Error(r.problem);
  return judgeProbeOutput(r.output, [OMX_CLAP_HOST_PROFILE, OPENMIXER_CONSOLE_PROFILE]);
}

describe("the qualification record and the probe output it judged", () => {
  it("names the copy it wrote and the SHA-256 of that copy's bytes", () => {
    const dir = join(scratch, "a");
    const text = fixtureText("success-msi");
    const w = writeQualification(dir, Buffer.from(text), judge(text));
    expect(readdirSync(dir).sort()).toEqual([
      "org.example.plate@1.4.2-356902794a4e.omx-clap-host.probe.json",
      "org.example.plate@1.4.2-356902794a4e.omx-clap-host.qualification.json",
    ]);
    const onDisk = readFileSync(w.probePath);
    expect(onDisk.toString("utf8")).toBe(text);
    expect(w.record.probe.file).toBe("org.example.plate@1.4.2-356902794a4e.omx-clap-host.probe.json");
    expect(w.record.probe.sha256).toBe(sha(onDisk));
    expect(w.record.probe.sha256).toBe(sha(text));
    expect(w.record.probe.bytes).toBe(Buffer.byteLength(text));
    const read = JSON.parse(readFileSync(w.recordPath, "utf8"));
    expect(read).toEqual(JSON.parse(JSON.stringify(w.record)));
  });

  it("holds the verdict per host, the cost beside it and the figures as measured", () => {
    const dir = join(scratch, "c");
    const text = fixtureText("success-msi");
    const { record } = writeQualification(dir, Buffer.from(text), judge(text));
    expect(record.schema).toBe(QUALIFICATION_RECORD_SCHEMA);
    expect(record.plugin).toEqual({ format: "clap", id: "org.example.plate", name: "Plate" });
    expect(record.testedVersion).toBe("1.4.2");
    expect(record.verdicts.map((v) => [v.host, v.rating, v.qualified, v.hosting, v.deciding])).toEqual([
      ["omx-clap-host", "suitable", true, "isolated", undefined],
      ["openmixer-console", "unknown", false, "isolated", "hosting.clap.extensions-not-covered"],
    ]);
    expect(record.cost.map((c) => [c.host, c.rate, c.quantum, c.reasons.map((r) => r.code)])).toEqual([
      ["omx-clap-host", 48000, 128, ["hosting.cost.within-ceiling"]],
      ["openmixer-console", 96000, 1024, ["hosting.cost.unmeasured-at-rate-and-quantum"]],
    ]);
    expect(record.measurements.grid.map((p) => [p.rate, p.quantum, p.cost?.median])).toEqual([
      [48000, 128, 41.2],
      [96000, 128, 40.7],
    ]);
    expect(record.measuredAt).toBe("2026-10-17T22:15:00+02:00");
    expect(record.tool["runner"]).toBe("plugin-hostd-probe 0.1.0");
    expect(record.probe).toMatchObject({
      protocol: { name: "plugin-hostd.probe-protocol", version: 1 },
      reason: "reference",
      outcome: "probe.ok",
      complete: true,
      meetsProtocol: true,
    });
    expect(record.probe.machineClass).toMatchObject({ arch: "x86_64", cstatesLimited: true });
    expect(record.binary.sha256).toBe("356902794a4eec2122989e072271ef995968131145db918d9a3084ce582f244b");
  });

  it("keeps a run that crashed: unknown, the outcome as the reason, and the copy that shows why", () => {
    const dir = join(scratch, "d");
    const text = fixtureText("plugin-crash");
    const w = writeQualification(dir, Buffer.from(text), judge(text));
    expect(w.record.verdicts[0]).toMatchObject({ measured: false, rating: "unknown", qualified: false, deciding: "probe.crashed" });
    expect(w.record.verdicts[0]?.reasons).toEqual([{ dimension: "rtSafety", rating: "unknown", code: "probe.crashed", params: {} }]);
    expect(w.record.probe).toMatchObject({ outcome: "probe.crashed", complete: false, meetsProtocol: false });
    expect(readFileSync(w.probePath, "utf8")).toBe(text);
  });

  it("says how the child that crashed ended, and how loaded the machine was, so the crash is attributable", () => {
    const dir = join(scratch, "d2");
    const doc = JSON.parse(fixtureText("plugin-crash"));
    doc.steps = [...doc.steps, { step: "lifecycle", outcome: "probe.crashed", elapsedMs: 3, signal: "SIGSEGV" },
      { step: "lifecycle", outcome: "probe.ok", elapsedMs: 3, exitStatus: 0 }];
    const text = JSON.stringify(doc);
    const w = writeQualification(dir, Buffer.from(text), { ...judge(text), load: { loadavg1: 3.5, cores: 4 } });
    expect(w.record.probe.ends).toContainEqual({ step: "lifecycle", outcome: "probe.crashed", signal: "SIGSEGV" });
    expect(w.record.probe.ends?.some((e) => e.exitStatus === 0)).toBe(false);
    expect(w.record.probe.load).toEqual({ loadavg1: 3.5, cores: 4 });
    // a run where every child ended well names no end
    const ok = fixtureText("success-msi");
    expect(writeQualification(join(scratch, "d3"), Buffer.from(ok), judge(ok)).record.probe.ends).toBeUndefined();
  });

  it("replaces the pair on a rescan of the same binary and offer, leaving no half-written file", () => {
    const dir = join(scratch, "e");
    const text = fixtureText("success-msi");
    writeQualification(dir, Buffer.from(text), judge(text));
    const second = JSON.parse(text);
    second.run.id = "msi-again";
    const again = JSON.stringify(second);
    const w = writeQualification(dir, Buffer.from(again), judge(again));
    expect(readFileSync(w.probePath, "utf8")).toBe(again);
    expect(w.record.probe.sha256).toBe(sha(again));
    expect(readdirSync(dir)).toHaveLength(2);
    expect(existsSync(`${w.recordPath}.new`)).toBe(false);
  });

  it("writes a non-ASCII id one '_' per UTF-8 byte, as plugin-hostd reads it (plugin-hostd-protocol's descriptor name)", () => {
    const text = fixtureText("success-msi");
    const r = readProbeOutput(text);
    if (!r.ok) throw new Error(r.problem);
    const named = { ...r.output, plugin: { ...r.output.plugin, id: "org.example.caf\u00e9-\u{1F3B9}" } };
    // é is two bytes in UTF-8 and 🎹 four: plugin-hostd's descriptors.c replaces each byte
    expect(qualificationBaseName(named)).toBe("org.example.caf__-____@1.4.2-356902794a4e.omx-clap-host");
  });

  it("names files by id, version, binary hash and offer, with nothing a path could use", () => {
    const text = fixtureText("success-msi");
    const r = readProbeOutput(text);
    if (!r.ok) throw new Error(r.problem);
    expect(qualificationBaseName(r.output)).toBe("org.example.plate@1.4.2-356902794a4e.omx-clap-host");
    const lv2 = JSON.parse(fixtureText("plugin-crash"));
    const o = readProbeOutput(JSON.stringify(lv2));
    if (!o.ok) throw new Error(o.problem);
    expect(recordFileName(o.output)).toBe(`urn_example_zero-path@0.0-${o.output.binary.sha256.slice(0, 12)}.omx-console-lv2.qualification.json`);
    expect(probeCopyFileName(o.output)).toMatch(/^urn_example_zero-path@0\.0-[0-9a-f]{12}\.omx-console-lv2\.probe\.json$/);
    delete lv2.plugin.version;
    const bare = readProbeOutput(JSON.stringify(lv2));
    if (!bare.ok) throw new Error(bare.problem);
    expect(qualificationBaseName(bare.output)).toContain("@unversioned-");
    lv2.plugin.id = "../../etc/x";
    const evil = readProbeOutput(JSON.stringify(lv2));
    if (!evil.ok) throw new Error(evil.problem);
    expect(qualificationBaseName(evil.output)).not.toContain("/");
  });
});

describe("runs that share a record file", () => {
  it("become one record holding every verdict, over the first run's probe output", () => {
    const text = fixtureText("success-msi");
    const r = readProbeOutput(text);
    if (!r.ok) throw new Error(r.problem);
    const a = { bytes: Buffer.from(text), judgment: judgeProbeOutput(r.output, [OPENMIXER_CONSOLE_PROFILE]) };
    const b = { bytes: Buffer.from(`${text} `), judgment: judgeProbeOutput(r.output, [OMX_CLAP_HOST_PROFILE]) };
    const merged = mergeRunsByRecord([a, b]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.bytes).toBe(a.bytes);
    expect(merged[0]!.judgment.hosts.map((h) => h.verdict.host)).toEqual(["openmixer-console", "omx-clap-host"]);
    const tiers = tiersOf(merged[0]!.judgment);
    expect([tiers.inProcess?.host, tiers.isolated?.host]).toEqual(["openmixer-console", "omx-clap-host"]);
  });
});
