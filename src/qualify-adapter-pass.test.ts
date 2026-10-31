// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * `--adapter-only`, by value, on records a Pi wrote that owe the run. The pass goes through `runSync` with stand-ins for the
 * hosts; the admission tool itself runs against a fake host on the path, so that its timeout, its crash and its limits are
 * the tool's own.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { classifyProtocolRun, type AdmissionRuns, type ModHostRun } from "./host-admission.js";
import { AdapterPassRefused, NO_PRIVATE_SERVER, adapterBlockOf, adapterFinished, hostVersions, parseVersion, type AdapterPassOptions, type PrivateJack } from "./qualify-adapter-pass.js";
import { OWED_CODE, owedFile } from "./qualify-rejudge.js";
import { parseSyncArgs, runSync, summaryLine } from "./qualify-sync.js";
import { CLAP_RT, LV2_CLEAN, LV2_CRASHED, LV2_RT, device, probeFile, readJson, recordFile, rejudge, removeDevices, row, stored, type Device } from "./qualify-rejudge.support.js";

const scratch = mkdtempSync(join(tmpdir(), "qualify-adapter-"));
afterAll(() => {
  removeDevices();
  rmSync(scratch, { recursive: true, force: true });
});

const VERSIONS = { "omx-clap-host": "0.25.1", "plugin-hostd": "0.15.3" };
const admitted: ModHostRun = { installed: true, steps: [{ cmd: "add", resp: 0 }, { cmd: "remove", resp: 0 }] };

interface Seen { uri: string; env: Readonly<Record<string, string | undefined>> }

/** The pass's hosts as stand-ins: `answer` says how a plugin's run goes at a quantum, `seen` what each was started with. */
function stand(seen: Seen[], answer: (uri: string, quantum: number) => ModHostRun = () => admitted, over: Partial<AdapterPassOptions> = {}): AdapterPassOptions {
  const quantumOf = (name: string | undefined): number => Number(name?.split("-").at(-1));
  const runs: AdmissionRuns = {
    modHost: () => { throw new Error("mod-host is not this pass's"); },
    jalv: () => { throw new Error("jalv is not this pass's"); },
    adapter: (uri, env) => {
      seen.push({ uri, env: env ?? {} });
      return answer(uri, quantumOf(env?.["JACK_DEFAULT_SERVER"]));
    },
  };
  const jack = (cell: { quantum: number }): PrivateJack => ({ name: `private-${String(cell.quantum)}`, alive: () => true, stop: () => {} });
  return { runs, jack, jackdPresent: true, versions: (tool) => ({ status: 0, stdout: `${tool} version: ${tool.includes("omx-clap") ? VERSIONS["omx-clap-host"] : VERSIONS["plugin-hostd"]}\n` }), now: () => "2026-10-31T02:00:00.000Z", ...over };
}

const pass = (d: Device, options: AdapterPassOptions, force = false) => runSync(d.settings, { adapterOnly: true, force, env: {}, adapterPass: options, pinFilesRun: () => ({ status: 1, stdout: "", stderr: "" }) });
const bytes = (d: Device, stem: string): Buffer => readFileSync(join(d.dir, recordFile(stem)));

