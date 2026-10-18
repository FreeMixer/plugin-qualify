// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
import { describe, expect, it } from "vitest";

import { PROBE_FORMAT_CODE, readProbeOutput } from "./probe-output.js";
import { fixtureJson, readFixture } from "./probe-output-fixtures.js";

function refused(doc: unknown): { code: string; problem: string } {
  const r = readProbeOutput(JSON.stringify(doc));
  if (r.ok) throw new Error("the document was read; the reader should have refused it");
  return { code: r.code, problem: r.problem };
}

describe("readProbeOutput: the three documents of plugin-hostd", () => {
  it("reads the success on the reference rig, figure by figure", () => {
    const o = readFixture("success-msi");
    expect(o.run.outcome).toBe("probe.ok");
    expect(o.run.protocol).toEqual({ name: "plugin-hostd.probe-protocol", version: 1 });
    expect(o.plugin).toMatchObject({ format: "clap", id: "org.example.plate", version: "1.4.2" });
    expect(o.binary.sha256).toBe("356902794a4eec2122989e072271ef995968131145db918d9a3084ce582f244b");
    expect(o.binary.layout?.scheme).toBe("omx-layout/1");
    expect(o.grid.map((p) => [p.rate, p.quantum])).toEqual([
      [48000, 128],
      [96000, 128],
    ]);
    expect(o.grid[0]?.cost).toEqual({ median: 41.2, percentile: { p: 95, value: 47.9 }, blocks: 11250, warmupBlocks: 64 });
    expect(o.grid[1]?.rtSafety).toMatchObject({ interposer: true, allocations: 0, locks: 0, syscalls: 0 });
    expect(o.machine.profile.meetsProtocol).toBe(true);
    expect(o.machine.class["cstatesLimited"]).toBe(true);
    expect(o.offer.clapExtensions).toHaveLength(9);
  });

  it("reads the crash and the refusal, which have steps and no figures to speak of", () => {
    const crash = readFixture("plugin-crash");
    expect(crash.run.complete).toBe(false);
    expect(crash.run.outcome).toBe("probe.crashed");
    expect(crash.steps.at(-1)).toMatchObject({ step: "rt-safety", outcome: "probe.crashed" });
    expect(crash.machine.profile.unmet).toEqual(["probe.profile.governor", "probe.profile.deep-idle-entered"]);
    const refusal = readFixture("memory-limit-refused");
    expect(refusal.run.outcome).toBe("probe.memory-limit");
    expect(refusal.grid).toEqual([]);
  });
});

describe("readProbeOutput: the major", () => {
  it("refuses a major it does not know, before it reads anything else", () => {
    const r = refused({ format: "plugin-hostd.probe-output", formatVersion: "2.0" });
    expect(r.code).toBe("probe.format.major-unknown");
    expect(PROBE_FORMAT_CODE.majorUnknown).toBe("probe.format.major-unknown");
  });

  it("refuses major 2 of a full document, and major 0", () => {
    for (const v of ["2.0", "3.4", "0.9"]) {
      const doc = fixtureJson("success-msi");
      doc["formatVersion"] = v;
      expect(refused(doc).code).toBe("probe.format.major-unknown");
    }
  });

  it("reads a newer minor and ignores the fields it adds", () => {
    const doc = fixtureJson("success-msi");
    doc["formatVersion"] = "1.7";
    doc["newThing"] = { anything: 1 };
    doc["grid"][0]["cost"]["futureStatistic"] = 3;
    const r = readProbeOutput(JSON.stringify(doc));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output.formatVersion).toBe("1.7");
  });

  it("refuses a version that is not major.minor", () => {
    for (const v of ["1", "1.0.0", "one", 1.0]) {
      const doc = fixtureJson("success-msi");
      doc["formatVersion"] = v;
      expect(refused(doc).code).toBe("probe.format.invalid");
    }
  });
});

