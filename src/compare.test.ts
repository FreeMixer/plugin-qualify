// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  COMPARISON_RECORD_SCHEMA,
  COMPARISON_SUMMARY_SCHEMA,
  comparisonFileName,
  comparisonRecordOf,
  comparisonRecordProblems,
  hostRowOf,
  missingReferences,
  notApplicableRow,
  parseCompareArgs,
  presenceFromRecords,
  rtCheckOf,
  summarise,
  type ComparisonConditions,
  type HostObservation,
  type HostPresence,
  type HostRow,
  type RtReport,
} from "./compare.js";

const COND = { cycles: 3, soakS: 5 };
const CONDITIONS: ComparisonConditions = { rate: 48000, quantum: 256, cycles: 3, soakS: 5, windowMs: 1000, timeoutMs: 5000, jack: "jackd 1.9.22", realtime: "rtprio 70" };
const rt = (over: Partial<RtReport> = {}): RtReport => ({ pid: 1, callbacks: 1, cycles: 900, armedCycles: 836, allocations: 0, locks: 0, syscalls: 0, ...over });
const clean: HostObservation = {
  installed: true,
  started: true,
  load: { ok: true, resp: 0 },
  ports: { audioIn: 2, audioOut: 2, midiIn: 0 },
  stimulus: "tone",
  peak: 0.19,
  cycles: { done: 3, of: 3 },
  soak: { seconds: 5, alive: true, peakAtEnd: 0.19 },
  rt: [rt()],
  cpu: { percent: 0.666 },
  latencyFrames: 64,
};
const ALL: HostPresence[] = [
  { host: "omx-clap-host", installed: true, version: "omx-clap-host 0.27.0" },
  { host: "plugin-hostd", installed: true, version: "plugin-hostd 0.16.0" },
  { host: "mod-host", installed: true, version: "mod-host 0.10.6" },
  { host: "jalv", installed: true, version: "jalv 1.8.0" },
];

describe("compare arguments", () => {
  it("takes every host by default and refuses an unknown one", () => {
    const p = parseCompareArgs(["--all"]);
    expect(p.ok && p.args.hosts).toEqual(["omx-clap-host", "plugin-hostd", "mod-host", "jalv"]);
    const bad = parseCompareArgs(["--all", "--hosts", "mod-host,carla"]);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toContain("carla");
  });
  it("a publishable run names its class and set and compares against mod-host and jalv", () => {
    expect(parseCompareArgs(["--all", "--publish", "--out", "o"]).ok).toBe(false);
    const noRef = parseCompareArgs(["--all", "--publish", "--out", "o", "--host-class", "x86-64", "--set", "fedora44", "--hosts", "omx-clap-host,mod-host"]);
    expect(!noRef.ok && noRef.error).toContain("mod-host and jalv");
    expect(parseCompareArgs(["--all", "--publish", "--out", "o", "--host-class", "x86-64", "--set", "fedora44"]).ok).toBe(true);
  });
  it("the same rate, quantum, cycles, soak and timeouts for every host: one set of numbers per run", () => {
    const p = parseCompareArgs(["urn:a", "--rate", "96000", "--quantum", "128", "--cycles", "10", "--soak", "60"]);
    expect(p.ok && [p.args.rate, p.args.quantum, p.args.cycles, p.args.soakS]).toEqual([96000, 128, 10, 60]);
    expect(parseCompareArgs(["urn:a", "--soak", "0"]).ok).toBe(false);
  });
});

describe("a missing host is skipped with its reason, never left out", () => {
  it("names each missing reference", () => {
    const present: HostPresence[] = [ALL[0]!, { host: "mod-host", installed: false, version: null, reason: "mod-host is not installed (not on PATH)" }];
    expect(missingReferences(present)).toEqual([
      { host: "mod-host", reason: "mod-host is not installed (not on PATH)" },
      { host: "jalv", reason: "not asked for with --hosts" },
    ]);
    expect(missingReferences(ALL)).toEqual([]);
  });
  it("a host that is not installed gives a skipped row", () => {
    const row = hostRowOf("jalv", null, { installed: false }, COND);
    expect(row).toEqual({ host: "jalv", version: null, status: "skipped", reason: "jalv is not installed" });
  });
  it("a host that does not take the format is not applicable, not failed", () => {
    expect(notApplicableRow("mod-host", "mod-host 0.10.6", "clap")).toMatchObject({ status: "not-applicable", reason: "mod-host takes no CLAP plugin" });
  });
});

