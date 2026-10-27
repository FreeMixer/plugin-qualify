// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * A `mod-host` or `jalv` verdict is measured by running the plugin under that host. The classifiers are
 * pure, so the rows of the 2026-10-26 admission probe (`fixtures/admission/2026-10-26.json`) are replayed
 * through them; those rows are the expectations. The sabotage test skips the run and proves the
 * expectations go red; the live test runs the real hosts where they are installed.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  admitPlugin,
  classifyJalvRun,
  classifyModHostRun,
  type AdmissionRuns,
  type AdmittedHost,
  type JalvRun,
  type ModHostRun,
} from "./host-admission.js";
import { JALV_PROFILE, MOD_HOST_PROFILE, OPENMIXER_CONSOLE_PROFILE } from "./host-profiles.js";
import { judgeProbeOutput } from "./probe-judge.js";
import { qualifyTargets, type ProbeRun } from "./probe-runner.js";
import { writeFileSync } from "node:fs";
import { fixtureJson, readFixture } from "./probe-output-fixtures.js";
import { tiersOf } from "./qualification-record.js";

interface Row {
  readonly run: ModHostRun | JalvRun;
  readonly expect: readonly string[];
}
const FIXTURE = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "admission", "2026-10-26.json"), "utf8")) as {
  plugins: Record<string, Partial<Record<AdmittedHost, Row>>>;
};
const ROWS = Object.entries(FIXTURE.plugins).flatMap(([uri, hosts]) =>
  (Object.entries(hosts) as [AdmittedHost, Row][]).map(([host, row]) => ({ uri, host, row })),
);

/** The recorded answers of the probe, served as the runs. */
const recorded = (uri: string): AdmissionRuns => ({
  modHost: () => FIXTURE.plugins[uri]!["mod-host"]!.run as ModHostRun,
  jalv: () => FIXTURE.plugins[uri]!.jalv!.run as JalvRun,
});
/** The runs skipped: every host takes every plugin, as if nothing were run. */
const SKIPPED: AdmissionRuns = {
  modHost: () => ({ installed: true, steps: [{ cmd: "add", resp: 0 }, { cmd: "activate", resp: 0 }, { cmd: "remove", resp: 0 }] }),
  jalv: () => ({ installed: true, stillRunning: true, status: null, signal: null, stderr: "" }),
};

/** The expectations: each row's plugin comes out refused under its host with one of the row's codes. */
function violations(runs: (uri: string) => AdmissionRuns): string[] {
  return ROWS.flatMap(({ uri, host, row }) => {
    const a = admitPlugin(host, uri, runs(uri));
    return a.measured && !a.admitted && row.expect.includes(a.code ?? "") ? [] : [`${uri} on ${host}: ${a.admitted ? "qualified" : (a.code ?? "?")}`];
  });
}

describe("the 2026-10-26 admission rows are the expectations", () => {
  it("drumkv1, samplv1, synthv1 and zynadd come out with their codes under their hosts", () => {
    expect(ROWS.map((r) => `${r.uri.split("/")[2]!.split(".")[0]} ${r.host}`)).toEqual([
      "drumkv1 mod-host",
      "samplv1 mod-host",
      "synthv1 mod-host",
      "synthv1 jalv",
      "zynaddsubfx mod-host",
      "zynaddsubfx jalv",
    ]);
    expect(violations(recorded)).toEqual([]);
  });

  it("sabotage: with the host run skipped, every one of the six rows is red", () => {
    expect(violations(() => SKIPPED)).toHaveLength(ROWS.length);
  });
});

describe("what mod-host did decides", () => {
  const step = (cmd: "add" | "activate" | "remove", rest: object = {}) => ({ cmd, ...rest });
  it("add, activate and remove all answering 0 admits", () => {
    const a = classifyModHostRun({ installed: true, steps: [step("add", { resp: 0 }), step("activate", { resp: 0 }), step("remove", { resp: 0 })] });
    expect(a).toMatchObject({ measured: true, admitted: true });
  });
  it("a refusal is its magnitude, with the whole answer kept", () => {
    expect(classifyModHostRun({ installed: true, steps: [step("add", { resp: -102 })] })).toMatchObject({ admitted: false, code: "mod-host.resp-102", params: { step: "add", resp: -102 } });
  });
  it("a signal is the code wherever it came; a host that went without one on add is a death on add", () => {
    expect(classifyModHostRun({ installed: true, steps: [step("add", { resp: 0 }), step("activate", { died: "SIGSEGV" })] }).code).toBe("mod-host.signal-SIGSEGV");
    expect(classifyModHostRun({ installed: true, steps: [step("add", { died: "exit" })] }).code).toBe("mod-host.died-on-add");
    expect(classifyModHostRun({ installed: true, steps: [step("add", { resp: 0 }), step("activate", { died: "closed" })] }).code).toBe("mod-host.died");
  });
  it("a host that is not installed leaves the verdict unmeasured, with that reason", () => {
    expect(classifyModHostRun({ installed: false, steps: [] })).toMatchObject({ measured: false, admitted: false, code: "mod-host.not-installed" });
  });
  it("silence is a refusal, not an admission", () => {
    expect(classifyModHostRun({ installed: true, steps: [] }).admitted).toBe(false);
    expect(classifyModHostRun({ installed: true, steps: [step("add")] }).code).toBe("mod-host.no-answer");
  });
});

