// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The CLAP arm of the one qualifier. The live tests run the built prober (`make -C native`) under
 * the built interposer against the two fixture plugins, which differ only in that one allocates in
 * `process()`: the known RT-safe one must come out `suitable`, the known RT-unsafe one `unsuitable`
 * on the interposer's count, each document bound to its file's SHA-256. On CI a missing build is a
 * failure; elsewhere the live tests skip, saying how to build. The rest needs no binary.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  ClapQualifyError,
  RT_SAFETY_DOCUMENT_SCHEMA,
  clapQualifyTools,
  proberOffer,
  parseClapQualifyLine,
  parseClapQualifyOutput,
  rtSafetyDocument,
  rtSafetyDocumentName,
  rtSafetyVerdict,
} from "./clap-qualify.js";
import { qualifyClap } from "./direct-prober.support.js";
import { HOSTING_CODE } from "./hosting-codes.js";
import {
  OMX_CLAP_HOST_CONFIGURED_EXTENSIONS,
  OMX_CLAP_HOST_EXTENSIONS,
  OMX_CLAP_HOST_PROFILE,
  OPENMIXER_CONSOLE_PROFILE,
  shippedHostProfile,
} from "./host-profiles.js";
import {
  CLAP_QUALIFY_TOOL_ENV,
  CLAP_QUALIFY_TOOL_NAME,
  CLAP_SCAN_TOOL_ENV,
  CLAP_SYSTEM_DIR_ENV,
  CLAP_SWEEP_BLOCKS,
  NATIVE_TOOL_DIRS,
  PROBE_RUNNER_ENV,
  QUALIFY_RATES,
  RT_INTERPOSE_ENV,
  RT_INTERPOSE_NAME,
} from "./qualify-declarations.js";
import { clapQualifyToolPath, rtInterposePath } from "./tool-paths.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(PKG, "native", "build", "fixtures");
const SAFE = join(FIXTURES, "rt-safe.clap");
const UNSAFE = join(FIXTURES, "rt-unsafe.clap");
const CONTROLS = join(FIXTURES, "controls.clap");
const SYNTH = join(FIXTURES, "synth.clap");
const SYNTH_ALLOC = join(FIXTURES, "synth-alloc.clap");
const SYNTH_MIDI = join(FIXTURES, "synth-midi.clap");
const SYNTH_STRICT = join(FIXTURES, "synth-strict.clap");
const SAFE_ID = "org.freemixer.plugin-qualify.fixture.rt-safe";
const UNSAFE_ID = "org.freemixer.plugin-qualify.fixture.rt-unsafe";
const BUILT = [clapQualifyToolPath(), rtInterposePath(), SAFE, UNSAFE, SYNTH, SYNTH_ALLOC, SYNTH_MIDI, SYNTH_STRICT].every((p) => existsSync(p));