describe("one host's row", () => {
  it("a clean run passes every check and carries its figures", () => {
    const row = hostRowOf("jalv", "jalv 1.8.0", clean, COND);
    expect(row.runsClean).toBe(true);
    expect(row.checks?.output).toEqual({ result: "pass", peak: 0.19, stimulus: "tone" });
    expect(row.checks?.cpu).toEqual({ result: "measured", percent: 0.67 });
    expect(row.checks?.latency).toEqual({ result: "measured", frames: 64 });
  });
  it("mod-host's latency is not observable, never a failure", () => {
    const row = hostRowOf("mod-host", "mod-host 0.10.6", clean, COND);
    expect(row.checks?.latency.result).toBe("not-observable");
    expect(row.runsClean).toBe(true);
  });
  it("a plugin with no stimulus and a silent output is not observable; one fed and silent fails", () => {
    const quiet = { ...clean, ports: { audioIn: 0, audioOut: 2, midiIn: 0 }, stimulus: "none" as const, peak: 0 };
    expect(hostRowOf("jalv", null, quiet, COND).checks?.output.result).toBe("not-observable");
    expect(hostRowOf("jalv", null, quiet, COND).runsClean).toBe(true);
    const fed = { ...clean, peak: 0 };
    expect(hostRowOf("jalv", null, fed, COND).checks?.output).toMatchObject({ result: "fail", detail: "silent under tone" });
    expect(hostRowOf("jalv", null, fed, COND).runsClean).toBe(false);
  });
  it("NaN or infinite samples on the output fail it, whatever the finite peak", () => {
    const row = hostRowOf("jalv", null, { ...clean, nonFinite: 512 }, COND);
    expect(row.checks?.output).toMatchObject({ result: "fail", detail: "the output is not finite (512 NaN or infinite samples)" });
    expect(row.runsClean).toBe(false);
  });
  it("a host that dies is a crash at its step, and the checks after it did not run", () => {
    const died: HostObservation = { installed: true, started: true, load: { ok: false, died: "SIGSEGV" }, cycles: { done: 0, of: 3, failedAt: "add", died: "SIGSEGV" }, died: { step: "load", signal: "SIGSEGV" } };
    const row = hostRowOf("mod-host", null, died, COND);
    expect(row.crash).toEqual({ step: "load", signal: "SIGSEGV" });
    expect(row.checks?.loads).toEqual({ result: "fail", detail: "the host ended (SIGSEGV)" });
    expect(row.checks?.output.result).toBe("not-run");
    expect(row.checks?.rtSafe.result).toBe("not-run");
    expect(row.runsClean).toBe(false);
  });
  it("a load cycle that fails fails the cycles check", () => {
    const row = hostRowOf("omx-clap-host", null, { ...clean, cycles: { done: 2, of: 3, failedAt: "remove" } }, COND);
    expect(row.checks?.cycles).toEqual({ result: "fail", done: 2, of: 3, detail: "cycle 3 failed at remove" });
    expect(row.runsClean).toBe(false);
  });
});

describe("the real-time watch", () => {
  it("no report, or no callback wrapped, is not observable, never clean", () => {
    expect(rtCheckOf(undefined).result).toBe("not-observable");
    expect(rtCheckOf([]).result).toBe("not-observable");
    expect(rtCheckOf([rt({ callbacks: 0 })]).result).toBe("not-observable");
    expect(rtCheckOf([rt({ armedCycles: 0 })]).result).toBe("not-observable");
  });
  it("an allocation, a lock or a system call on the audio thread fails it, summed over the host's processes", () => {
    const r = rtCheckOf([rt(), rt({ pid: 2, allocations: 4, kinds: ["malloc", "free"] }), rt({ pid: 3, callbacks: 0, allocations: 99 })]);
    expect(r).toMatchObject({ result: "fail", allocations: 4, locks: 0, syscalls: 0, cycles: 1672, kinds: ["malloc", "free"] });
  });
  it("a try-lock never waits: it is reported and does not fail the check", () => {
    const r = rtCheckOf([rt({ trylocks: 938, kinds: ["pthread_mutex_trylock"] })]);
    expect(r.result).toBe("pass");
    expect(r.trylocks).toBe(938);
  });
});

const recordOf = (id: string, rows: HostRow[]) => comparisonRecordOf({ format: "lv2", id }, "tone", CONDITIONS, "2026-11-04T10:00:00.000Z", rows);
const row = (host: HostRow["host"], obs: HostObservation = clean) => hostRowOf(host, ALL.find((p) => p.host === host)?.version ?? null, obs, COND);