describe("--adapter-only: the run", () => {
  it("runs each cell of a Pi, each on its private server, under the budget, never the device's own", async () => {
    const d = device([LV2_CLEAN]);
    const seen: Seen[] = [];
    await pass(d, stand(seen));
    expect(seen.map((s) => s.env["JACK_DEFAULT_SERVER"])).toEqual(["private-128", "private-256"]);
    for (const s of seen) {
      expect(s.uri).toBe(stored(LV2_CLEAN).plugin.id);
      expect(s.env).toMatchObject({ JACK_NO_START_SERVER: "1", OMX_ADMIT_STEP_MS: "17000", LV2_PATH: d.settings.lv2Dirs.join(":") });
      expect(Number(s.env["OMX_ADMIT_ADDRESS_KB"])).toBeGreaterThan(0);
      expect(s.env["OMX_ADMIT_STATE_DIR"]).toContain("plugin-qualify-adapter-state-");
    }
    expect(seen[0]!.env["OMX_ADMIT_STATE_DIR"]).not.toBe(seen[1]!.env["OMX_ADMIT_STATE_DIR"]);
  });

  it("writes the block with the hosts' versions and each cell, and leaves every other byte of the record", async () => {
    const d = device([LV2_CLEAN]);
    const was = bytes(d, LV2_CLEAN).toString();
    const copy = readFileSync(join(d.dir, probeFile(LV2_CLEAN)));
    const summary = await pass(d, stand([]));
    const now = d.record(LV2_CLEAN);
    expect(now.adapter).toEqual({
      host: "omx-clap-host",
      measured: true,
      admitted: true,
      params: {},
      versions: VERSIONS,
      measuredAt: "2026-10-31T02:00:00.000Z",
      cells: [
        { rate: 48000, quantum: 128, measured: true, admitted: true, params: {} },
        { rate: 48000, quantum: 256, measured: true, admitted: true, params: {} },
      ],
    });
    const { adapter: _adapter, ...rest } = now;
    expect(`${JSON.stringify(rest, null, 2)}\n`).toBe(was);
    expect(readFileSync(join(d.dir, probeFile(LV2_CLEAN))).equals(copy)).toBe(true);
    expect(summary!.adapterOnly).toEqual({ measured: 1, already: 0, failed: 0 });
    expect(summaryLine(summary!)).toContain("adapter run 1, already 0, failed 0");
  });

  it("does not touch a CLAP plugin, or one whose probe failed: no run could decide its verdict", async () => {
    const d = device([CLAP_RT, LV2_CRASHED]);
    const before = [bytes(d, CLAP_RT), bytes(d, LV2_CRASHED)];
    const seen: Seen[] = [];
    await pass(d, stand(seen));
    expect(seen).toEqual([]);
    expect([bytes(d, CLAP_RT), bytes(d, LV2_CRASHED)]).toEqual(before);
  });

  it("does not touch a plugin whose bytes changed", async () => {
    const d = device([LV2_CLEAN]);
    const before = bytes(d, LV2_CLEAN);
    writeFileSync(join(Object.values(d.state().entries)[0]!.root, "plugin.bin"), "another build");
    const seen: Seen[] = [];
    await pass(d, stand(seen));
    expect(seen).toEqual([]);
    expect(bytes(d, LV2_CLEAN).equals(before)).toBe(true);
  });
});

describe("--adapter-only: a crash or a timeout is a recorded outcome", () => {
  it("a crash at one cell decides the block, with its cell, and the next plugin still runs", async () => {
    const d = device([LV2_CLEAN, LV2_RT]);
    const crash: ModHostRun = { installed: true, steps: [{ cmd: "add", died: "SIGSEGV" }] };
    const summary = await pass(d, stand([], (uri, q) => (uri === stored(LV2_CLEAN).plugin.id && q === 256 ? crash : admitted)));
    const a = d.record(LV2_CLEAN).adapter!;
    expect(a).toMatchObject({ measured: true, admitted: false, code: "omx-clap-host.signal-SIGSEGV", params: { rate: 48000, quantum: 256 } });
    expect(a.cells!.map((c) => [c.quantum, c.admitted])).toEqual([[128, true], [256, false]]);
    expect(d.record(LV2_RT).adapter).toMatchObject({ measured: true, admitted: true });
    expect(summary!.adapterOnly).toEqual({ measured: 2, already: 0, failed: 0 });
  });

  it("a command with no answer in time is recorded the same", async () => {
    const d = device([LV2_CLEAN]);
    await pass(d, stand([], () => ({ installed: true, steps: [{ cmd: "add" }] })));
    expect(d.record(LV2_CLEAN).adapter).toMatchObject({ measured: true, admitted: false, code: "omx-clap-host.no-answer", params: { step: "add", quantum: 128 } });
  });

  it("a host that could not be run decides nothing: not measured, still owed, and tried again", async () => {
    const d = device([LV2_CLEAN]);
    const summary = await pass(d, stand([], () => ({ installed: true, started: false, steps: [] })));
    expect(d.record(LV2_CLEAN).adapter).toMatchObject({ measured: false, admitted: false, code: "omx-clap-host.not-started" });
    expect(summary!.adapterOnly).toEqual({ measured: 0, already: 0, failed: 1 });
    await rejudge(d);
    expect(row(d.record(LV2_CLEAN), "omx-clap-host")).toMatchObject({ rating: "unknown", deciding: OWED_CODE.adapterRun });
    const seen: Seen[] = [];
    await pass(d, stand(seen));
    expect(seen.length).toBe(2);
    expect(d.record(LV2_CLEAN).adapter).toMatchObject({ measured: true, admitted: true });
  });

  it("a cell no private server came up for is not measured either, and a refusal elsewhere still decides", () => {
    const off = { host: "omx-clap-host" as const, measured: false, admitted: false, code: NO_PRIVATE_SERVER, params: {} };
    const no = { host: "omx-clap-host" as const, measured: true, admitted: false, code: "omx-clap-host.resp-512", params: {} };
    const cell = (quantum: number) => ({ rate: 48000, quantum });
    expect(adapterBlockOf([{ cell: cell(128), run: off }, { cell: cell(256), run: { ...off, admitted: true, measured: true, code: undefined as never } }], VERSIONS, "t")).toMatchObject({ measured: false, code: NO_PRIVATE_SERVER });
    expect(adapterBlockOf([{ cell: cell(128), run: off }, { cell: cell(256), run: no }], VERSIONS, "t")).toMatchObject({ measured: true, admitted: false, code: "omx-clap-host.resp-512" });
  });
});