describe("what jalv did decides", () => {
  const jalv = (r: Partial<JalvRun>): JalvRun => ({ installed: true, stillRunning: false, status: 0, signal: null, stderr: "", ...r });
  it("alive at the deadline is hosted", () => expect(classifyJalvRun(jalv({ stillRunning: true, status: null }))).toMatchObject({ measured: true, admitted: true }));
  it("a signal, an unknown port type and an exit are each their own code", () => {
    expect(classifyJalvRun(jalv({ status: null, signal: "SIGABRT" })).code).toBe("jalv.signal-SIGABRT");
    expect(classifyJalvRun(jalv({ status: 1, stderr: 'Mandatory port "midi_in" has unknown type' }))).toMatchObject({ code: "jalv.unknown-port-type", params: { port: "midi_in" } });
    expect(classifyJalvRun(jalv({ status: 1 })).code).toBe("jalv.exit-1");
  });
  it("not installed is unmeasured", () => expect(classifyJalvRun(jalv({ installed: false }))).toMatchObject({ measured: false, code: "jalv.not-installed" }));
  it("a run that itself broke is unmeasured, never an admission", () => {
    const broken: AdmissionRuns = { modHost: () => { throw new Error("socket"); }, jalv: SKIPPED.jalv };
    expect(admitPlugin("mod-host", "urn:x", broken)).toMatchObject({ measured: false, admitted: false, code: "mod-host.admission-failed" });
  });
});

describe("the verdict and the tiers", () => {
  const output = readFixture("success-msi");
  const profiles = [OPENMIXER_CONSOLE_PROFILE, MOD_HOST_PROFILE, JALV_PROFILE];
  const lv2 = (uri: string) => {
    const doc = fixtureJson("success-msi");
    doc.plugin = { format: "lv2", id: uri };
    return doc;
  };

  it("a refusal makes the host's verdict unsuitable with the code, measured by a run, whatever the declaration says", () => {
    const uri = "http://zynaddsubfx.sourceforge.net";
    const a = Object.fromEntries((["mod-host", "jalv"] as const).map((h) => [h, admitPlugin(h, uri, recorded(uri))]));
    const j = judgeProbeOutput({ ...output, plugin: { ...output.plugin, format: "lv2", id: uri } }, profiles, { admissions: a });
    const by = (id: string) => j.hosts.find((h) => h.verdict.host === id)!;
    expect(by("mod-host")).toMatchObject({ arm: "run", verdict: { measured: true, rating: "unsuitable", qualified: false, deciding: "mod-host.resp-102" } });
    expect(by("jalv").verdict.deciding).toBe("jalv.unknown-port-type");
    expect(by("openmixer-console")).toMatchObject({ arm: "declaration", verdict: { qualified: true } });
    expect(tiersOf(j)).toMatchObject({ offeredOn: ["in-process"], isolated: { host: "mod-host", qualified: false, deciding: "mod-host.resp-102" } });
  });

  it("an uninstalled host leaves the verdict unmeasured, with that reason", () => {
    const a = { "mod-host": classifyModHostRun({ installed: false, steps: [] }) };
    const j = judgeProbeOutput({ ...output, plugin: { ...output.plugin, format: "lv2" } }, profiles, { admissions: a });
    expect(j.hosts.find((h) => h.verdict.host === "mod-host")!.verdict).toMatchObject({ measured: false, rating: "unknown", deciding: "mod-host.not-installed" });
  });

  it("a plugin neither tier takes is dimmed with both reasons", () => {
    const a = { "mod-host": classifyModHostRun({ installed: true, steps: [{ cmd: "add", died: "SIGABRT" }] }) };
    const bad = fixtureJson("success-msi");
    bad.plugin = { format: "lv2", id: "urn:x:bad" };
    bad.grid[0].rtSafety.locks = 4;
    const doc = judgeProbeOutput({ ...output, plugin: { ...output.plugin, format: "lv2" }, grid: bad.grid }, profiles, { admissions: a });
    const tiers = tiersOf(doc);
    expect(tiers.offeredOn).toEqual([]);
    expect(tiers.dimmed).toMatch(/openmixer-console: .*; mod-host: mod-host\.signal-SIGABRT/);
  });

  it("qualifyTargets runs each LV2 plugin under the measured hosts once and writes the tiers: a plugin that kills mod-host is offered in-process only", () => {
    const uri = "http://synthv1.sourceforge.net/lv2";
    const doc = lv2(uri);
    const run: ProbeRun = (_tool, args) => {
      writeFileSync(args[args.indexOf("--out") + 1]!, JSON.stringify(doc));
      return { status: 0, signal: null };
    };
    const calls: string[] = [];
    const runs: AdmissionRuns = {
      modHost: (u) => (calls.push(`mod-host ${u}`), recorded(uri).modHost(u)),
      jalv: (u) => (calls.push(`jalv ${u}`), recorded(uri).jalv(u)),
    };
    const pass = qualifyTargets([{ format: "lv2", uri }], { rates: [48000], run, env: {}, profiles: [OPENMIXER_CONSOLE_PROFILE], admissions: runs });
    // only the asked host is a verdict row; mod-host was run because it is the isolated tier
    expect(pass.verdicts.map((v) => [v.host, v.qualified])).toEqual([["openmixer-console", true]]);
    expect(calls).toEqual([`mod-host ${uri}`]);
    const record = JSON.parse(JSON.stringify(pass.runs[0]!.judgment.hosts.map((h) => [h.verdict.host, h.arm])));
    expect(record).toEqual([["openmixer-console", "declaration"], ["mod-host", "run"]]);
    expect(tiersOf(pass.runs[0]!.judgment)).toMatchObject({ offeredOn: ["in-process"], isolated: { qualified: false, deciding: "mod-host.signal-SIGABRT" } });
  });
});

