// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * `plugin-qualify-sync`, end to end. The pure tests need no binary: the settings, the manifest reader, the file set.
 * The pin file is killed mid-write in a process of its own. The sweep runs the real entry point over a tree of the
 * repo's fixtures (a good CLAP, one that crashes at load, one that hangs, an LV2 bundle) through plugin-hostd's probe
 * runner, and then plugin-hostd itself, in its default mode, is started on the pin file the sweep wrote: a qualified
 * plugin is added and two are chained. The sweep needs the native build and `plugin-hostd-probe`; the daemon test
 * also needs plugin-hostd, omx-clap-host and jackd (a dummy server). Off CI each skips visibly without them; under
 * CI their absence fails the test.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { launchDaemon, startDaemon, type RunningDaemon } from "./hostd-daemon.support.js";
import { manifestPlugins } from "./lv2-loader.js";
import { parsePinLine } from "./pins-file.js";
import {
  SYNC_SETTINGS,
  ZYNTHIAN_LV2_DIRS,
  changedPinLines,
  digestFiles,
  discoverSyncItems,
  fileSha256,
  flagOf,
  parseSyncArgs,
  parseSyncConf,
  pendingMarker,
  runSync,
  resolveSyncSettings,
  type SyncSettings,
  type SyncState,
} from "./qualify-sync.js";
import { clapQualifyToolPath, lv2MeasureNativePath, rtInterposePath } from "./tool-paths.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(PKG, "native", "build", "fixtures");
const FAULTY = join(PKG, "native", "build", "fixtures-faulty");
const SYNC = join(PKG, "bin", "plugin-qualify-sync.mjs");
const GOOD_ID = "org.freemixer.plugin-qualify.fixture.rt-safe";
const LV2_URI = "urn:plugin-qualify:fixture:lv2-rt-safe";