describe("--adapter-only: resuming", () => {
  it("does not redo a finished plugin, not even a refused one: the record the same bytes", async () => {
    const d = device([LV2_CLEAN, LV2_RT]);
    const refuse: ModHostRun = { installed: true, steps: [{ cmd: "add", resp: -512 }] };
    await pass(d, stand([], (uri) => (uri === stored(LV2_RT).plugin.id ? refuse : admitted)));
    const before = [bytes(d, LV2_CLEAN), bytes(d, LV2_RT)];
    const seen: Seen[] = [];
    const again = await pass(d, stand(seen));
    expect(seen).toEqual([]);
    expect(again!.adapterOnly).toEqual({ measured: 0, already: 2, failed: 0 });
    expect([bytes(d, LV2_CLEAN), bytes(d, LV2_RT)]).toEqual(before);
    await pass(d, stand(seen), true);
    expect(seen.length).toBe(4);
  });

  it("a run cut short keeps what it finished, and the next pass does only the rest", async () => {
    const d = device([LV2_CLEAN, LV2_RT]);
    const order: string[] = [];
    const cut = stand([], (uri) => {
      order.push(uri);
      if (order.length > 2) throw new Error("cut");
      return admitted;
    });
    // the first plugin's two cells finish; the second's run breaks, which reads as not measured
    await pass(d, cut);
    const first = order[0]!;
    const finished = [LV2_CLEAN, LV2_RT].find((s) => stored(s).plugin.id === first)!;
    const other = finished === LV2_CLEAN ? LV2_RT : LV2_CLEAN;
    expect(d.record(finished).adapter!.measured).toBe(true);
    expect(d.record(other).adapter!.measured).toBe(false);
    const seen: Seen[] = [];
    await pass(d, stand(seen));
    expect(new Set(seen.map((s) => s.uri))).toEqual(new Set([stored(other).plugin.id]));
  });

  it("a host upgrade unfinishes it: a block is only as good as the versions it says", async () => {
    const d = device([LV2_CLEAN]);
    await pass(d, stand([]));
    expect(adapterFinished(d.record(LV2_CLEAN), VERSIONS)).toBe(true);
    expect(adapterFinished(d.record(LV2_CLEAN), { ...VERSIONS, "omx-clap-host": "0.26.0" })).toBe(false);
    const seen: Seen[] = [];
    await pass(d, stand(seen, () => admitted, { versions: (tool) => ({ status: 0, stdout: `x version: ${tool.includes("omx-clap") ? "0.26.0" : "0.15.3"}\n` }) }));
    expect(seen.length).toBe(2);
    expect(d.record(LV2_CLEAN).adapter!.versions).toEqual({ "omx-clap-host": "0.26.0", "plugin-hostd": "0.15.3" });
  });

  it("a block from before, with no versions, is taken again", async () => {
    const d = device([LV2_CLEAN], { patch: (r) => ({ ...r, adapter: { host: "omx-clap-host", measured: true, admitted: true, params: {} } }) });
    const seen: Seen[] = [];
    await pass(d, stand(seen));
    expect(seen.length).toBe(2);
  });
});