const scratch = mkdtempSync(join(tmpdir(), "clap-qualify-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A live test: the native build must exist; on CI its absence fails rather than skips. */
function live(name: string, body: () => void): void {
  it(name, (ctx) => {
    if (!BUILT) {
      if (process.env["CI"]) throw new Error("native/build is missing: CI builds it with make -C native deps all");
      ctx.skip("native/build is missing: make -C native deps all");
    }
    body();
  });
}

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/** A `plugin-hostd-probe` for the command-line tests: the real prober behind the runner's arguments (src/fake-probe-runner.support.mjs). */
function standInRunner(): string {
  const path = join(scratch, "plugin-hostd-probe");
  writeFileSync(path, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(PKG, "src", "fake-probe-runner.support.mjs"))} "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A prober line as the tool prints it, with `patch` merged over the facts. */
function line(
  patch: { rtSafety?: object; clap?: object; hostExtensions?: string[]; integrity?: object | null; noteSweep?: object } = {},
): string {
  return JSON.stringify({
    uri: `urn:clap:${SAFE_ID}`,
    format: "clap",
    id: SAFE_ID,
    binary: { path: "/x/rt-safe.clap", sha256: "a".repeat(64) },
    hostExtensions: patch.hostExtensions ?? [...OMX_CLAP_HOST_EXTENSIONS],
    clap: {
      mainInputChannels: 2,
      mainOutputChannels: 2,
      sidechainInputs: 0,
      features: ["audio-effect"],
      headlessOk: true,
      noteInputs: 0,
      latency: { "48000": { declaredFrames: 0, measuredFrames: 0 } },
      threadViolations: 0,
      processErrors: 0,
      processCalls: 512,
      nonFinite: false,
      ...patch.clap,
    },
    rtSafety: {
      interposer: true,
      swept: true,
      sweepApplicable: true,
      blocks: 512,
      blockFrames: 512,
      allocationsInRun: 0,
      locksInRun: 0,
      syscallsInRun: 0,
      events: [],
      ...patch.rtSafety,
    },
    noteSweep: patch.noteSweep ?? { applicable: false },
    ...(patch.integrity === null
      ? {}
      : {
          integrity: patch.integrity ?? {
            version: "1",
            files: [{ path: "rt-safe.clap", sha256: "a".repeat(64) }],
            layout: { scheme: "omx-layout/1", sha256: "b".repeat(64) },
          },
        }),
  });
}

describe("clap-qualify, live — the known RT-safe and RT-unsafe fixture plugins", () => {
  live("the RT-safe plugin is suitable on a clean count, its document bound to the file's SHA-256 and the console", () => {
    const [l] = qualifyClap(SAFE, undefined, { rates: QUALIFY_RATES });
    const doc = rtSafetyDocument(l!);
    expect(doc.schema).toBe(RT_SAFETY_DOCUMENT_SCHEMA);
    expect(doc.plugin).toEqual({ uri: `urn:clap:${SAFE_ID}`, format: "clap", binary: { path: SAFE, sha256: sha256(SAFE) } });
    expect(doc.console).toBe(OPENMIXER_CONSOLE_PROFILE.id);
    expect(doc.verdict).toMatchObject({ rating: "suitable", rtSafe: true });
    expect(doc.verdict.reasons.map((r) => r.code)).toEqual([HOSTING_CODE.rtSafetyClean]);
    expect(doc.measured.rtSafety).toMatchObject({ interposer: true, swept: true, allocationsInRun: 0, locksInRun: 0, syscallsInRun: 0 });
    expect(doc.measured.clap.processCalls).toBe(CLAP_SWEEP_BLOCKS * QUALIFY_RATES.length);
    expect(Object.keys(doc.measured.clap.latency)).toEqual(QUALIFY_RATES.map(String));
  });

  live("the RT-unsafe plugin is unsuitable on the interposer's count, and the events name the allocation", () => {
    const [l] = qualifyClap(UNSAFE, UNSAFE_ID, { rates: QUALIFY_RATES });
    const doc = rtSafetyDocument(l!);
    expect(doc.plugin.binary.sha256).toBe(sha256(UNSAFE));
    expect(doc.verdict).toMatchObject({ rating: "unsuitable", rtSafe: false });
    expect(doc.verdict.deciding?.code).toBe(HOSTING_CODE.rtSafetyViolations);
    // one malloc and one free per swept block, at every rate
    expect(doc.measured.rtSafety.allocationsInRun).toBe(2 * CLAP_SWEEP_BLOCKS * QUALIFY_RATES.length);
    expect(doc.measured.rtSafety.events).toContain("malloc");
  });

  live("the arrival is read against the response's peak: a leak one frame ahead of a declared delay is not its onset", () => {
    // 883 frames, with -2.1e-5 at 882: what omx-pitch's fractional read puts out at 44.1 kHz
    const [l] = qualifyClap(join(FIXTURES, "leaky-delay.clap"), undefined, { rates: QUALIFY_RATES });
    const latency = rtSafetyDocument(l!).measured.clap.latency;
    for (const rate of QUALIFY_RATES) expect(latency[String(rate)]).toEqual({ declaredFrames: 883, measuredFrames: 883 });
  });

  live("a delay that declares no latency is still measured at its arrival, so the mismatch stands", () => {
    const [l] = qualifyClap(join(FIXTURES, "undeclared-delay.clap"), undefined, { rates: QUALIFY_RATES });
    const latency = rtSafetyDocument(l!).measured.clap.latency;
    for (const rate of QUALIFY_RATES) expect(latency[String(rate)]).toEqual({ declaredFrames: 0, measuredFrames: 883 });
  });

  live("the pin: the .clap's digest by its name is sha256sum's, and the layout is an omx-layout/1 fingerprint", () => {
    const [safe] = qualifyClap(SAFE, SAFE_ID, { rates: [QUALIFY_RATES[0]!] });
    const [again] = qualifyClap(SAFE, SAFE_ID, { rates: [QUALIFY_RATES[0]!] });
    const [controls] = qualifyClap(CONTROLS, undefined, { rates: [QUALIFY_RATES[0]!] });
    expect(safe!.integrity.files).toEqual([{ path: basename(SAFE), sha256: sha256(SAFE) }]);
    expect(safe!.integrity.layout?.scheme).toBe("omx-layout/1");
    expect(safe!.integrity.layout?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(again!.integrity).toEqual(safe!.integrity);
    // another parameter layout, another fingerprint
    expect(controls!.integrity.layout?.sha256).not.toBe(safe!.integrity.layout?.sha256);
    expect(rtSafetyDocument(safe!).measured.integrity).toEqual(safe!.integrity);
  });

  live("a .clap whose name holds a separator of pin_set or whitespace is unpinnable, not pinned", () => {
    for (const name of ["a,b.clap", "sp ace.clap"]) {
      const named = join(scratch, name);
      copyFileSync(SAFE, named);
      const [l] = qualifyClap(named, SAFE_ID, { rates: [QUALIFY_RATES[0]!] });
      expect(l!.integrity).toEqual({
        version: "1",
        unmeasuredReason: "unpinnable",
        unmeasuredDetail: "the file name holds a separator of pin_set or whitespace",
      });
    }
  });

  live("a symlinked .clap is pinned under the link's name, the name the console adds, with the target's bytes", () => {
    const link = join(scratch, "link.clap");
    symlinkSync(SAFE, link);
    const [l] = qualifyClap(link, SAFE_ID, { rates: [QUALIFY_RATES[0]!] });
    expect(l!.integrity.files).toEqual([{ path: "link.clap", sha256: sha256(SAFE) }]);
  });

  live("a plugin with more parameters than the host accepts is unpinnable; one at the cap is pinned", () => {
    const [atCap] = qualifyClap(join(FIXTURES, "params-2048.clap"), undefined, { rates: [QUALIFY_RATES[0]!] });
    expect(atCap!.integrity.layout?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const [over] = qualifyClap(join(FIXTURES, "params-2049.clap"), undefined, { rates: [QUALIFY_RATES[0]!] });
    expect(over!.integrity).toEqual({
      version: "1",
      unmeasuredReason: "unpinnable",
      unmeasuredDetail: "more parameters than the host accepts (2048)",
    });
  });

  live("a layout that cannot be read says which cause: get_info, or memory while reading or hashing it", () => {
    const integrity = (path: string, env: Record<string, string> = {}) => {
      const r = spawnSync(clapQualifyToolPath(), ["--rates", String(QUALIFY_RATES[0]), "--blocks", "4", path], {
        encoding: "utf8",
        env: { ...process.env, ...env },
      });
      return parseClapQualifyOutput(r.stdout)[0]!.integrity;
    };
    expect(integrity(join(FIXTURES, "info-fails.clap")).unmeasuredDetail).toBe("a parameter's get_info failed");
    // params-2048: the layout is read into calloc(2048, ...) and sorted through a malloc of 2048 pointers
    const wide = join(FIXTURES, "params-2048.clap");
    const preload = { LD_PRELOAD: join(FIXTURES, "fail-alloc.so") };
    expect(integrity(wide, { ...preload, FAIL_CALLOC_NMEMB: "2048" })).toMatchObject({
      unmeasuredReason: "probe-error",
      unmeasuredDetail: "out of memory reading the parameter layout",
    });
    expect(integrity(wide, { ...preload, FAIL_MALLOC_SIZE: String(2048 * 8) })).toMatchObject({
      unmeasuredReason: "probe-error",
      unmeasuredDetail: "out of memory hashing the parameter layout",
    });
  });

  live("the prober offers exactly the console's CLAP host extensions", () => {
    const [l] = qualifyClap(SAFE, SAFE_ID, { rates: [QUALIFY_RATES[0]!] });
    expect(l!.hostExtensions).toEqual(OMX_CLAP_HOST_EXTENSIONS);
  });

  live("without the interposer nothing is counted, and the verdict is unknown, never clean", () => {
    const r = spawnSync(clapQualifyToolPath(), ["--rates", String(QUALIFY_RATES[0]), "--blocks", "4", UNSAFE], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const [l] = parseClapQualifyOutput(r.stdout);
    expect(l!.rtSafety).toEqual({ interposer: false });
    const doc = rtSafetyDocument(l!);
    expect(doc.verdict.rating).toBe("unknown");
    expect(doc.verdict.deciding?.code).toBe(HOSTING_CODE.rtSafetyUnmeasured);
  });

  live("plugin-qualify on a .clap: one verdict per plugin, a document per hash and console in --out, the exit code", () => {
    // the scan is the scanner's: a stub answers with the two fixtures' rows
    const doc = (path: string, id: string) =>
      `{"path":${JSON.stringify(path)},"plugins":[{"id":"${id}","name":"g","vendor":"","version":"1","description":"","url":"","features":["audio-effect"],"params":[],"audio_ports":{"inputs":[{"id":0,"name":"in","role":"main","channels":2}],"outputs":[{"id":0,"name":"out","role":"main","channels":2}]},"note_ports":{"inputs":0,"outputs":0}}]}`;
    const stub = join(scratch, "scan.sh");
    writeFileSync(
      stub,
      `#!/bin/sh\ncase "$2" in *rt-unsafe*) f='${doc(UNSAFE, UNSAFE_ID)}';; *) f='${doc(SAFE, SAFE_ID)}';; esac\n` +
        `printf '{"scanner":"omx-clap-scan","version":"0","files":[%s]}' "$f"\n`,
    );
    chmodSync(stub, 0o755);
    const bin = join(PKG, "bin", "plugin-qualify.mjs");
    const run = (target: string, out: string) =>
      spawnSync(process.execPath, [bin, "--rates", String(QUALIFY_RATES[0]), "--out", out, target], {
        encoding: "utf8",
        env: { ...process.env, [CLAP_SCAN_TOOL_ENV]: stub, [PROBE_RUNNER_ENV]: standInRunner() },
      });
    const safeOut = join(scratch, "safe");
    const safe = run(SAFE, safeOut);
    expect(safe.status).toBe(0);
    expect(safe.stdout).toMatch(new RegExp(`urn:clap:${SAFE_ID.replace(/\./g, "\\.")}\\s+suitable`));
    const written = readdirSync(safeOut).sort();
    expect(written).toHaveLength(2);
    const [recordName, copyName] = [written.find((f) => f.endsWith(".qualification.json"))!, written.find((f) => f.endsWith(".probe.json"))!];
    expect(recordName.startsWith(`${SAFE_ID}@`)).toBe(true);
    expect(recordName).toContain(`-${sha256(SAFE).slice(0, 12)}.`);
    const record = JSON.parse(readFileSync(join(safeOut, recordName), "utf8"));
    expect(record.probe.file).toBe(copyName);
    expect(record.probe.sha256).toBe(sha256(join(safeOut, copyName)));
    expect(record.binary.sha256).toBe(sha256(SAFE));
    expect(record.verdicts.map((v: { host: string; rating: string }) => [v.host, v.rating])).toEqual([[OPENMIXER_CONSOLE_PROFILE.id, "suitable"]]);
    const unsafe = run(UNSAFE, join(scratch, "unsafe"));
    expect(unsafe.status).toBe(1);
    expect(unsafe.stdout).toContain(HOSTING_CODE.rtSafetyViolations);
  });
});

describe("clap-qualify, live — an instrument is played: the note sweep", () => {
  live("a clean synth is suitable: the parameter sweep and the note sweep both count nothing", () => {
    const [l] = qualifyClap(SYNTH, undefined, { rates: QUALIFY_RATES });
    expect(l!.clap.noteInputs).toBe(1);
    expect(l!.noteSweep).toMatchObject({ applicable: true, dialect: "clap", interposer: true, allocationsInRun: 0, locksInRun: 0, syscallsInRun: 0 });
    expect(l!.noteSweep.blocks).toBe(CLAP_SWEEP_BLOCKS * QUALIFY_RATES.length);
    expect(l!.noteSweep.noteEvents).toBeGreaterThan(l!.noteSweep.blocks!);
    const doc = rtSafetyDocument(l!);
    expect(doc.verdict).toMatchObject({ rating: "suitable", rtSafe: true });
    expect(doc.verdict.reasons.map((r) => r.code)).toEqual([HOSTING_CODE.rtSafetyClean, HOSTING_CODE.rtSafetyNotesClean]);
    expect(doc.measured.noteSweep).toEqual(l!.noteSweep);
  });

  live("a synth that allocates on note on is clean at rest and unsuitable once played", () => {
    const [l] = qualifyClap(SYNTH_ALLOC, undefined, { rates: QUALIFY_RATES });
    // the parameter sweep plays no note: it sees nothing
    expect(l!.rtSafety).toMatchObject({ allocationsInRun: 0, locksInRun: 0, syscallsInRun: 0 });
    expect(l!.noteSweep.allocationsInRun).toBeGreaterThan(0);
    expect(l!.noteSweep.events).toContain("malloc");
    const doc = rtSafetyDocument(l!);
    expect(doc.verdict).toMatchObject({ rating: "unsuitable", rtSafe: false });
    expect(doc.verdict.deciding?.code).toBe(HOSTING_CODE.rtSafetyNotesViolations);
  });

  live("a synth that reads only MIDI is played in MIDI's dialect", () => {
    const [l] = qualifyClap(SYNTH_MIDI, undefined, { rates: [QUALIFY_RATES[0]!] });
    expect(l!.noteSweep).toMatchObject({ applicable: true, dialect: "midi", allocationsInRun: 0 });
    expect(rtSafetyDocument(l!).verdict.rating).toBe("suitable");
  });

  live("all notes off reaches a port that reads MIDI too as controller 123, as the host sends it, never as a wildcard", () => {
    // the fixture aborts on a CLAP note whose key or channel is -1, as Surge XT and Six Sines do
    const [l] = qualifyClap(SYNTH_STRICT, undefined, { rates: QUALIFY_RATES });
    expect(l!.noteSweep).toMatchObject({ applicable: true, dialect: "clap", allocationsInRun: 0, locksInRun: 0, syscallsInRun: 0 });
    expect(rtSafetyDocument(l!).verdict.rating).toBe("suitable");
  });

  live("an effect is not played: its note sweep is not applicable and adds no reason", () => {
    const [l] = qualifyClap(SAFE, SAFE_ID, { rates: [QUALIFY_RATES[0]!] });
    expect(l!.noteSweep).toEqual({ applicable: false });
    expect(rtSafetyDocument(l!).verdict.reasons.map((r) => r.code)).toEqual([HOSTING_CODE.rtSafetyClean]);
  });

  live("without the interposer the note sweep counts nothing, and an instrument's verdict is unknown", () => {
    const r = spawnSync(clapQualifyToolPath(), ["--rates", String(QUALIFY_RATES[0]), "--blocks", "16", SYNTH_ALLOC], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const [l] = parseClapQualifyOutput(r.stdout);
    expect(l!.noteSweep).toMatchObject({ applicable: true, interposer: false });
    expect(l!.noteSweep.allocationsInRun).toBeUndefined();
    expect(rtSafetyDocument(l!).verdict.rating).toBe("unknown");
  });

  live("--offer adds omx-clap-host's three extensions, and the synth is suitable under its profile", () => {
    const offer = proberOffer(OMX_CLAP_HOST_PROFILE)!;
    expect(offer).toEqual(OMX_CLAP_HOST_CONFIGURED_EXTENSIONS);
    const [l] = qualifyClap(SYNTH, undefined, { rates: [QUALIFY_RATES[0]!], offer });
    expect(l!.hostExtensions).toEqual([...OMX_CLAP_HOST_EXTENSIONS, ...OMX_CLAP_HOST_CONFIGURED_EXTENSIONS]);
    expect(rtSafetyDocument(l!, OMX_CLAP_HOST_PROFILE).verdict.rating).toBe("suitable");
    // the console's run is not omx-clap-host's measurement, nor the other way round
    const [base] = qualifyClap(SYNTH, undefined, { rates: [QUALIFY_RATES[0]!] });
    expect(rtSafetyDocument(base!, OMX_CLAP_HOST_PROFILE).verdict.deciding?.code).toBe(HOSTING_CODE.clapExtensionsNotCovered);
    expect(rtSafetyDocument(l!, OPENMIXER_CONSOLE_PROFILE).verdict.deciding?.code).toBe(HOSTING_CODE.clapExtensionsNotCovered);
  });

  live("an extension the prober cannot offer is a usage error, not an offer", () => {
    const r = spawnSync(clapQualifyToolPath(), ["--rates", "48000", "--offer", "clap.gui", SYNTH], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
  });
});

describe("plugin-qualify --all, live — the standard CLAP search path", () => {
  live("a .clap only on CLAP_PATH is found by --all and qualified, with ~/.clap empty", () => {
    const onPath = join(scratch, "clap-path");
    mkdirSync(onPath, { recursive: true });
    copyFileSync(SAFE, join(onPath, basename(SAFE)));
    const home = join(scratch, "home");
    mkdirSync(home, { recursive: true });
    const bin = join(PKG, "bin", "plugin-qualify.mjs");
    const r = spawnSync(process.execPath, [bin, "--all", "--rates", String(QUALIFY_RATES[0])], {
      encoding: "utf8",
      // the prober is the scanner here too, so the walk reads the real file
      env: {
        ...process.env,
        HOME: home,
        CLAP_PATH: onPath,
        LV2_PATH: join(scratch, "no-lv2"),
        [CLAP_SCAN_TOOL_ENV]: clapQualifyToolPath(),
        [CLAP_SYSTEM_DIR_ENV]: join(scratch, "no-system-clap"),
        [PROBE_RUNNER_ENV]: standInRunner(),
      },
    });
    expect(r.stderr).toContain(`target urn:clap:${SAFE_ID} (${onPath})`);
    expect(r.stdout).toMatch(new RegExp(`urn:clap:${SAFE_ID.replace(/\./g, "\\.")}\\s+suitable`));
    expect(r.status).toBe(0);
  });
});

describe("parseClapQualifyLine — the prober's line, refused when it is not one", () => {
  it("reads a line into the measurement, keeping the interposer's events", () => {
    const l = parseClapQualifyLine(line({ rtSafety: { allocationsInRun: 2, events: ["malloc", "free"] } }));
    expect(l.rtSafety.allocationsInRun).toBe(2);
    expect(l.rtSafety.events).toEqual(["malloc", "free"]);
    expect(l.clap.latency).toEqual({ "48000": { declaredFrames: 0, measuredFrames: 0 } });
  });

  it("refuses what is not the prober's line, naming how it differs", () => {
    expect(() => parseClapQualifyLine("nope")).toThrow(ClapQualifyError);
    expect(() => parseClapQualifyLine(line().replace('"format":"clap"', '"format":"lv2"'))).toThrow(/format/);
    expect(() => parseClapQualifyLine(line().replace("a".repeat(64), "A".repeat(64)))).toThrow(/sha256/);
    expect(() => parseClapQualifyLine(line({ rtSafety: { allocationsInRun: -1 } }))).toThrow(/allocationsInRun/);
    expect(() => parseClapQualifyLine(line({ clap: { headlessOk: "yes" } }))).toThrow(/headlessOk/);
    expect(() => parseClapQualifyLine(line().replace(`"uri":"urn:clap:${SAFE_ID}"`, '"uri":"urn:clap:other"'))).toThrow(/uri/);
    expect(() => parseClapQualifyLine(line({ integrity: null }))).toThrow(/integrity/);
  });

  it("keeps a pin whole or not at all: a file that does not read leaves only a reason", () => {
    expect(parseClapQualifyLine(line()).integrity).toEqual({
      version: "1",
      files: [{ path: "rt-safe.clap", sha256: "a".repeat(64) }],
      layout: { scheme: "omx-layout/1", sha256: "b".repeat(64) },
    });
    const partial = parseClapQualifyLine(
      line({ integrity: { files: [{ path: "a,b.clap", sha256: "a".repeat(64) }], layout: { scheme: "omx-layout/1", sha256: "b".repeat(64) } } }),
    );
    expect(partial.integrity.files).toBeUndefined();
    expect(partial.integrity.unmeasuredReason).toBe("probe-error");
    const unpinnable = parseClapQualifyLine(line({ integrity: { unmeasuredReason: "unpinnable", unmeasuredDetail: "x" } }));
    expect(unpinnable.integrity).toEqual({ unmeasuredReason: "unpinnable", unmeasuredDetail: "x" });
  });
});

describe("rtSafetyDocument — the rtSafety dimension's verdict, and nothing else's", () => {
  it("a lock or a syscall in process() is as unsuitable as an allocation", () => {
    for (const patch of [{ locksInRun: 1 }, { syscallsInRun: 3 }]) {
      const doc = rtSafetyDocument(parseClapQualifyLine(line({ rtSafety: patch })));
      expect(doc.verdict.rating).toBe("unsuitable");
      expect(doc.verdict.deciding?.code).toBe(HOSTING_CODE.rtSafetyViolations);
    }
  });

  it("a thread violation or a process error is unsuitable; a sweep that ran nothing is unknown", () => {
    expect(rtSafetyDocument(parseClapQualifyLine(line({ clap: { threadViolations: 1 } }))).verdict.deciding?.code).toBe(HOSTING_CODE.clapThreadViolation);
    expect(rtSafetyDocument(parseClapQualifyLine(line({ clap: { processErrors: 2 } }))).verdict.deciding?.code).toBe(HOSTING_CODE.clapProcessError);
    const none = rtSafetyDocument(parseClapQualifyLine(line({ clap: { processCalls: 0 } })));
    expect(none.verdict.rating).toBe("unknown");
    expect(none.verdict.deciding?.code).toBe(HOSTING_CODE.clapUnqualified);
  });

  it("a plugin with no parameter is measured at rest: nothing to sweep is not unswept", () => {
    const doc = rtSafetyDocument(parseClapQualifyLine(line({ rtSafety: { swept: false, sweepApplicable: false } })));
    expect(doc.verdict.rating).toBe("suitable");
  });

  it("a line taken with other host extensions than the console's is not the console's measurement", () => {
    const doc = rtSafetyDocument(parseClapQualifyLine(line({ hostExtensions: [...OMX_CLAP_HOST_EXTENSIONS, "clap.gui"] })));
    expect(doc.verdict.rating).toBe("unknown");
    expect(doc.verdict.deciding?.code).toBe(HOSTING_CODE.clapExtensionsNotCovered);
  });

  it("a host with no CLAP path is not judged by the console's extensions (#19)", () => {
    const jalv = shippedHostProfile("jalv")!;
    const doc = rtSafetyDocument(parseClapQualifyLine(line()), jalv);
    expect(doc.console).toBe("jalv");
    expect(doc.verdict.rating).toBe("unknown");
    expect(doc.verdict.rtSafe).toBe(false);
    expect(doc.verdict.deciding?.code).toBe(HOSTING_CODE.clapFormatNotHosted);
    expect(rtSafetyVerdict(doc)).toMatchObject({ host: "jalv", qualified: false, rating: "unknown" });
  });

  it("a profile with its own extension list is judged by that list, not the console's (#19)", () => {
    const own = { ...OPENMIXER_CONSOLE_PROFILE, id: "own", clapExtensions: [...OMX_CLAP_HOST_EXTENSIONS, "clap.gui"] };
    const asOwn = rtSafetyDocument(parseClapQualifyLine(line({ hostExtensions: [...OMX_CLAP_HOST_EXTENSIONS, "clap.gui"] })), own);
    expect(asOwn.verdict.rating).toBe("suitable");
    const asConsole = rtSafetyDocument(parseClapQualifyLine(line()), own);
    expect(asConsole.verdict.rating).toBe("unknown");
    expect(asConsole.verdict.deciding?.code).toBe(HOSTING_CODE.clapExtensionsNotCovered);
  });

  it("is recorded per binary hash and console", () => {
    const l = parseClapQualifyLine(line());
    const jalv = shippedHostProfile("jalv")!;
    expect(rtSafetyDocumentName(rtSafetyDocument(l))).toBe(`${"a".repeat(64)}.${OPENMIXER_CONSOLE_PROFILE.id}.rt-safety.json`);
    expect(rtSafetyDocument(l, jalv).console).toBe(jalv.id);
  });
});

describe("the note sweep in the line and the document", () => {
  const played = { applicable: true, dialect: "clap", blocks: 512, blockFrames: 512, noteEvents: 6000, processErrors: 0, nonFinite: false,
    interposer: true, allocationsInRun: 0, locksInRun: 0, syscallsInRun: 0, events: [] };
  const instrument = { noteInputs: 1, mainInputChannels: 0, features: ["instrument"] };

  it("reads a played sweep, and refuses one that is not the prober's", () => {
    expect(parseClapQualifyLine(line({ noteSweep: played, clap: instrument })).noteSweep).toEqual(played);
    expect(() => parseClapQualifyLine(line({ noteSweep: { ...played, dialect: "midi2" } }))).toThrow(/dialect/);
    expect(() => parseClapQualifyLine(line({ noteSweep: { ...played, allocationsInRun: -1 } }))).toThrow(/allocationsInRun/);
    expect(() => parseClapQualifyLine(JSON.stringify({ ...JSON.parse(line()), noteSweep: undefined }))).toThrow(/noteSweep/);
  });

  it("an allocation, a lock or a syscall while played is unsuitable, under its own code", () => {
    for (const patch of [{ allocationsInRun: 2 }, { locksInRun: 1 }, { syscallsInRun: 1 }]) {
      const doc = rtSafetyDocument(parseClapQualifyLine(line({ noteSweep: { ...played, ...patch }, clap: instrument })));
      expect(doc.verdict.rating).toBe("unsuitable");
      expect(doc.verdict.deciding?.code).toBe(HOSTING_CODE.rtSafetyNotesViolations);
    }
    const errors = rtSafetyDocument(parseClapQualifyLine(line({ noteSweep: { ...played, processErrors: 1 }, clap: instrument })));
    expect(errors.verdict.deciding?.code).toBe(HOSTING_CODE.clapProcessError);
  });

  it("an instrument the prober could not play, or played with no interposer, is unknown, never clean", () => {
    for (const sweep of [{ applicable: false }, { ...played, interposer: false, allocationsInRun: undefined, locksInRun: undefined, syscallsInRun: undefined, events: undefined }]) {
      const doc = rtSafetyDocument(parseClapQualifyLine(line({ noteSweep: sweep, clap: instrument })));
      expect(doc.verdict.rating).toBe("unknown");
      expect(doc.verdict.deciding?.code).toBe(HOSTING_CODE.rtSafetyNotesUnmeasured);
    }
  });

  it("a plugin with no note input gets no note reason: its verdict is the one /1 gave", () => {
    const doc = rtSafetyDocument(parseClapQualifyLine(line()));
    expect(doc.schema).toBe("plugin-qualify.rt-safety/3");
    expect(doc.verdict.reasons.map((r) => r.code)).toEqual([HOSTING_CODE.rtSafetyClean]);
    expect(doc.measured.noteSweep).toEqual({ applicable: false });
  });
});

describe("proberOffer — the run that stands in for a profile", () => {
  it("the console needs no offer, omx-clap-host its three, and a host the prober cannot stand in for none", () => {
    expect(proberOffer(OPENMIXER_CONSOLE_PROFILE)).toEqual([]);
    expect(proberOffer(OMX_CLAP_HOST_PROFILE)).toEqual(OMX_CLAP_HOST_CONFIGURED_EXTENSIONS);
    expect(proberOffer(shippedHostProfile("jalv")!)).toBeUndefined();
    expect(proberOffer({ ...OPENMIXER_CONSOLE_PROFILE, clapExtensions: [...OMX_CLAP_HOST_EXTENSIONS, "clap.gui"] })).toBeUndefined();
    expect(proberOffer({ ...OPENMIXER_CONSOLE_PROFILE, clapExtensions: ["clap.log"] })).toBeUndefined();
  });
});

describe("clapQualifyTools — the prober and the interposer a run uses", () => {
  it("unset, the prober and the interposer are the package's own build, then the installed ones", () => {
    const own = [clapQualifyToolPath(), rtInterposePath()];
    const installed = NATIVE_TOOL_DIRS.map((d) => [join(d, CLAP_QUALIFY_TOOL_NAME), join(d, RT_INTERPOSE_NAME)]);
    const holding = (paths: readonly string[]) => (p: string) => paths.includes(p);
    expect(clapQualifyTools({}, holding([...installed[0]!, ...own]))).toEqual({ tool: own[0], interposer: own[1] });
    expect(clapQualifyTools({}, holding(installed[1]!))).toEqual({ tool: installed[1]![0], interposer: installed[1]![1] });
    expect(clapQualifyTools({}, holding([...installed[0]!, ...installed[1]!]))).toEqual({ tool: installed[0]![0], interposer: installed[0]![1] });
    expect(clapQualifyTools({}, holding(own))).toEqual({ tool: own[0], interposer: own[1] });
    const env = { [CLAP_QUALIFY_TOOL_ENV]: "/t/clap-qualify", [RT_INTERPOSE_ENV]: "/t/rt.so" };
    expect(clapQualifyTools(env, () => true)).toEqual({ tool: "/t/clap-qualify", interposer: "/t/rt.so" });
  });

  it("unset, the prober and the interposer come from one place; a place holding only one of them is refused", () => {
    const own = [clapQualifyToolPath(), rtInterposePath()];
    const installed = NATIVE_TOOL_DIRS.map((d) => [join(d, CLAP_QUALIFY_TOOL_NAME), join(d, RT_INTERPOSE_NAME)]);
    const holding = (paths: readonly string[]) => (p: string) => paths.includes(p);
    const ownDir = dirname(own[0]!);
    // the own build holds only the interposer: refused, never paired with the installed prober
    expect(() => clapQualifyTools({}, holding([installed[0]![0]!, own[1]!, ...installed[1]!]))).toThrow(
      new RegExp(`${ownDir}/? holds ${RT_INTERPOSE_NAME} but not ${CLAP_QUALIFY_TOOL_NAME}`),
    );
    // the first installed directory holds only the prober: refused, never paired with the second's interposer
    expect(() => clapQualifyTools({}, holding([installed[0]![0]!, ...installed[1]!]))).toThrow(
      new RegExp(`${NATIVE_TOOL_DIRS[0]} holds ${CLAP_QUALIFY_TOOL_NAME} but not ${RT_INTERPOSE_NAME}.*${CLAP_QUALIFY_TOOL_ENV} and ${RT_INTERPOSE_ENV}`),
    );
    // a setting decides its own tool; the other still comes from the first place holding it
    expect(clapQualifyTools({ [RT_INTERPOSE_ENV]: "/t/rt.so" }, holding(["/t/rt.so", installed[1]![0]!]))).toEqual({
      tool: installed[1]![0],
      interposer: "/t/rt.so",
    });
  });

  it("a setting naming an absent file is refused, never passed over for an installed tool", () => {
    const env = { [CLAP_QUALIFY_TOOL_ENV]: "/t/clap-qualify" };
    expect(() => clapQualifyTools(env, (p) => p !== "/t/clap-qualify")).toThrow(/no CLAP prober at \/t\/clap-qualify:/);
  });

  it("absent everywhere, the refusal names every place looked", () => {
    expect(() => clapQualifyTools({}, () => false)).toThrow(
      new RegExp([clapQualifyToolPath(), ...NATIVE_TOOL_DIRS.map((d) => join(d, CLAP_QUALIFY_TOOL_NAME))].join(", ")),
    );
  });
});