const installed = (tool: string): boolean => spawnSync("which", [tool]).status === 0;
describe.skipIf(!installed("mod-host") || !process.env["OMX_LV2_ADMISSION_LIVE"])("live: the four plugins on the installed hosts", () => {
  it("each row of the 2026-10-26 probe is reproduced", () => {
    const out = ROWS.map(({ uri, host }) => ({ uri, host, a: admitPlugin(host, uri) }));
    for (const { a, uri, host } of out) {
      const row = FIXTURE.plugins[uri]![host]!;
      expect(row.expect, `${uri} on ${host}`).toContain(a.code ?? "admitted");
    }
  });
});

describe("tools/mod-host-admit.mjs against a stand-in mod-host", () => {
  const dir = mkdtempSync(join(tmpdir(), "mod-host-admit-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const stand = join(dir, "mod-host");
  writeFileSync(
    stand,
    `#!${process.execPath}
const net = require("node:net");
const port = Number(process.argv[process.argv.indexOf("-p") + 1]);
const mode = process.env.STAND_IN;
net.createServer((c) => c.on("data", (d) => {
  const cmd = d.toString().split(" ")[0];
  if (mode === "abort" && cmd === "add") process.kill(process.pid, "SIGABRT");
  c.write("resp " + (mode === "refuse" && cmd === "add" ? -102 : 0) + "\0");
})).listen(port, "127.0.0.1");
`,
  );
  chmodSync(stand, 0o755);
  const helper = join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "mod-host-admit.mjs");
  const admit = (mode: string, path = `${dir}:${process.env["PATH"]}`): ModHostRun =>
    JSON.parse(spawnSync(process.execPath, [helper, "urn:x"], { encoding: "utf8", env: { ...process.env, PATH: path, STAND_IN: mode } }).stdout) as ModHostRun;

  it("a host that takes the plugin answers add, activate and remove", () => {
    expect(admit("ok")).toEqual({ installed: true, steps: [{ cmd: "add", resp: 0 }, { cmd: "activate", resp: 0 }, { cmd: "remove", resp: 0 }] });
  });
  it("a refusal stops the run at the refused step", () => expect(classifyModHostRun(admit("refuse")).code).toBe("mod-host.resp-102"));
  it("a host that aborts on add is the signal", () => expect(classifyModHostRun(admit("abort")).code).toBe("mod-host.signal-SIGABRT"));
  it("no mod-host on the PATH is not installed", () => expect(admit("ok", dirname(process.execPath))).toEqual({ installed: false, steps: [] }));
});