describe("the record", () => {
  it("rows in the hosts' order, schema-checked", () => {
    const rec = recordOf("urn:a", [row("jalv"), row("omx-clap-host"), row("mod-host"), row("plugin-hostd")]);
    expect(rec.schema).toBe(COMPARISON_RECORD_SCHEMA);
    expect(rec.hosts.map((h) => h.host)).toEqual(["omx-clap-host", "plugin-hostd", "mod-host", "jalv"]);
    expect(comparisonRecordProblems(JSON.parse(JSON.stringify(rec)))).toEqual([]);
    expect(comparisonRecordProblems({ ...rec, hosts: [{ host: "carla", status: "skipped" }] })).toEqual(['a row of the unknown host "carla"', "carla: skipped with no reason"]);
  });
  it("file names never meet for two ids", () => {
    const a = comparisonFileName("lv2", "http://example.org/a#b");
    expect(a).toMatch(/^example.org_a_b-lv2-[0-9a-f]{12}\.comparison\.json$/);
    expect(comparisonFileName("lv2", "http://example.org/a_b")).not.toBe(a);
  });
});

describe("the summary", () => {
  const crash: HostObservation = { installed: true, started: true, load: { ok: false, died: "SIGABRT" }, cycles: { done: 0, of: 3, died: "SIGABRT" }, died: { step: "load", signal: "SIGABRT" } };
  const allocates: HostObservation = { ...clean, rt: [rt({ allocations: 12 })] };
  const records = [
    recordOf("urn:a", [row("omx-clap-host"), row("plugin-hostd"), row("mod-host"), row("jalv")]),
    recordOf("urn:b", [row("omx-clap-host"), row("plugin-hostd"), row("mod-host", crash), row("jalv")]),
    recordOf("urn:c", [row("omx-clap-host", allocates), row("plugin-hostd", allocates), row("mod-host"), row("jalv", allocates)]),
  ];
  it("counts per host and names where each host does better, mod-host and jalv included", () => {
    const s = summarise(records, ALL, { hostClass: "x86-64", set: "fedora44", publish: true });
    expect(s.schema).toBe(COMPARISON_SUMMARY_SCHEMA);
    expect(s.publishable).toBe(true);
    const mod = s.hosts.find((h) => h.host === "mod-host");
    expect(mod).toMatchObject({ plugins: 3, loads: 2, runsClean: 2, rtSafe: 2, rtObserved: 2, crashes: 1, latencyObservable: false });
    expect(s.beats["omx-clap-host"]).toEqual([{ format: "lv2", id: "urn:b", over: ["mod-host"], on: "runs-clean" }]);
    // where a reference does better is stated as plainly as where ours does
    expect(s.beats["mod-host"]).toEqual([{ format: "lv2", id: "urn:c", over: ["omx-clap-host", "plugin-hostd", "jalv"], on: "rt-safe" }]);
    expect(s.measured).toBe("2026-11-04");
    expect(s.common).toBe(3);
  });
  it("is not publishable without both references, and says which is missing", () => {
    const present = ALL.filter((p) => p.host !== "jalv").concat([{ host: "jalv", installed: false, version: null, reason: "jalv is not installed (not on PATH)" }]);
    const recs = records.map((r) => ({ ...r, hosts: r.hosts.map((h) => (h.host === "jalv" ? hostRowOf("jalv", null, { installed: false, problem: "jalv is not installed (not on PATH)" }, COND) : h)) }));
    const s = summarise(recs, present, { publish: true });
    expect(s.publishable).toBe(false);
    expect(s.missing).toEqual([{ host: "jalv", reason: "jalv is not installed (not on PATH)" }]);
    expect(s.hosts.find((h) => h.host === "jalv")).toMatchObject({ status: "skipped", reason: "jalv is not installed (not on PATH)", plugins: 0 });
  });
  it("a summary made from the records alone finds the same hosts", () => {
    expect(presenceFromRecords(records).map((p) => [p.host, p.installed])).toEqual(ALL.map((p) => [p.host, true]));
  });
});

describe("plugin-qualify compare --publish", () => {
  it("refuses before anything runs when mod-host and jalv are not installed, naming both", () => {
    const bin = fileURLToPath(new URL("../bin/plugin-qualify.mjs", import.meta.url));
    const out = mkdtempSync(join(tmpdir(), "pq-compare-"));
    const r = spawnSync(process.execPath, [bin, "compare", "--publish", "--out", out, "--host-class", "x86-64", "--set", "t", "urn:a"], {
      encoding: "utf8",
      env: { PATH: join(out, "no-such-dir") },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--publish refused: mod-host:");
    expect(r.stderr).toContain("--publish refused: jalv:");
  });
});