const scratch = mkdtempSync(join(tmpdir(), "qualify-sync-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const which = (name: string): string | undefined => {
  const r = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
};
const RUNNER = process.env["OMX_PROBE_RUNNER"] || which("plugin-hostd-probe");
const HOSTD = process.env["PLUGIN_HOSTD"] || which("plugin-hostd");
const CLAP_HOST = which("omx-clap-host");
const JACKD = which("jackd");
const BUILT = [clapQualifyToolPath(), rtInterposePath(), lv2MeasureNativePath(), join(FIXTURES, "rt-safe.clap"), ...["crashes-at-load", "hangs"].map((f) => join(FAULTY, `${f}.clap`))].every((p) =>
  existsSync(p),
);

/** A test that needs tools: run when they are there, skipped by name off CI, failed under CI. */
function needs(what: Record<string, boolean>, name: string, body: () => void | Promise<void>, timeout = 120_000): void {
  it(
    name,
    async (ctx) => {
      const missing = Object.entries(what).filter(([, ok]) => !ok).map(([n]) => n);
      if (missing.length > 0) {
        if (process.env["CI"]) throw new Error(`needed and missing under CI: ${missing.join(", ")}`);
        ctx.skip(`needs ${missing.join(", ")}`);
      }
      await body();
    },
    timeout,
  );
}

// --- the settings -----------------------------------------------------------------------------------------------------

describe("the settings", () => {
  it("are read from key value lines, a comment dropped, an unknown key refused by line", () => {
    const ok = parseSyncConf("# Zynthian\nlv2_extra /a:/b   # two\n\nbudget_s 30\n");
    expect(ok.ok && [...ok.values]).toEqual([
      ["lv2_extra", "/a:/b"],
      ["budget_s", "30"],
    ]);
    const bad = parseSyncConf("budget_s 30\npin_flie /x\n", "q.conf");
    expect(bad.ok ? "" : bad.error).toBe("q.conf:2: pin_flie is not a setting");
  });

  it("every setting is a flag, and a flag holds over the file", () => {
    for (const s of SYNC_SETTINGS) expect(parseSyncArgs([flagOf(s.key), "v"]).ok).toBe(true);
    const args = parseSyncArgs(["--budget-s", "9", "--system"]);
    if (!args.ok) throw new Error(args.error);
    const r = resolveSyncSettings(new Map([["budget_s", "30"], ["lv2_extra", ""]]), args.args, { LV2_PATH: "/x/lv2" }, "/home/u");
    if (!r.ok) throw new Error(r.error);
    expect(r.settings.budgetS).toBe(9);
    expect(r.settings.lv2Dirs).toEqual(["/x/lv2"]);
    expect(r.settings.pinFile).toBe("/var/lib/omx/qualified.pins");
    expect(r.settings.qualificationDir).toBe("/var/lib/omx/qualification");
    expect(r.settings.descriptorDir).toBe("/var/lib/omx/descriptors");
    expect(r.settings.hostProfile.id).toBe("omx-clap-host");
  });

  it("defaults: plugin-hostd's LV2 directories then Zynthian's, the CLAP path, a 60 s budget, port 5555", () => {
    const args = parseSyncArgs([]);
    if (!args.ok) throw new Error(args.error);
    const r = resolveSyncSettings(new Map(), args.args, {}, "/home/u");
    if (!r.ok) throw new Error(r.error);
    expect(r.settings.lv2Dirs).toEqual(["/usr/lib64/lv2", "/usr/lib/lv2", "/usr/local/lib/lv2", "/zynthian/zynthian-plugins/lv2", "/zynthian/zynthian-my-data/plugins/lv2"]);
    expect(r.settings.clapDirs).toEqual(["/home/u/.clap", "/usr/lib/clap"]);
    expect([r.settings.budgetS, r.settings.hostdPort, r.settings.hostdFeedbackPort, r.settings.settleS]).toEqual([60, 5555, 5556, 0]);
    expect(r.settings.pinFile).toBe("/home/u/.local/state/omx/qualified.pins");
  });

  it("the grid is the full one by default, hosts (also --grid-hosts) or named cells when set, with a cell budget and a memory bound (#193)", () => {
    const args = parseSyncArgs([]);
    if (!args.ok) throw new Error(args.error);
    const d = resolveSyncSettings(new Map(), args.args, {}, "/home/u");
    if (!d.ok) throw new Error(d.error);
    expect(d.settings.grid).toEqual({ kind: "full" });
    const fast = parseSyncArgs(["--grid-hosts"]);
    if (!fast.ok) throw new Error(fast.error);
    const h = resolveSyncSettings(new Map(), fast.args, {}, "/home/u");
    expect(h.ok && h.settings.grid).toEqual({ kind: "hosts" });
    expect(d.settings.cellsPerPluginBudget).toBe(0);
    expect(d.settings.memory?.bytes).toBeGreaterThan(0);
    const set = resolveSyncSettings(new Map([["grid", "48000/128,96000/1024"], ["cells_per_plugin_budget", "2"], ["memory_limit", "1G"]]), args.args, {}, "/home/u");
    if (!set.ok) throw new Error(set.error);
    expect(set.settings.grid).toEqual({ kind: "cells", cells: [{ rate: 48000, quantum: 128 }, { rate: 96000, quantum: 1024 }] });
    expect(set.settings.cellsPerPluginBudget).toBe(2);
    expect(set.settings.memory).toEqual({ bytes: 2 ** 30, mechanism: "rlimit-data" });
    const off = resolveSyncSettings(new Map([["memory_limit", "off"], ["grid", "full"]]), args.args, {}, "/home/u");
    expect(off.ok && off.settings.memory).toBeUndefined();
    expect(off.ok && off.settings.grid).toEqual({ kind: "full" });
    for (const [k, v] of [["grid", "48000"], ["cells_per_plugin_budget", "1.5"], ["memory_limit", "much"]] as const) {
      expect(resolveSyncSettings(new Map([[k, v]]), args.args, {}).ok, k).toBe(false);
    }
  });

  it("a budget, a port or a host that is not one is refused, never defaulted", () => {
    const args = parseSyncArgs([]);
    if (!args.ok) throw new Error(args.error);
    for (const [k, v] of [["budget_s", "0"], ["hostd_port", "70000"], ["host_profile", "nobody"]] as const) {
      expect(resolveSyncSettings(new Map([[k, v]]), args.args, {}).ok).toBe(false);
    }
  });
});

describe("the units the packages ship", () => {
  const unit = (name: string): string => readFileSync(join(PKG, "packaging", "systemd", name), "utf8");

  it("the service runs the sync as a system service, with flags the sync takes, and never in the audio's way", () => {
    const service = unit("plugin-qualify-sync.service");
    const exec = /^ExecStart=(\S+) (\S+) (.*)$/m.exec(service)!;
    // the interpreter first, the script as its argument: a service that executes the node script itself stays in
    // systemd's own SELinux domain on Fedora, which has no executable memory for V8 and no /tmp, and dies at start (#188)
    expect(exec[1]).toBe("/usr/bin/node");
    expect(exec[2]).toBe("/usr/bin/plugin-qualify-sync");
    expect(parseSyncArgs(exec[3]!.split(" ")).ok).toBe(true);
    expect(exec[3]).toContain("--system");
    for (const line of ["Type=oneshot", "Nice=19", "IOSchedulingClass=idle", "StateDirectory=omx"]) expect(service).toContain(line);
    expect(service).toMatch(/^CPUQuota=\d+%$/m);
    expect(service).toMatch(/^TimeoutStartSec=\S+$/m);
    // started by its timer and its path unit only: no boot target waits for it
    expect(service).not.toContain("[Install]");
  });

  it("the timer is wanted by timers.target and the path unit by paths.target, and both start the service", () => {
    expect(unit("plugin-qualify-sync.timer")).toMatch(/OnBootSec=\S+[\s\S]*Unit=plugin-qualify-sync\.service[\s\S]*WantedBy=timers\.target/);
    expect(unit("plugin-qualify-sync.path")).toMatch(/Unit=plugin-qualify-sync\.service[\s\S]*WantedBy=paths\.target/);
    // OnUnitInactiveSec is a rescan on top of the first-boot run: an upgrade of an unpackaged bundle in place is
    // not a change of the watched folder the path unit sees, so only this periodic run notices it (plugin-qualify#178).
    expect(unit("plugin-qualify-sync.timer")).toMatch(/^OnBootSec=2min$/m);
    expect(unit("plugin-qualify-sync.timer")).toMatch(/^OnUnitInactiveSec=15min$/m);
    expect(unit("80-plugin-qualify.preset").split("\n").filter((l) => l.startsWith("enable "))).toEqual([
      "enable plugin-qualify-sync.timer",
      "enable plugin-qualify-sync.path",
    ]);
  });

  it("the path unit watches every standard directory a system service searches by default; the directories it adds come from the settings file", () => {
    const watched = [...unit("plugin-qualify-sync.path").matchAll(/^PathChanged=(.*)$/gm)].map((m) => m[1]);
    const args = parseSyncArgs(["--system"]);
    if (!args.ok) throw new Error(args.error);
    const r = resolveSyncSettings(new Map(), args.args, {}, "/root");
    if (!r.ok) throw new Error(r.error);
    // the sync's own default for lv2_extra (Zynthian's two) is a setting, not a standard folder: the generated drop-in carries it
    for (const dir of [...r.settings.lv2Dirs.filter((d) => !ZYNTHIAN_LV2_DIRS.includes(d)), ...r.settings.clapDirs.filter((d) => !d.startsWith("/root"))]) expect(watched).toContain(dir);
  });

  it("the settings file names only settings", () => {
    const text = readFileSync(join(PKG, "packaging", "qualify.conf"), "utf8");
    expect(parseSyncConf(text).ok).toBe(true);
    const commented = [...text.matchAll(/^#([a-z_]+)(?:\s|$)/gm)].map((m) => m[1]);
    for (const key of commented) expect(SYNC_SETTINGS.map((s) => s.key)).toContain(key);
  });
});

// --- the manifest and the file set --------------------------------------------------------------------------------

describe("a manifest's plugins and their files", () => {
  it("are the subjects typed lv2:Plugin, with their lv2:binary and rdfs:seeAlso files, prefixed or not", () => {
    const ttl = `@prefix lv2: <http://lv2plug.in/ns/lv2core#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
# a comment with <angle> brackets
<urn:a> a lv2:Plugin ; lv2:binary <a.so> ; rdfs:seeAlso <a.ttl> , <./presets.ttl> .
<urn:b> a <http://lv2plug.in/ns/lv2core#Plugin> ;
  <http://lv2plug.in/ns/lv2core#binary> <b.so> ;
  rdfs:seeAlso <http://example.org/remote.ttl> ;
  lv2:port [ a lv2:InputPort ; rdfs:seeAlso <inner.ttl> ] .
<urn:preset> a <http://lv2plug.in/ns/ext/presets#Preset> ; rdfs:seeAlso <p.ttl> .
`;
    expect(manifestPlugins(ttl)).toEqual([
      { uri: "urn:a", files: ["a.so", "a.ttl", "presets.ttl"], binary: "a.so" },
      { uri: "urn:b", files: ["b.so"], binary: "b.so" },
    ]);
  });
});

describe("the file set", () => {
  it("is each file's SHA-256, read again only when its size, time or inode moved", () => {
    const dir = mkdtempSync(join(scratch, "set-"));
    writeFileSync(join(dir, "x.clap"), "one");
    const first = digestFiles(dir, ["x.clap"])!;
    expect(first[0]!.sha256).toBe(fileSha256(join(dir, "x.clap")));
    // the same size, time and inode on purpose: the stat says unchanged, and the digest is not taken again
    utimesSync(join(dir, "x.clap"), 1_700_000_000, 1_700_000_000);
    const stamped = digestFiles(dir, ["x.clap"])!;
    writeFileSync(join(dir, "x.clap"), "two");
    utimesSync(join(dir, "x.clap"), 1_700_000_000, 1_700_000_000);
    expect(digestFiles(dir, ["x.clap"], stamped)![0]!.sha256).toBe(first[0]!.sha256);
    expect(digestFiles(dir, ["x.clap"])![0]!.sha256).not.toBe(first[0]!.sha256);
    expect(digestFiles(dir, ["gone.clap"])).toBeUndefined();
  });

  it("changedPinLines names a new pin and a changed one, not one held as it is", () => {
    const a = "pin_set urn:a a.so=" + "1".repeat(64) + " omx-layout/1:" + "2".repeat(64);
    const b = "pin_set urn:b b.so=" + "1".repeat(64) + " omx-layout/1:" + "2".repeat(64);
    const b2 = `${b} verdict=in-process`;
    expect(changedPinLines(`# c\n${a}\n${b}\n`, `# c\n${a}\n${b2}\n`)).toEqual([b2]);
    expect(changedPinLines("", `${a}\n`)).toEqual([a]);
  });
});

// --- the pin file, killed mid-write -------------------------------------------------------------------------------

describe("the pin file", () => {
  it("is the old file or the whole new one when its writer is killed mid-write, never a half", async () => {
    const dir = mkdtempSync(join(scratch, "kill-"));
    const target = join(dir, "qualified.pins");
    const writer = join(dir, "writer.mjs");
    // 32 MiB of pin-shaped lines, enough that the write spans many pieces and the kill lands inside it
    const line = `pin_set urn:x x.so=${"a".repeat(64)} omx-layout/1:${"b".repeat(64)} verdict=in-process\n`;
    const lines = Math.ceil((32 << 20) / line.length);
    writeFileSync(
      writer,
      `import { writeFileWhole } from ${JSON.stringify(join(PKG, "dist", "whole-file.js"))};\n` +
        `const text = ${JSON.stringify(line)}.repeat(${String(lines)});\n` +
        `process.stdout.write("go\\n");\nwriteFileWhole(${JSON.stringify(target)}, text);\nprocess.stdout.write("done\\n");\n`,
    );
    const whole = line.length * lines;
    const run = (killAfterMs: number | undefined): Promise<{ killed: boolean; ms: number; pendingSeen: boolean }> =>
      new Promise((resolve) => {
        const child: ChildProcess = spawn(process.execPath, [writer], { stdio: ["ignore", "pipe", "inherit"] });
        let started = 0;
        let pendingSeen = false;
        child.stdout!.on("data", (d: Buffer) => {
          if (!d.toString().includes("go") || started !== 0) return;
          started = Date.now();
          if (killAfterMs !== undefined)
            setTimeout(() => {
              pendingSeen = existsSync(`${target}.new`);
              child.kill("SIGKILL");
            }, killAfterMs);
        });
        child.once("exit", (_code, signal) => resolve({ killed: signal === "SIGKILL", ms: Date.now() - started, pendingSeen }));
      });
    writeFileSync(target, "old\n");
    const timed = await run(undefined);
    expect(statSync(target).size).toBe(whole);
    let midWrite = 0;
    for (let i = 0; i < 12; i++) {
      writeFileSync(target, "old\n");
      const r = await run(Math.floor((timed.ms * i) / 12));
      const size = statSync(target).size;
      // the only two states a reader may see
      expect(size === 4 || size === whole, `kill ${String(i)} left ${String(size)} bytes`).toBe(true);
      if (size === 4) expect(readFileSync(target, "utf8")).toBe("old\n");
      if (r.killed && r.pendingSeen) midWrite++;
    }
    // the kill landed while the bytes were going out at least once, so the test saw what it claims to
    expect(midWrite).toBeGreaterThan(0);
  }, 120_000);
});

// --- the sweep over the fixtures ----------------------------------------------------------------------------------

/** The machine the sweep runs on: a CLAP directory, an LV2 one, and where its outputs go. */
function machine(): { root: string; clap: string; lv2: string; out: string; flags: (port?: number, feedbackPort?: number) => string[] } {
  const root = mkdtempSync(join(scratch, "machine-"));
  const clap = join(root, "clap");
  const lv2 = join(root, "lv2");
  mkdirSync(clap);
  mkdirSync(lv2);
  copyFileSync(join(FIXTURES, "rt-safe.clap"), join(clap, "rt-safe.clap"));
  for (const f of ["crashes-at-load", "hangs"]) copyFileSync(join(FAULTY, `${f}.clap`), join(clap, `${f}.clap`));
  cpSync(join(FIXTURES, "lv2", "rt-safe.lv2"), join(lv2, "rt-safe.lv2"), { recursive: true });
  const out = join(root, "out");
  return {
    root,
    clap,
    lv2,
    out,
    flags: (port = 0, feedbackPort = 0) => [
      "--config", "/dev/null", "--clap-path", clap, "--lv2-path", lv2, "--lv2-extra", "",
      "--pin-file", join(out, "qualified.pins"), "--qualification-dir", join(out, "qualification"),
      "--descriptor-dir", join(out, "descriptors"), "--state-file", join(out, "state.json"),
      "--grid-hosts", "--budget-s", "4", "--hostd-port", String(port), "--hostd-feedback-port", String(feedbackPort),
    ],
  };
}

interface SyncRun {
  readonly status: number | null;
  readonly summary: Record<string, number>;
  readonly stderr: string;
  readonly ms: number;
}

/** The entry point as the service runs it, and its summary line read back into numbers. */
function sync(flags: readonly string[]): SyncRun {
  const started = Date.now();
  const r = spawnSync(process.execPath, [SYNC, ...flags], { encoding: "utf8", env: { ...process.env, ...(RUNNER === undefined ? {} : { OMX_PROBE_RUNNER: RUNNER }) } });
  const summary: Record<string, number> = {};
  for (const m of r.stdout.matchAll(/(qualified|skipped|refused|crashed|hung|unmeasured) (\d+)/g)) summary[m[1]!] = Number(m[2]);
  return { status: r.status, summary, stderr: r.stderr, ms: Date.now() - started };
}

const pinsOf = (out: string): ReturnType<typeof parsePinLine>[] =>
  readFileSync(join(out, "qualified.pins"), "utf8")
    .split("\n")
    .map((l) => parsePinLine(l))
    .filter((p) => p !== undefined);

const tools = { "native/build (make -C native deps all)": BUILT, "plugin-hostd-probe": RUNNER !== undefined };

describe("a sweep over a good CLAP, one that crashes at load, one that hangs and an LV2 bundle", () => {
  // one machine for the runs below, in order: each run reads what the one before it left
  let m: ReturnType<typeof machine>;
  needs(tools, "processes all four: the crasher and the hanger are recorded as such, and the other two qualify", () => {
    m = machine();
    const r = sync(m.flags());
    expect(r.status, r.stderr).toBe(0);
    expect(r.summary).toEqual({ qualified: 2, skipped: 0, refused: 0, crashed: 1, hung: 1, unmeasured: 0 });
    // the hanger was ended at its budget, not at the runner's own default
    expect(r.ms).toBeLessThan(30_000);
    const state = JSON.parse(readFileSync(join(m.out, "state.json"), "utf8")) as SyncState;
    const outcome = (key: string) => state.entries[key]?.plugins.map((p) => [p.outcome, p.code]);
    expect(outcome(`clap:${join(m.clap, "crashes-at-load.clap")}`)).toEqual([["crashed", "qualify.sync.scan-crashed"]]);
    expect(outcome(`clap:${join(m.clap, "hangs.clap")}`)).toEqual([["hung", "probe.timeout"]]);
    expect(outcome(`clap:${join(m.clap, "rt-safe.clap")}`)).toEqual([["qualified", undefined]]);
    expect(outcome(`lv2:${LV2_URI}`)).toEqual([["qualified", undefined]]);
    const pins = pinsOf(m.out);
    expect(pins.map((p) => [p!.uri, p!.verdict])).toEqual([
      [`clap:${join(m.clap, "rt-safe.clap")}#${GOOD_ID}`, "in-process"],
      [LV2_URI, "in-process"],
    ]);
    expect(pins[0]!.files).toEqual([{ path: "rt-safe.clap", sha256: fileSha256(join(m.clap, "rt-safe.clap")) }]);
    expect(pins[1]!.files.map((f) => f.path)).toEqual(["gain.so", "gain.ttl", "manifest.ttl"]);
    // every record says the soak was not measured; the crasher's says nothing was
    const records = readdirSync(join(m.out, "qualification"));
    const good = JSON.parse(readFileSync(join(m.out, "qualification", records.find((f) => f.startsWith(GOOD_ID) && f.endsWith(".qualification.json"))!), "utf8"));
    expect(good.notMeasured).toEqual([{ dimension: "stability", code: "hosting.stability.unsoaked" }]);
    expect(good.verdicts[0].rating).toBe("suitable");
    const crashed = JSON.parse(readFileSync(join(m.out, "qualification", records.find((f) => f.endsWith(".unmeasured.json"))!), "utf8"));
    expect([crashed.outcome, crashed.code]).toEqual(["crashed", "qualify.sync.scan-crashed"]);
    expect(readdirSync(join(m.out, "descriptors")).some((f) => f.startsWith(GOOD_ID))).toBe(true);
  });

  needs(tools, "a second run skips everything and leaves the pin file as it was", () => {
    const before = readFileSync(join(m.out, "qualified.pins"), "utf8");
    const r = sync(m.flags());
    expect(r.summary).toEqual({ qualified: 0, skipped: 4, refused: 0, crashed: 0, hung: 0, unmeasured: 0 });
    expect(readFileSync(join(m.out, "qualified.pins"), "utf8")).toBe(before);
  });

  needs(tools, "touching a binary is no change; changing its bytes qualifies exactly that one again", () => {
    const good = join(m.clap, "rt-safe.clap");
    const later = new Date(Date.now() + 5000);
    utimesSync(good, later, later);
    expect(sync(m.flags()).summary).toMatchObject({ qualified: 0, skipped: 4 });
    appendFileSync(good, "\0");
    const r = sync(m.flags());
    expect(r.summary).toEqual({ qualified: 1, skipped: 3, refused: 0, crashed: 0, hung: 0, unmeasured: 0 });
    expect(pinsOf(m.out)[0]!.files[0]!.sha256).toBe(fileSha256(good));
  });

  needs(tools, "a plugin removed loses its pin", () => {
    rmSync(join(m.lv2, "rt-safe.lv2"), { recursive: true });
    expect(sync(m.flags()).summary).toMatchObject({ qualified: 0, skipped: 3 });
    expect(pinsOf(m.out).map((p) => p!.uri)).toEqual([`clap:${join(m.clap, "rt-safe.clap")}#${GOOD_ID}`]);
  });
});

describe("discovery", () => {
  it("finds every .clap under a CLAP directory and each plugin of each bundle, an LV2 uri once, first on the path", () => {
    const root = mkdtempSync(join(scratch, "find-"));
    mkdirSync(join(root, "clap", "vendor"), { recursive: true });
    writeFileSync(join(root, "clap", "vendor", "a.clap"), "");
    writeFileSync(join(root, "clap", "notes.txt"), "");
    const manifest = '@prefix lv2: <http://lv2plug.in/ns/lv2core#> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n<urn:p> a lv2:Plugin ; lv2:binary <p.so> ; rdfs:seeAlso <p.ttl> .\n';
    for (const d of ["one", "two"]) {
      mkdirSync(join(root, d, "p.lv2"), { recursive: true });
      writeFileSync(join(root, d, "p.lv2", "manifest.ttl"), manifest);
    }
    const { items, problems } = discoverSyncItems({ clapDirs: [join(root, "clap"), join(root, "absent")], lv2Dirs: [join(root, "one"), join(root, "two")] });
    expect(problems).toEqual([]);
    expect(items).toEqual([
      { key: `clap:${join(root, "clap", "vendor", "a.clap")}`, format: "clap", root: join(root, "clap", "vendor"), files: ["a.clap"] },
      { key: "lv2:urn:p", format: "lv2", root: join(root, "one", "p.lv2"), files: ["manifest.ttl", "p.so", "p.ttl"], uri: "urn:p" },
    ]);
  });
});

// --- plugin-hostd on the pin file ---------------------------------------------------------------------------------

/** A dummy JACK server of the tests' own, one for all of them, so the real CLAP worker can start: the env to run under it. */
let jackServer: Promise<Record<string, string | undefined>> | undefined;
let jackProc: ChildProcess | undefined;
afterAll(() => {
  jackProc?.kill("SIGTERM");
});
function jack(): Promise<Record<string, string | undefined>> {
  jackServer ??= (async () => {
    const name = `qsync-${String(process.pid)}`;
    jackProc = spawn(JACKD!, ["-n", name, "-d", "dummy", "-r", "48000", "-p", "256"], { stdio: "ignore", env: { ...process.env, JACK_NO_AUDIO_RESERVATION: "1" } });
    await new Promise((r) => setTimeout(r, 1500));
    return { ...process.env, JACK_DEFAULT_SERVER: name };
  })();
  return jackServer;
}

const daemonTools = { ...tools, "plugin-hostd": HOSTD !== undefined, "omx-clap-host": CLAP_HOST !== undefined, jackd: JACKD !== undefined };

describe("plugin-hostd in its default mode, on the pin file the sweep wrote", () => {
  needs(
    daemonTools,
    "adds a qualified plugin and chains two; without the pin file the chain is refused (-501)",
    async () => {
      const m = machine();
      expect(sync(m.flags()).summary).toMatchObject({ qualified: 2 });
      const env = await jack();
      const uri = `clap:${join(m.clap, "rt-safe.clap")}#${GOOD_ID}`;
      // the daemon's defaults (require_pins 1, pin_mode first-use); only its own files are the test's
      const base = (d: string) => ({ clap_host: CLAP_HOST!, state_root: d, pin_store: join(d, "pins"), lv2_path: m.lv2 });
      const chainWith = async (conf: Record<string, string>): Promise<string[]> => {
        const d = mkdtempSync(join(scratch, "state-"));
        const daemon: RunningDaemon = await startDaemon(HOSTD!, scratch, { ...base(d), ...conf }, env);
        try {
          return [await daemon.control.send(`add ${uri} 0`), await daemon.control.send(`add ${uri} 1`), await daemon.control.send("chain 7 0 1")];
        } finally {
          daemon.close();
        }
      };
      expect(await chainWith({})).toEqual(["resp 0", "resp 1", "resp -501"]);
      expect(await chainWith({ pin_file: join(m.out, "qualified.pins") })).toEqual(["resp 0", "resp 1", "resp 0"]);
    },
    180_000,
  );

  needs(
    daemonTools,
    "a running daemon with its command socket free is sent the new pins, and chains them without a restart",
    async () => {
      const m = machine();
      const env = await jack();
      const d = mkdtempSync(join(scratch, "state-"));
      const started = await launchDaemon(HOSTD!, scratch, { clap_host: CLAP_HOST!, state_root: d, pin_store: join(d, "pins") }, env);
      try {
        const r = sync(m.flags(started.port, started.feedbackPort));
        expect(r.summary, r.stderr).toMatchObject({ qualified: 2 });
        expect(r.stderr).toContain("2 sent to plugin-hostd");
        const daemon = await started.connect();
        const uri = `clap:${join(m.clap, "rt-safe.clap")}#${GOOD_ID}`;
        expect([await daemon.control.send(`add ${uri} 0`), await daemon.control.send(`add ${uri} 1`), await daemon.control.send("chain 7 0 1")]).toEqual([
          "resp 0",
          "resp 1",
          "resp 0",
        ]);
      } finally {
        started.close();
      }
    },
    180_000,
  );

  needs(
    daemonTools,
    "a daemon whose command socket a controller holds is named, and the pins wait for its next start",
    async () => {
      const m = machine();
      const d = mkdtempSync(join(scratch, "state-"));
      const daemon = await startDaemon(HOSTD!, scratch, { clap_host: CLAP_HOST!, state_root: d, pin_store: join(d, "pins") });
      try {
        const r = sync(m.flags(daemon.port, daemon.feedbackPort));
        expect(r.summary).toMatchObject({ qualified: 2 });
        expect(r.stderr).toContain("a controller holds its command socket; the 2 changed pins apply at its next start");
      } finally {
        daemon.close();
      }
    },
    180_000,
  );
});

// --- the lock (#222) --------------------------------------------------------------------------------------------------

describe("a scoped run (#247)", () => {
  it("keeps the pins of what it did not scan, and drops one gone from a directory it scans", async () => {
    const root = mkdtempSync(join(scratch, "scoped-"));
    for (const d of ["clap-scanned", "clap-elsewhere", "lv2-scanned", "lv2-elsewhere"]) mkdirSync(join(root, d));
    const args = parseSyncArgs([]);
    if (!args.ok) throw new Error(args.error);
    const values = new Map([
      ["clap_path", join(root, "clap-scanned")], ["clap_extra", ""], ["lv2_path", join(root, "lv2-scanned")], ["lv2_extra", ""],
      ["pin_file", join(root, "q.pins")], ["qualification_dir", join(root, "qualification")], ["descriptor_dir", join(root, "descriptors")],
      ["state_file", join(root, "state", "qualify-sync.json")], ["hostd_port", "0"], ["host_class", ""], ["settle_s", "0"],
    ]);
    const r = resolveSyncSettings(values, args.args, {}, root);
    if (!r.ok) throw new Error(r.error);
    const entry = (format: "clap" | "lv2", entryRoot: string, uri: string) => ({
      format, root: entryRoot, files: [], plugins: [{ uri, outcome: "qualified" }], qualifiedAt: "2026-10-30T00:00:00Z", seconds: 1,
    });
    const elsewhereClap = `clap:${join(root, "clap-elsewhere", "Surge XT.clap")}`;
    const goneClap = `clap:${join(root, "clap-scanned", "removed.clap")}`;
    const elsewhereLv2 = "lv2:urn:test:elsewhere";
    const before: SyncState = {
      schema: "plugin-qualify.sync-state/1",
      entries: {
        [elsewhereClap]: entry("clap", join(root, "clap-elsewhere"), `${elsewhereClap}#surge`),
        [goneClap]: entry("clap", join(root, "clap-scanned"), `${goneClap}#gone`),
        [elsewhereLv2]: entry("lv2", join(root, "lv2-elsewhere", "e.lv2"), "urn:test:elsewhere"),
      },
    } as unknown as SyncState;
    mkdirSync(join(root, "state"));
    writeFileSync(r.settings.stateFile, JSON.stringify(before));
    const lines: string[] = [];
    await runSync(r.settings, { log: (l) => lines.push(l) });
    const after = JSON.parse(readFileSync(r.settings.stateFile, "utf8")) as SyncState;
    expect(Object.keys(after.entries).sort()).toEqual([elsewhereClap, elsewhereLv2].sort());
    expect(lines).toContain(`${goneClap}: gone, its pin is dropped`);
    expect(lines).toContain(`${elsewhereClap}: not under a directory this run scans; its pin is kept`);
    expect(lines.some((l) => l.startsWith(`${elsewhereLv2}: gone`))).toBe(false);
  });
});

describe("the lock", () => {
  /** Settings over empty plugin directories in a tree of their own; `settle_s` keeps a run in the lock for a while. */
  function lockedSettings(settleS: string): SyncSettings {
    const root = mkdtempSync(join(scratch, "lock-"));
    for (const d of ["clap", "lv2"]) mkdirSync(join(root, d));
    const args = parseSyncArgs([]);
    if (!args.ok) throw new Error(args.error);
    const values = new Map([
      ["clap_path", join(root, "clap")], ["clap_extra", ""], ["lv2_path", join(root, "lv2")], ["lv2_extra", ""],
      ["pin_file", join(root, "q.pins")], ["qualification_dir", join(root, "qualification")], ["descriptor_dir", join(root, "descriptors")],
      ["state_file", join(root, "state", "qualify-sync.json")], ["hostd_port", "0"], ["host_class", ""], ["settle_s", settleS],
    ]);
    const r = resolveSyncSettings(values, args.args, {}, root);
    if (!r.ok) throw new Error(r.error);
    return r.settings;
  }

  /** Runs recorded as they begin and end, on one clock. */
  function traced(settings: SyncSettings, name: string, events: string[], options: { wait?: boolean } = {}): Promise<unknown> {
    return runSync(settings, { ...options, log: (line) => line === "sync run begins" && events.push(`${name} begins`) }).then((r) => {
      events.push(`${name} ends`);
      return r;
    });
  }

  it("a second run waits for the first: they never measure at once", async () => {
    const settings = lockedSettings("1");
    const events: string[] = [];
    const a = traced(settings, "a", events);
    await new Promise((r) => setTimeout(r, 300));
    const b = traced(settings, "b", events);
    await Promise.all([a, b]);
    expect(events).toEqual(["a begins", "a ends", "b begins", "b ends"]);
  }, 30_000);

  it("--no-wait returns at once, and the holder runs once more at its end", async () => {
    const settings = lockedSettings("1");
    const events: string[] = [];
    const a = traced(settings, "a", events);
    await new Promise((r) => setTimeout(r, 300));
    const b = await traced(settings, "b", events, { wait: false });
    expect(b).toBeUndefined();
    expect(events).toEqual(["a begins", "b ends"]);
    await a;
    expect(events).toEqual(["a begins", "b ends", "a begins", "a ends"]);
    expect(existsSync(`${settings.stateFile}.again`)).toBe(false);
  }, 30_000);

  it("a lone --no-wait run takes the lock and runs once, leaving no marker", async () => {
    const settings = lockedSettings("0");
    const events: string[] = [];
    expect(await traced(settings, "a", events, { wait: false })).toBeDefined();
    expect(events).toEqual(["a begins", "a ends"]);
    expect(existsSync(`${settings.stateFile}.again`)).toBe(false);
  });

  it("a pass that went through clears the pending marker a package trigger left (#237)", async () => {
    const settings = lockedSettings("0");
    mkdirSync(dirname(settings.stateFile), { recursive: true });
    const marker = join(dirname(settings.stateFile), "qualify-pending");
    expect(pendingMarker(settings.stateFile)).toBe(marker);
    writeFileSync(marker, "");
    expect(await runSync(settings, {})).toBeDefined();
    expect(existsSync(marker)).toBe(false);
  });

  it("--no-wait is a flag, and the service unit passes it", () => {
    const a = parseSyncArgs(["--no-wait"]);
    expect(a.ok && a.args.noWait).toBe(true);
    expect(readFileSync(join(PKG, "packaging", "systemd", "plugin-qualify-sync.service"), "utf8")).toContain("--no-wait");
  });
});
