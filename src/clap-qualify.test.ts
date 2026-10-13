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
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  ClapQualifyError,
  RT_SAFETY_DOCUMENT_SCHEMA,
  clapQualifyTools,
  parseClapQualifyLine,
  parseClapQualifyOutput,
  qualifyClap,
  qualifyClapTargets,
  rtSafetyDocument,
  rtSafetyDocumentName,
  rtSafetyVerdict,
  type ClapQualifyRun,
} from "./clap-qualify.js";
import { HOSTING_CODE } from "./hosting-codes.js";
import { OMX_CLAP_HOST_EXTENSIONS, OPENMIXER_CONSOLE_PROFILE, shippedHostProfile } from "./host-profiles.js";
import {
  CLAP_QUALIFY_TOOL_ENV,
  CLAP_QUALIFY_TOOL_NAME,
  CLAP_SCAN_TOOL_ENV,
  CLAP_SWEEP_BLOCKS,
  NATIVE_TOOL_DIRS,
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
const SAFE_ID = "org.freemixer.plugin-qualify.fixture.rt-safe";
const UNSAFE_ID = "org.freemixer.plugin-qualify.fixture.rt-unsafe";
const BUILT = [clapQualifyToolPath(), rtInterposePath(), SAFE, UNSAFE].every((p) => existsSync(p));

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

/** A prober line as the tool prints it, with `patch` merged over the facts. */
function line(patch: { rtSafety?: object; clap?: object; hostExtensions?: string[]; integrity?: object | null } = {}): string {
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
        env: { ...process.env, [CLAP_SCAN_TOOL_ENV]: stub },
      });
    const safeOut = join(scratch, "safe");
    const safe = run(SAFE, safeOut);
    expect(safe.status).toBe(0);
    expect(safe.stdout).toMatch(new RegExp(`urn:clap:${SAFE_ID.replace(/\./g, "\\.")}\\s+suitable`));
    expect(readdirSync(safeOut)).toEqual([`${sha256(SAFE)}.${OPENMIXER_CONSOLE_PROFILE.id}.rt-safety.json`]);
    const unsafe = run(UNSAFE, join(scratch, "unsafe"));
    expect(unsafe.status).toBe(1);
    expect(unsafe.stdout).toContain(HOSTING_CODE.rtSafetyViolations);
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

describe("qualifyClap — the run, fail closed", () => {
  const answering = (stdout: string, extra: { status?: number; signal?: string } = {}): { run: ClapQualifyRun; calls: unknown[] } => {
    const calls: unknown[] = [];
    return { calls, run: (tool, args, env) => (calls.push({ tool, args, preload: env["LD_PRELOAD"] }), { status: extra.status ?? 0, signal: extra.signal ?? null, stdout }) };
  };
  const exists = () => true;

  it("runs the named prober under the named interposer, at the rates asked", () => {
    const { run, calls } = answering(line());
    const env = { [CLAP_QUALIFY_TOOL_ENV]: "/t/clap-qualify", [RT_INTERPOSE_ENV]: "/t/rt.so" };
    qualifyClap("/p/x.clap", SAFE_ID, { rates: [44100, 48000], run, env, exists });
    expect(calls).toEqual([
      { tool: "/t/clap-qualify", args: ["--rates", "44100,48000", "--block", "512", "--blocks", "512", "/p/x.clap", SAFE_ID], preload: "/t/rt.so" },
    ]);
  });

  it("an absent prober or interposer is refused, naming the setting", () => {
    const { run } = answering(line());
    expect(() => qualifyClap("/p/x.clap", undefined, { rates: [48000], run, env: {}, exists: (p) => !p.endsWith(".so") })).toThrow(new RegExp(RT_INTERPOSE_ENV));
    expect(() => qualifyClap("/p/x.clap", undefined, { rates: [48000], run, env: {}, exists: () => false })).toThrow(new RegExp(CLAP_QUALIFY_TOOL_ENV));
  });

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

  it("a setting naming an absent file is refused, never passed over for an installed tool", () => {
    const env = { [CLAP_QUALIFY_TOOL_ENV]: "/t/clap-qualify" };
    expect(() => clapQualifyTools(env, (p) => p !== "/t/clap-qualify")).toThrow(/no CLAP prober at \/t\/clap-qualify:/);
  });

  it("absent everywhere, the refusal names every place looked", () => {
    expect(() => clapQualifyTools({}, () => false)).toThrow(
      new RegExp([clapQualifyToolPath(), ...NATIVE_TOOL_DIRS.map((d) => join(d, CLAP_QUALIFY_TOOL_NAME))].join(", ")),
    );
  });

  it("a crash, a failed load or silence is no measurement", () => {
    expect(() => qualifyClap("/p/x.clap", undefined, { rates: [48000], run: answering("", { signal: "SIGSEGV", status: null as never }).run, env: {}, exists })).toThrow(/SIGSEGV/);
    expect(() => qualifyClap("/p/x.clap", undefined, { rates: [48000], run: answering(line(), { status: 2 }).run, env: {}, exists })).toThrow(/exited 2/);
    expect(() => qualifyClap("/p/x.clap", undefined, { rates: [48000], run: answering("").run, env: {}, exists })).toThrow(/nothing/);
  });

  it("a target that cannot be measured reads unknown, unmeasured, under every profile", () => {
    const pass = qualifyClapTargets([{ format: "clap", uri: `urn:clap:${SAFE_ID}` }], {
      rates: [48000],
      env: {},
      exists,
      profiles: [OPENMIXER_CONSOLE_PROFILE, shippedHostProfile("jalv")!],
    });
    expect(pass.documents).toEqual([]);
    expect(pass.failures).toHaveLength(1);
    expect(pass.verdicts.map((v) => [v.host, v.measured, v.rating])).toEqual([
      [OPENMIXER_CONSOLE_PROFILE.id, false, "unknown"],
      ["jalv", false, "unknown"],
    ]);
  });
});