describe("readProbeOutput: derived fields are recomputed, never trusted", () => {
  it("refuses cstatesLimited true when cpuidle holds a deep state that is enabled", () => {
    const doc = fixtureJson("success-msi");
    doc["machine"]["profile"]["cpuidle"][2]["disabled"] = false;
    const r = refused(doc);
    expect(r.code).toBe("probe.format.derived-mismatch");
    expect(r.problem).toContain("cstatesLimited is true but cpuidle[] gives false");
  });

  it("refuses cstatesLimited true when a deep state was entered while the run measured", () => {
    const doc = fixtureJson("success-msi");
    doc["machine"]["profile"]["cpuidle"][2]["usageDelta"] = 4;
    expect(refused(doc).code).toBe("probe.format.derived-mismatch");
  });

  it("refuses cstatesLimited false when no deep state is enabled", () => {
    const doc = fixtureJson("success-msi");
    doc["machine"]["class"]["cstatesLimited"] = false;
    expect(refused(doc).code).toBe("probe.format.derived-mismatch");
  });

  it("refuses cstatesLimited true when the machine reads no idle state at all", () => {
    const doc = fixtureJson("success-msi");
    doc["machine"]["profile"]["cpuidle"] = [];
    expect(refused(doc).code).toBe("probe.format.derived-mismatch");
  });

  it("refuses meetsProtocol true under a governor that is not performance", () => {
    const doc = fixtureJson("success-msi");
    doc["machine"]["profile"]["governor"] = "powersave";
    const r = refused(doc);
    expect(r.code).toBe("probe.format.derived-mismatch");
    expect(r.problem).toContain("probe.profile.governor");
  });

  it("refuses an unmet list that leaves out a deep state the run entered", () => {
    const doc = fixtureJson("plugin-crash");
    doc["machine"]["profile"]["unmet"] = ["probe.profile.governor"];
    expect(refused(doc).code).toBe("probe.format.derived-mismatch");
  });

  it("refuses meetsProtocol that disagrees with unmet in either direction", () => {
    const a = fixtureJson("success-msi");
    a["machine"]["profile"]["unmet"] = ["probe.profile.not-pinned"];
    expect(refused(a).code).toBe("probe.format.derived-mismatch");
    const b = fixtureJson("plugin-crash");
    b["machine"]["profile"]["meetsProtocol"] = true;
    expect(refused(b).code).toBe("probe.format.derived-mismatch");
  });

  it("takes a code it cannot recompute as the runner wrote it", () => {
    const doc = fixtureJson("success-msi");
    doc["machine"]["profile"]["meetsProtocol"] = false;
    doc["machine"]["profile"]["unmet"] = ["probe.profile.not-pinned"];
    const r = readProbeOutput(JSON.stringify(doc));
    expect(r.ok).toBe(true);
  });
});

describe("readProbeOutput: a document that is not a probe output", () => {
  it("refuses a judgment inside it, whichever key carries it", () => {
    for (const key of ["verdict", "verdicts", "rating", "hosting"]) {
      const doc = fixtureJson("success-msi");
      doc[key] = key === "verdicts" ? [] : "suitable";
      const r = refused(doc);
      expect(r.code).toBe("probe.format.invalid");
      expect(r.problem).toContain(key);
    }
  });

  it("refuses text that is not JSON, another format, and a missing block", () => {
    expect(readProbeOutput("{not json")).toMatchObject({ ok: false, code: "probe.format.invalid", problem: "not JSON" });
    expect(refused({ format: "lv2-plugin-measurements", formatVersion: "1.3" }).code).toBe("probe.format.invalid");
    const doc = fixtureJson("success-msi");
    delete doc["binary"];
    expect(refused(doc).problem).toContain("binary");
  });

  it("refuses a digest that is not 64 lowercase hex digits", () => {
    const doc = fixtureJson("success-msi");
    doc["binary"]["sha256"] = doc["binary"]["sha256"].toUpperCase();
    expect(refused(doc).code).toBe("probe.format.invalid");
  });

  it("refuses a grid that names one rate and quantum twice, since a cost read there would be ambiguous", () => {
    const doc = fixtureJson("success-msi");
    doc["grid"][1]["rate"] = 48000;
    expect(refused(doc).problem).toContain("rate 48000 at quantum 128 twice");
  });

  it("refuses a cost percentile below the median's side, a negative figure and an outcome that is no probe code", () => {
    const a = fixtureJson("success-msi");
    a["grid"][0]["cost"]["percentile"]["p"] = 50;
    expect(refused(a).code).toBe("probe.format.invalid");
    const b = fixtureJson("success-msi");
    b["grid"][0]["cost"]["median"] = -1;
    expect(refused(b).code).toBe("probe.format.invalid");
    const c = fixtureJson("success-msi");
    c["steps"][0]["outcome"] = "exploded";
    expect(refused(c).code).toBe("probe.format.invalid");
  });

  it("accepts an outcome code of a later minor, which only adds codes", () => {
    const doc = fixtureJson("success-msi");
    doc["steps"][0]["outcome"] = "probe.something-new";
    expect(readProbeOutput(JSON.stringify(doc)).ok).toBe(true);
  });
});