describe("--adapter-only: it starts only when it can say what it runs under", () => {
  it("a host that names no version: refused before anything runs, nothing written", async () => {
    const d = device([LV2_CLEAN]);
    const before = bytes(d, LV2_CLEAN);
    const seen: Seen[] = [];
    await expect(pass(d, stand(seen, () => admitted, { versions: (tool) => (tool.includes("omx-clap") ? { status: 127, stdout: "" } : { status: 0, stdout: "plugin-hostd version: 0.15.3\n" }) }))).rejects.toBeInstanceOf(AdapterPassRefused);
    expect(seen).toEqual([]);
    expect(bytes(d, LV2_CLEAN).equals(before)).toBe(true);
  });

  it("no jackd: refused, naming why, and the device's server is not used instead", async () => {
    const d = device([LV2_CLEAN]);
    const seen: Seen[] = [];
    await expect(pass(d, stand(seen, () => admitted, { jackdPresent: false }))).rejects.toThrow(NO_PRIVATE_SERVER);
    expect(seen).toEqual([]);
  });

  it("reads the versions as the hosts print them", () => {
    expect(parseVersion("omx-clap-host version: 0.24.3\n")).toBe("0.24.3");
    expect(parseVersion("plugin-hostd version: 0.15.1")).toBe("0.15.1");
    expect(parseVersion("no such thing")).toBeUndefined();
    expect(hostVersions({ PLUGIN_HOSTD: "/opt/hostd" }, (t) => ({ status: 0, stdout: `${t} version: 1.2.3` }))).toEqual({ ok: true, versions: { "omx-clap-host": "1.2.3", "plugin-hostd": "1.2.3" } });
  });
});

describe("--adapter-only then --rejudge", () => {
  it("clears the owed list and gives real LV2 verdicts: admitted is suitable, RT-unsafe runs alone, a crash is refused", async () => {
    const crashed = stored(LV2_RT).plugin.id;
    const d = device([LV2_CLEAN, LV2_RT]);
    await rejudge(d);
    expect(readJson<{ owing: unknown[] }>(owedFile(d.settings.stateFile)).owing.length).toBe(2);
    expect(row(d.record(LV2_CLEAN), "omx-clap-host").rating).toBe("unknown");
    await pass(d, stand([]));
    const summary = await rejudge(d);
    expect(readJson<{ owing: unknown[] }>(owedFile(d.settings.stateFile)).owing).toEqual([]);
    expect(summary!.rejudge!.owing).toBe(0);
    const clean = d.record(LV2_CLEAN);
    expect(row(clean, "omx-clap-host")).toMatchObject({ rating: "suitable", qualified: true, arm: "run" });
    expect(clean.tiers.offeredOn).toEqual(["isolated"]);
    expect(clean.rejudged!.figures.adapter).toEqual({ versions: VERSIONS, measuredAt: "2026-10-31T02:00:00.000Z" });
    expect(clean.rejudged!.owes).toBeUndefined();
    const unsafe = d.record(LV2_RT);
    expect(row(unsafe, "omx-clap-host")).toMatchObject({ rating: "conditional", arm: "run", hosting: "isolated" });
    expect(unsafe.tiers.isolated).toMatchObject({ runsAlone: true });
    expect(unsafe.tiers.offeredOn).toEqual(["isolated"]);
    expect(d.pins().map((p) => [p!.uri, p!.verdict]).sort()).toEqual([[crashed, "isolated"], [stored(LV2_CLEAN).plugin.id, "in-process"]].sort());

    const e = device([LV2_CLEAN]);
    await pass(e, stand([], () => ({ installed: true, steps: [{ cmd: "add", died: "SIGSEGV" }] })));
    await rejudge(e);
    expect(row(e.record(LV2_CLEAN), "omx-clap-host")).toMatchObject({ rating: "unsuitable", arm: "run", deciding: "omx-clap-host.signal-SIGSEGV" });
    expect(e.record(LV2_CLEAN).tiers.offeredOn).toEqual([]);
    expect(e.pins()[0]!.verdict).toBe("refused");
    const again = await rejudge(e);
    expect(again!.rejudge).toMatchObject({ changed: 0, owing: 0 });
  });
});

describe("the flag", () => {
  it("goes with --force, and with no other run", () => {
    expect(parseSyncArgs(["--adapter-only"])).toMatchObject({ ok: true, args: { adapterOnly: true } });
    expect(parseSyncArgs(["--adapter-only", "--force"])).toMatchObject({ ok: true, args: { adapterOnly: true, force: true } });
    for (const other of ["--rejudge", "--memory-only", "--refresh-pins"]) expect(parseSyncArgs(["--adapter-only", other]).ok).toBe(false);
  });
});

