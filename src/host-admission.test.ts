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
  ADAPTER_HOST,
  classifyProtocolRun,
  SPAWNED_ADMISSIONS,
  classifyJalvRun,
  classifyModHostRun,
  type AdmissionRuns,
  type AdmittedHost,
  type JalvRun,
  type ModHostRun,
  JALV_HOSTED_MS,
  admissionRating,
} from "./host-admission.js";
import { JALV_PROFILE, MOD_HOST_PROFILE, OMX_CLAP_HOST_PROFILE, OPENMIXER_CONSOLE_PROFILE } from "./host-profiles.js";
import { pinVerdictOf } from "./pins-file.js";
import { judgeProbeOutput } from "./probe-judge.js";
import { qualifyTargets, type ProbeRun } from "./probe-runner.js";
import { writeFileSync } from "node:fs";
import { fixtureJson, readFixture, withoutMemoryBudget } from "./probe-output-fixtures.js";
import { buildQualificationRecord, tiersOf } from "./qualification-record.js";

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
  modHost: () => ({ installed: true, steps: [{ cmd: "add", resp: 0 }, { cmd: "remove", resp: 0 }] }),
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
  const step = (cmd: "add" | "remove", rest: object = {}) => ({ cmd, ...rest });
  it("add and remove both answering 0 admits", () => {
    const a = classifyModHostRun({ installed: true, steps: [step("add", { resp: 0 }), step("remove", { resp: 0 })] });
    expect(a).toMatchObject({ measured: true, admitted: true });
  });
  it("a refusal is its magnitude, with the whole answer kept", () => {
    expect(classifyModHostRun({ installed: true, steps: [step("add", { resp: -102 })] })).toMatchObject({ admitted: false, code: "mod-host.resp-102", params: { step: "add", resp: -102 } });
  });
  it("a signal is the code wherever it came; a host that went without one on add is a death on add", () => {
    expect(classifyModHostRun({ installed: true, steps: [step("add", { resp: 0 }), step("remove", { died: "SIGSEGV" })] }).code).toBe("mod-host.signal-SIGSEGV");
    expect(classifyModHostRun({ installed: true, steps: [step("add", { died: "exit" })] }).code).toBe("mod-host.died-on-add");
    expect(classifyModHostRun({ installed: true, steps: [step("add", { resp: 0 }), step("remove", { died: "closed" })] }).code).toBe("mod-host.died");
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

describe("the jalv run ends at its deadline (#187)", () => {
  // jalv hosting some plugins ignores SIGTERM (973 of 979 needed SIGKILL in the desk coverage run of 2026-10-26),
  // and one stuck in jack_client_open never reads the flag TERM sets: the deadline must end the process itself
  it("a jalv that ignores SIGTERM is alive at the deadline, and the run returns at it", () => {
    const bin = mkdtempSync(join(tmpdir(), "jalv-ignores-term-"));
    try {
      writeFileSync(join(bin, "jalv"), `#!${process.execPath}\nprocess.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n`);
      chmodSync(join(bin, "jalv"), 0o755);
      const started = Date.now();
      const run = SPAWNED_ADMISSIONS.jalv("urn:x", { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` });
      const took = Date.now() - started;
      expect(run).toMatchObject({ installed: true, stillRunning: true });
      expect(classifyJalvRun(run)).toMatchObject({ measured: true, admitted: true });
      expect(took).toBeLessThan(JALV_HOSTED_MS + 2000);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("the verdict and the tiers", () => {
  const output = readFixture("success-msi");
  const profiles = [withoutMemoryBudget(OPENMIXER_CONSOLE_PROFILE), MOD_HOST_PROFILE, JALV_PROFILE];
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
    // mod-host is a host asked about, not a tier: the LV2 isolated tier is omx-clap-host, and no profile here judged it
    expect(tiersOf(j)).toMatchObject({ offeredOn: ["in-process"] });
    expect(tiersOf(j).isolated).toBeUndefined();
  });

  it("an uninstalled host leaves the verdict unmeasured, with that reason", () => {
    const a = { "mod-host": classifyModHostRun({ installed: false, steps: [] }) };
    const j = judgeProbeOutput({ ...output, plugin: { ...output.plugin, format: "lv2" } }, profiles, { admissions: a });
    expect(j.hosts.find((h) => h.verdict.host === "mod-host")!.verdict).toMatchObject({ measured: false, rating: "unknown", deciding: "mod-host.not-installed" });
  });

  it("a plugin neither tier takes is dimmed with both reasons", () => {
    const a = { "omx-clap-host": classifyProtocolRun(ADAPTER_HOST, { installed: true, steps: [{ cmd: "add", died: "SIGABRT" }] }) };
    const bad = fixtureJson("success-msi");
    bad.plugin = { format: "lv2", id: "urn:x:bad" };
    bad.grid[0].rtSafety.locks = 4;
    const doc = judgeProbeOutput({ ...output, plugin: { ...output.plugin, format: "lv2" }, grid: bad.grid }, [...profiles, OMX_CLAP_HOST_PROFILE], { admissions: a });
    const tiers = tiersOf(doc);
    expect(tiers.offeredOn).toEqual([]);
    expect(tiers.dimmed).toMatch(/openmixer-console: .*; omx-clap-host: omx-clap-host\.signal-SIGABRT/);
  });

  it("qualifyTargets runs each LV2 plugin under the LV2 adapter once and writes the tiers: a plugin the adapter refuses is offered in-process only", () => {
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
      adapter: (u) => (calls.push(`omx-clap-host ${u}`), { installed: true, steps: [{ cmd: "add", died: "SIGABRT" }] }),
    };
    const pass = qualifyTargets([{ format: "lv2", uri }], { rates: [48000], run, env: {}, profiles: [withoutMemoryBudget(OPENMIXER_CONSOLE_PROFILE)], admissions: runs });
    // only the asked host is a verdict row; the adapter was run because omx-clap-host is the isolated tier, and
    // mod-host, which no one asked about, was not run at all
    expect(pass.verdicts.map((v) => [v.host, v.qualified])).toEqual([["openmixer-console", true]]);
    expect(calls).toEqual([`omx-clap-host ${uri}`]);
    const record = JSON.parse(JSON.stringify(pass.runs[0]!.judgment.hosts.map((h) => [h.verdict.host, h.arm])));
    expect(record).toEqual([["openmixer-console", "declaration"], ["omx-clap-host", "run"]]);
    expect(tiersOf(pass.runs[0]!.judgment)).toMatchObject({ offeredOn: ["in-process"], isolated: { host: "omx-clap-host", qualified: false, deciding: "omx-clap-host.signal-SIGABRT" } });
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
  if (cmd !== "add" && cmd !== "remove") return c.write("few arguments\0"); // mod-host answers a verb it lacks with no resp line
  if (mode === "abort" && cmd === "add") process.kill(process.pid, "SIGABRT");
  // "path": as mod-host does, a plugin outside the LV2_PATH it was started with is an unknown URI
  const seen = (process.env.LV2_PATH || "").split(":").includes(process.env.STAND_BUNDLES);
  if (mode === "path" && cmd === "add" && !seen) return c.write("resp -101\0");
  c.write("resp " + (mode === "refuse" && cmd === "add" ? -102 : 0) + "\0");
})).listen(port, "127.0.0.1");
`,
  );
  chmodSync(stand, 0o755);
  const helper = join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "mod-host-admit.mjs");
  const admit = (mode: string, path = `${dir}:${process.env["PATH"]}`): ModHostRun =>
    JSON.parse(spawnSync(process.execPath, [helper, "urn:x"], { encoding: "utf8", env: { ...process.env, PATH: path, STAND_IN: mode } }).stdout) as ModHostRun;

  it("a host that takes the plugin answers add and remove", () => {
    expect(admit("ok")).toEqual({ installed: true, steps: [{ cmd: "add", resp: 0 }, { cmd: "remove", resp: 0 }] });
  });
  it("a refusal stops the run at the refused step", () => expect(classifyModHostRun(admit("refuse")).code).toBe("mod-host.resp-102"));
  it("a host that aborts on add is the signal", () => expect(classifyModHostRun(admit("abort")).code).toBe("mod-host.signal-SIGABRT"));
  it("no mod-host on the PATH is not installed", () => expect(admit("ok", dirname(process.execPath))).toEqual({ installed: false, steps: [] }));

  // plugin-qualify#224: the sync's mod-host was started with no LV2_PATH and answered -101 for mda Piano, which lives in
  // Zynthian's own LV2 directory; the admission hosts now start on the device's directories
  it("a plugin outside lilv's defaults is admitted when the host is started on the device's LV2_PATH", () => {
    const bundles = join(dir, "zynthian-plugins", "lv2");
    const env = { ...process.env, PATH: `${dir}:${process.env["PATH"]}`, STAND_IN: "path", STAND_BUNDLES: bundles };
    delete (env as Record<string, string | undefined>)["LV2_PATH"];
    expect(classifyModHostRun(SPAWNED_ADMISSIONS.modHost("urn:x", env)).code).toBe("mod-host.resp-101");
    const onDevice = { ...env, LV2_PATH: `/usr/lib/lv2:${bundles}` };
    expect(admitPlugin("mod-host", "urn:x", SPAWNED_ADMISSIONS, onDevice)).toMatchObject({ host: "mod-host", admitted: true });
  });
});

describe("qualifyTargets starts the admission hosts on the LV2 directories it is given", () => {
  it("mod-host and the adapter get admissionLv2Path as their LV2_PATH, not the run's one-bundle world", () => {
    const uri = "http://moddevices.com/plugins/mda/Piano";
    const doc = fixtureJson("success-msi");
    doc.plugin = { format: "lv2", id: uri };
    const run: ProbeRun = (_tool, args) => {
      writeFileSync(args[args.indexOf("--out") + 1]!, JSON.stringify(doc));
      return { status: 0, signal: null };
    };
    const seen: (string | undefined)[] = [];
    const runs: AdmissionRuns = {
      modHost: (u, env) => (seen.push(env?.["LV2_PATH"]), recorded(uri).modHost(u)),
      jalv: (u, env) => (seen.push(env?.["LV2_PATH"]), recorded(uri).jalv(u)),
      adapter: (_u, env) => (seen.push(env?.["LV2_PATH"]), { installed: true, steps: [] }),
    };
    const dirs = ["/usr/lib/lv2", "/usr/local/lib/lv2", "/zynthian/zynthian-plugins/lv2"];
    qualifyTargets([{ format: "lv2", uri }], { rates: [48000], run, env: { LV2_PATH: "/tmp/one-bundle-world" }, profiles: [OPENMIXER_CONSOLE_PROFILE, MOD_HOST_PROFILE], admissions: runs, admissionLv2Path: dirs });
    expect(seen.length).toBe(2);
    expect(seen.every((p) => p === dirs.join(":"))).toBe(true);
  });
});

// plugin-qualify#223: an LV2 record carries its run under plugin-hostd's LV2 adapter; the run decides the
// omx-clap-host verdict, the LV2 isolated tier, as a mod-host run decides mod-host's
describe("the run under plugin-hostd's LV2 adapter", () => {
  it("is classified as a mod-host run is, under the adapter's own name", () => {
    expect(classifyProtocolRun(ADAPTER_HOST, { installed: true, steps: [{ cmd: "add", resp: -512 }] })).toMatchObject({
      host: "omx-clap-host", measured: true, admitted: false, code: "omx-clap-host.resp-512",
    });
    expect(classifyProtocolRun(ADAPTER_HOST, { installed: false, steps: [] }).code).toBe("omx-clap-host.not-installed");
  });

  it("is written into an LV2 record and decides its isolated tier, leaves the asked verdicts alone, and a CLAP plugin has none", () => {
    const uri = "urn:distrho:vitalium";
    const doc = fixtureJson("success-msi");
    doc.plugin = { format: "lv2", id: uri };
    const run: ProbeRun = (_tool, args) => {
      writeFileSync(args[args.indexOf("--out") + 1]!, JSON.stringify(doc));
      return { status: 0, signal: null };
    };
    const refusing: AdmissionRuns = { ...SKIPPED, adapter: () => ({ installed: true, steps: [{ cmd: "add", resp: -512 }] }) };
    const base = qualifyTargets([{ format: "lv2", uri }], { rates: [48000], run, env: {}, profiles: [withoutMemoryBudget(OPENMIXER_CONSOLE_PROFILE)], admissions: SKIPPED });
    const pass = qualifyTargets([{ format: "lv2", uri }], { rates: [48000], run, env: {}, profiles: [withoutMemoryBudget(OPENMIXER_CONSOLE_PROFILE)], admissions: refusing });
    const judgment = pass.runs[0]!.judgment;
    expect(judgment.adapter).toMatchObject({ host: "omx-clap-host", admitted: false, code: "omx-clap-host.resp-512" });
    expect(pass.verdicts).toEqual(base.verdicts);
    expect(base.runs[0]!.judgment.adapter).toBeUndefined();
    const record = buildQualificationRecord(judgment, { file: "x.probe.json", sha256: "c".repeat(64), bytes: 1 });
    expect(record.adapter).toMatchObject({ host: "omx-clap-host", measured: true, admitted: false, code: "omx-clap-host.resp-512" });
    expect(tiersOf(judgment).isolated).toMatchObject({ host: "omx-clap-host", measured: true, qualified: false, deciding: "omx-clap-host.resp-512" });
    // sabotage of the rule: the same plugin the adapter takes is judged from its measurement, and qualifies
    expect(tiersOf(base.runs[0]!.judgment).isolated).toMatchObject({ host: "omx-clap-host", qualified: true });
    const clap = fixtureJson("success-msi");
    const clapRun: ProbeRun = (_tool, args) => {
      writeFileSync(args[args.indexOf("--out") + 1]!, JSON.stringify(clap));
      return { status: 0, signal: null };
    };
    const asked: string[] = [];
    const watching: AdmissionRuns = { ...SKIPPED, adapter: (u) => (asked.push(u), { installed: true, steps: [] }) };
    qualifyTargets([{ format: "clap", uri: `urn:clap:${clap.plugin.id}` }], { rates: [48000], run: clapRun, env: {}, profiles: [OPENMIXER_CONSOLE_PROFILE], admissions: watching });
    expect(asked).toEqual([]);
  });

  // Surge XT's LV2 under omx-clap-host 0.25.1 answered add and remove, took notes, and gave -inf dBFS: the admission read it as
  // admitted, and with the measurement behind it the verdict read qualified
  describe("an instrument under a held note", () => {
    const steps = [{ cmd: "add" as const, resp: 0 }, { cmd: "remove" as const, resp: 0 }];
    const output = readFixture("success-msi");
    const lv2 = { ...output, plugin: { ...output.plugin, format: "lv2" as const, id: "urn:x:synth" } };
    const judged = (sound?: ModHostRun["sound"]) =>
      judgeProbeOutput(lv2, [withoutMemoryBudget(OMX_CLAP_HOST_PROFILE)], {
        admissions: { "omx-clap-host": classifyProtocolRun(ADAPTER_HOST, { installed: true, steps, ...(sound === undefined ? {} : { sound }) }) },
      }).hosts[0]!;

    it("one that gives nothing does not read as qualified, and is not refused", () => {
      for (const peak of [0, 1e-7, 1e-6]) {
        const h = judged({ peak });
        expect(h.verdict).toMatchObject({ measured: true, rating: "unknown", qualified: false, deciding: "omx-clap-host.silent-under-note" });
        expect(h.arm).toBe("run");
        expect(pinVerdictOf(h.verdict.rating)).toBeUndefined();
      }
    });
    it("one that sounds qualifies on its measurement", () => {
      expect(judged({ peak: 0.21 }).verdict).toMatchObject({ measured: true, rating: "suitable", qualified: true });
      expect(judged({ peak: 2e-6 }).verdict).toMatchObject({ qualified: true });
    });
    it("a level that could not be read is not read as sound", () => {
      expect(judged({ problem: "no jack_peak" }).verdict).toMatchObject({ rating: "unknown", qualified: false, deciding: "omx-clap-host.level-unmeasured" });
      expect(judged({}).verdict).toMatchObject({ qualified: false, deciding: "omx-clap-host.level-unmeasured" });
    });
    it("a plugin that was not played stands on its measurement", () => {
      expect(judged().verdict).toMatchObject({ rating: "suitable", qualified: true });
    });
    it("a recorded silent run judges the same on a re-judge", () => {
      const silent = classifyProtocolRun(ADAPTER_HOST, { installed: true, steps, sound: { peak: 0 } });
      expect(silent).toMatchObject({ measured: true, admitted: false, code: "omx-clap-host.silent-under-note", params: { peak: 0 } });
      expect(admissionRating({ host: "omx-clap-host", measured: true, admitted: false, code: silent.code!, params: {} })).toBe("unknown");
      expect(admissionRating({ host: "omx-clap-host", measured: true, admitted: false, code: "omx-clap-host.resp-512", params: {} })).toBe("unsuitable");
    });
  });

  describe("tools/mod-host-admit.mjs plays an instrument under a stand-in omx-clap-host", () => {
    const dir = mkdtempSync(join(tmpdir(), "adapter-admit-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const write = (name: string, body: string): string => {
      const p = join(dir, name);
      writeFileSync(p, body);
      chmodSync(p, 0o755);
      return p;
    };
    write(
      "omx-clap-host",
      `#!${process.execPath}
const net = require("node:net");
const fs = require("node:fs");
const port = Number(process.argv[process.argv.indexOf("-p") + 1]);
net.createServer((c) => c.on("data", (d) => {
  const line = d.toString().replace(/\\0$/, "");
  fs.appendFileSync(process.env.STAND_LOG, line + "\\n");
  c.write((line.startsWith("audio_ports") ? 'resp 0 in:main:1:2:stereo:"in":in_1,in_2 out:main:1:2:stereo:"out one":out_1,out_2 out:aux:1:2:stereo:"Scene A":aux_out_1_1,aux_out_1_2' : "resp 0") + "\\0");
})).listen(port, "127.0.0.1");
`,
    );
    write("omx-clap-scan", '#!/bin/sh\nprintf "plugin\\trdf:type\\tlv2:Plugin\\n"\n[ "$STAND_CLASS" = instrument ] && printf "plugin\\trdf:type\\tlv2:InstrumentPlugin\\n"\nexit 0\n');
    const meter = write("jack_peak", '#!/bin/sh\nprintf "%s\\n" "$@" > "$STAND_LOG.ports"\necho ready\ncat > /dev/null\necho "{\\"peak\\":$STAND_PEAK,\\"frames\\":48000}"\n');
    const helper = join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "mod-host-admit.mjs");
    const log = join(dir, "log");
    const admit = (env: Record<string, string>): { run: ModHostRun; sent: string[] } => {
      rmSync(log, { force: true });
      const r = spawnSync(process.execPath, [helper, "urn:x", "omx-clap-host"], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${dir}:${process.env["PATH"]}`, STAND_LOG: log, OMX_JACK_PEAK: meter, STAND_PEAK: "0.2", ...env },
      });
      return { run: JSON.parse(r.stdout) as ModHostRun, sent: readFileSync(log, "utf8").trim().split("\n") };
    };

    it("a note goes in between the add and the remove, every output port is read, and the figure comes back", () => {
      const { run, sent } = admit({ STAND_CLASS: "instrument" });
      expect(sent).toEqual(["add urn:x 0", "audio_ports 0", "note_on 0 0 60 100", "remove 0"]);
      expect(readFileSync(`${log}.ports`, "utf8").trim().split("\n")).toEqual(["effect_0:out_1", "effect_0:out_2", "effect_0:aux_out_1_1", "effect_0:aux_out_1_2"]);
      expect(run).toEqual({ installed: true, steps: [{ cmd: "add", resp: 0 }, { cmd: "remove", resp: 0 }], sound: { peak: 0.2 } });
    });
    it("silence comes back as silence and the run does not admit", () => {
      expect(classifyProtocolRun(ADAPTER_HOST, admit({ STAND_CLASS: "instrument", STAND_PEAK: "0" }).run).code).toBe("omx-clap-host.silent-under-note");
    });
    it("a meter that is not there is said, not taken for sound", () => {
      const { run } = admit({ STAND_CLASS: "instrument", OMX_JACK_PEAK: join(dir, "absent") });
      expect(run.sound?.problem).toBeDefined();
      expect(classifyProtocolRun(ADAPTER_HOST, run).code).toBe("omx-clap-host.level-unmeasured");
    });
    it("a plugin of no instrument class is not played", () => {
      const { run, sent } = admit({ STAND_CLASS: "effect" });
      expect(sent).toEqual(["add urn:x 0", "remove 0"]);
      expect(run.sound).toBeUndefined();
    });
  });

  it("a host that never started (no JACK server) is no evidence: the LV2 omx-clap-host verdict stays the measurement's", () => {
    const run = { installed: true, started: false, steps: [] };
    expect(classifyProtocolRun(ADAPTER_HOST, run)).toMatchObject({ measured: false, admitted: false, code: "omx-clap-host.not-started" });
    expect(classifyModHostRun(run)).toMatchObject({ measured: false, code: "mod-host.not-started" });
    const unstarted = { "omx-clap-host": classifyProtocolRun(ADAPTER_HOST, run) };
    const output = readFixture("success-msi");
    const lv2 = { ...output, plugin: { ...output.plugin, format: "lv2" as const, id: "urn:x:lv2" } };
    const asIf = judgeProbeOutput(lv2, [OMX_CLAP_HOST_PROFILE]);
    const j = judgeProbeOutput(lv2, [OMX_CLAP_HOST_PROFILE], { admissions: unstarted });
    expect(j.hosts[0]!.arm).toBe("declaration");
    expect(j.hosts[0]!.verdict).toEqual(asIf.hosts[0]!.verdict);
  });

  it("decides an asked omx-clap-host verdict of an LV2 plugin by the run, and never a CLAP plugin's", () => {
    const refused = { "omx-clap-host": classifyProtocolRun(ADAPTER_HOST, { installed: true, steps: [{ cmd: "add", resp: -512 }] }) };
    const output = readFixture("success-msi");
    const lv2 = judgeProbeOutput({ ...output, plugin: { ...output.plugin, format: "lv2", id: "urn:x:lv2" } }, [OMX_CLAP_HOST_PROFILE], { admissions: refused });
    expect(lv2.hosts[0]).toMatchObject({ arm: "run", verdict: { host: "omx-clap-host", rating: "unsuitable", qualified: false, deciding: "omx-clap-host.resp-512" } });
    const clap = judgeProbeOutput(output, [OMX_CLAP_HOST_PROFILE], { admissions: refused });
    expect(clap.hosts[0]!.arm).toBe("declaration");
    expect(clap.hosts[0]!.verdict.deciding).not.toBe("omx-clap-host.resp-512");
  });

  it("the spawned run starts omx-clap-host, not mod-host", () => {
    const dir = mkdtempSync(join(tmpdir(), "adapter-admit-"));
    try {
      // a stand-in omx-clap-host that refuses with -512, and a mod-host that would take it
      const stand = (name: string, resp: number) => {
        writeFileSync(join(dir, name), `#!${process.execPath}
const net = require("node:net");
const port = Number(process.argv[process.argv.indexOf("-p") + 1]);
net.createServer((c) => c.on("data", () => c.write("resp ${resp}\\0"))).listen(port, "127.0.0.1");
`);
        chmodSync(join(dir, name), 0o755);
      };
      stand("omx-clap-host", -512);
      stand("mod-host", 0);
      const env = { ...process.env, PATH: `${dir}:${process.env["PATH"]}` };
      expect(classifyProtocolRun(ADAPTER_HOST, SPAWNED_ADMISSIONS.adapter!("urn:x", env)).code).toBe("omx-clap-host.resp-512");
      expect(classifyModHostRun(SPAWNED_ADMISSIONS.modHost("urn:x", env)).admitted).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
