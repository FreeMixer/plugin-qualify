// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Every grid cell of a record carries latency (#201): the probe output's two figures as written, or why there are
 * none, as the contract's unmeasured word and the hosting code. On the Pi 5 run the cells without latency had none in
 * their probe output either (a runner and a child older than the latency arm): the record now says so.
 */
import { describe, expect, it } from "vitest";

import { HOSTING_CODE } from "./hosting-codes.js";
import { OMX_CLAP_HOST_PROFILE } from "./host-profiles.js";
import { PROBE_OOM } from "./memory-bound.js";
import { judgeProbeOutput } from "./probe-judge.js";
import { fixtureJson } from "./probe-output-fixtures.js";
import { readProbeOutput } from "./probe-output.js";
import { buildQualificationRecord } from "./qualification-record.js";

function recordOf(patch: (d: Record<string, any>) => void) {
  const d = fixtureJson("success-msi");
  patch(d);
  const r = readProbeOutput(JSON.stringify(d));
  if (!r.ok) throw new Error(r.problem);
  return buildQualificationRecord(judgeProbeOutput(r.output, [OMX_CLAP_HOST_PROFILE]), { file: "x.probe.json", sha256: "0".repeat(64), bytes: 1 });
}
const cell = (rec: ReturnType<typeof recordOf>, rate: number, quantum: number) => rec.measurements.grid.find((p) => p.rate === rate && p.quantum === quantum);

describe("a record's cells all carry latency", () => {
  it("the probe output's declared and measured figures are kept as written", () => {
    const rec = recordOf(() => {});
    expect(cell(rec, 48000, 128)?.latency).toEqual({ declaredFrames: 0, measuredFrames: 0 });
    expect(rec.measurements.grid.every((p) => p.latency !== undefined)).toBe(true);
  });

  it("a cell the run took no latency at says not-attempted; one whose latency step failed says the child's reason", () => {
    const rec = recordOf((d) => {
      for (const p of d.grid) delete p.latency;
      d.steps = d.steps.filter((s: any) => !(s.step === "latency" && s.rate === 96000));
      const at48 = d.steps.find((s: any) => s.step === "latency" && s.rate === 48000);
      Object.assign(at48, { outcome: "probe.not-attempted", hostingCode: HOSTING_CODE.latencyUnmeasured, detail: "silent-output: the response stayed silent" });
    });
    expect(cell(rec, 96000, 128)?.latency).toEqual({ unmeasuredReason: "not-attempted", code: HOSTING_CODE.latencyUnmeasured });
    expect(cell(rec, 48000, 128)?.latency).toEqual({ unmeasuredReason: "silent-output", code: HOSTING_CODE.latencyUnmeasured });
  });

  it("a cell the plugin declared latency for but the probe did not measure keeps the declared figure and says why (#201)", () => {
    const rec = recordOf((d) => {
      d.grid[0].latency = { declaredFrames: 64 };
      Object.assign(d.steps.find((s: any) => s.step === "latency" && s.rate === 48000), {
        outcome: "probe.not-attempted", hostingCode: HOSTING_CODE.latencyUnmeasured, detail: "silent-output: the response stayed silent",
      });
    });
    expect(cell(rec, 48000, 128)?.latency).toEqual({ declaredFrames: 64, unmeasuredReason: "silent-output", code: HOSTING_CODE.latencyUnmeasured });
  });

  it("a reason that is not a contract word is probe-error; a cell whose run failed is named by its outcome", () => {
    const rec = recordOf((d) => {
      delete d.grid[0].latency;
      d.steps.find((s: any) => s.step === "latency" && s.rate === 48000).detail = "something the child said";
      d.grid[1] = { rate: 96000, quantum: 128, outcome: PROBE_OOM, memoryLimit: { bytes: 1024, mechanism: "rlimit-data" } };
    });
    expect(cell(rec, 48000, 128)?.latency).toEqual({ unmeasuredReason: "probe-error", code: HOSTING_CODE.latencyUnmeasured });
    expect(cell(rec, 96000, 128)?.latency).toEqual({ unmeasuredReason: "probe-error", code: HOSTING_CODE.latencyUnmeasured });
  });
});