// --- the admission tool, against a fake host ------------------------------------------------------------------------

const TOOL = fileURLToPath(new URL("../tools/mod-host-admit.mjs", import.meta.url));

/** A fake `omx-clap-host` on a path of its own: a node script speaking the protocol as `behaviour` says, noting how it was started. */
function fakeHost(behaviour: "answers" | "hangs" | "crashes" | "address"): { path: string; dir: string } {
  const dir = mkdtempSync(join(scratch, "host-"));
  const script = join(dir, "omx-clap-host");
  writeFileSync(
    script,
    `#!${process.execPath}
const net = require("node:net");
const fs = require("node:fs");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("-p") + 1]);
fs.writeFileSync(${JSON.stringify(join(dir, "started"))}, JSON.stringify({ args, pid: process.pid, limit: fs.readFileSync("/proc/self/limits", "utf8").split("\\n").find((l) => l.startsWith("Max address space")) }));
net.createServer((s) => s.on("data", (d) => {
  if (${JSON.stringify(behaviour)} === "hangs") return;
  if (${JSON.stringify(behaviour)} === "crashes") process.kill(process.pid, "SIGSEGV");
  s.write("resp 0\\0");
})).listen(port, "127.0.0.1");
setInterval(() => {}, 1000);
`,
  );
  chmodSync(script, 0o755);
  return { path: `${dir}:${process.env["PATH"] ?? ""}`, dir };
}

function admit(behaviour: Parameters<typeof fakeHost>[0], env: Record<string, string> = {}) {
  const host = fakeHost(behaviour);
  const started = Date.now();
  const r = spawnSync(process.execPath, [TOOL, "urn:x", "omx-clap-host"], { encoding: "utf8", env: { ...process.env, PATH: host.path, ...env } });
  expect(r.status, r.stderr).toBe(0);
  return { run: JSON.parse(r.stdout) as ModHostRun, ms: Date.now() - started, dir: host.dir };
}

describe("the admission tool under an adapter-only pass's limits", () => {
  it("a host that does not answer gets the budget it was given, is recorded, and is gone afterwards", () => {
    const { run, ms, dir } = admit("hangs", { OMX_ADMIT_STEP_MS: "700" });
    expect(run.steps).toEqual([{ cmd: "add" }]);
    expect(classifyProtocolRun("omx-clap-host", run)).toMatchObject({ measured: true, admitted: false, code: "omx-clap-host.no-answer" });
    expect(ms).toBeLessThan(5000);
    const { pid } = JSON.parse(readFileSync(join(dir, "started"), "utf8")) as { pid: number };
    expect(existsSync(`/proc/${String(pid)}`) && !/\) Z/.test(readFileSync(`/proc/${String(pid)}/stat`, "utf8"))).toBe(false);
  }, 20000);

  it("a host that crashes on the plugin is recorded with the signal", () => {
    const { run } = admit("crashes", { OMX_ADMIT_STEP_MS: "3000" });
    expect(classifyProtocolRun("omx-clap-host", run)).toMatchObject({ measured: true, admitted: false, code: "omx-clap-host.signal-SIGSEGV" });
  }, 20000);

  it("the address space and the state directory reach the host", () => {
    const state = join(mkdtempSync(join(scratch, "state-")), "s");
    mkdirSync(state);
    const { run, dir } = admit("answers", { OMX_ADMIT_ADDRESS_KB: String(64 * 1024 * 1024), OMX_ADMIT_STATE_DIR: state });
    expect(run.steps).toEqual([{ cmd: "add", resp: 0 }, { cmd: "remove", resp: 0 }]);
    const started = JSON.parse(readFileSync(join(dir, "started"), "utf8")) as { args: string[]; limit: string };
    expect(started.args).toEqual(expect.arrayContaining(["-s", state]));
    expect(started.limit.split(/\s+/)[3]).toBe(String(64 * 1024 * 1024 * 1024));
  }, 20000);

  it("a host not installed says so, with or without a limit, and is not a refusal", () => {
    for (const env of [{}, { OMX_ADMIT_ADDRESS_KB: "1048576" }]) {
      const r = spawnSync(process.execPath, [TOOL, "urn:x", "/nonexistent/omx-clap-host"], { encoding: "utf8", env: { ...process.env, ...env } });
      expect(JSON.parse(r.stdout)).toMatchObject({ installed: false });
    }
  }, 20000);
});
