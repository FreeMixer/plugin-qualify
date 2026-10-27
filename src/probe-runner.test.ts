// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The runner as plugin-qualify drives it. The runner of plugin-hostd is not installed where the suite
 * runs, so a stand-in answers: either a function that writes a document to the `--out` it is given, or a
 * real script spawned the way the real runner is, to see the argument list, the environment and the
 * exit statuses cross a process boundary.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { HOSTING_CODE } from "./hosting-codes.js";
import type { AdmissionRuns } from "./host-admission.js";
import { JALV_PROFILE, OMX_CLAP_HOST_CONFIGURED_EXTENSIONS, OMX_CLAP_HOST_PROFILE, OPENMIXER_CONSOLE_PROFILE } from "./host-profiles.js";
import { ProbeRunnerError, clapRunnerArgs, lv2RunnerArgs, probeRunnerTool, probeTarget, qualifyTargets, type ProbeRun } from "./probe-runner.js";
import { fixtureJson, fixtureText, clapLineFixture, probeOutputOfLine } from "./probe-output-fixtures.js";
import {
  CLAP_QUALIFY_TOOL_ENV,
  CLAP_QUALIFY_TIMEOUT_S,
  CLAP_SWEEP_BLOCKS,
  LV2_HOSTING_TIMEOUT_S,
  PROBE_RUNNER_ENV,
  RT_INTERPOSE_ENV,
} from "./qualify-declarations.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "probe-runner-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const TOOLS = { [CLAP_QUALIFY_TOOL_ENV]: "/t/clap-qualify", [RT_INTERPOSE_ENV]: "/t/rt.so" };
const exists = () => true;
const CLAP = { format: "clap", uri: "urn:clap:org.example.plate", binaryPath: "/p/example-plate.clap" } as const;
const LV2 = { format: "lv2", uri: "urn:example:zero-path" } as const;

/** What a stand-in runner was called with. */
interface Call {
  readonly tool: string;
  readonly args: readonly string[];
  readonly preload: string | undefined;
}

/** A stand-in runner: writes `document(args)` to its `--out` and exits `status`. */
function runner(document: ((args: readonly string[]) => string) | undefined, status = 0, extra: Partial<ReturnType<ProbeRun>> = {}): { run: ProbeRun; calls: Call[] } {
  const calls: Call[] = [];
  const run: ProbeRun = (tool, args, env) => {
    calls.push({ tool, args, preload: env["LD_PRELOAD"] });
    if (document !== undefined) writeFileSync(args[args.indexOf("--out") + 1]!, document(args));
    return { status, signal: null, ...extra };
  };
  return { run, calls };
}

const successText = fixtureText("success-msi");

/** Both measured hosts take every plugin: the tests that are not about admission do not depend on an installed host. */
const HOSTS_ADMIT: AdmissionRuns = {
  modHost: () => ({ installed: true, steps: [{ cmd: "add", resp: 0 }, { cmd: "remove", resp: 0 }] }),
  jalv: () => ({ installed: true, stillRunning: true, status: null, signal: null, stderr: "" }),
};

describe("the runner's arguments", () => {
  it("a CLAP file is run by the prober the package locates, under the declared sweep and deadline", () => {
    const { run, calls } = runner(() => successText);
    probeTarget(CLAP, { rates: [44100, 48000], run, env: TOOLS, exists });
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.tool).toBe("plugin-hostd-probe");
    expect(c.preload).toBe("/t/rt.so");
    const out = c.args[c.args.indexOf("--out") + 1]!;
    const log = c.args[c.args.indexOf("--log") + 1]!;
    expect(c.args).toEqual([
      "run", "--child", "/t/clap-qualify", "--rates", "44100,48000", "--quantum", "512", "--blocks", String(CLAP_SWEEP_BLOCKS),
      "--wall-s", String(CLAP_QUALIFY_TIMEOUT_S), "--out", out, "--log", log, "/p/example-plate.clap", "org.example.plate",
    ]);
    expect(out).not.toBe(log);
  });

  it("the offered extensions travel as --offer, and only when there are some", () => {
    const base = { rates: [48000], out: "o", log: "l", child: "c" };
    expect(clapRunnerArgs({ ...base, offer: ["clap.a", "clap.b"] }, "/x.clap", "id")).toContain("--offer");
    expect(clapRunnerArgs({ ...base, offer: ["clap.a", "clap.b"] }, "/x.clap", "id")[clapRunnerArgs({ ...base, offer: ["x"] }, "/x.clap", "id").indexOf("--offer") + 1]).toBe("clap.a,clap.b");
    expect(clapRunnerArgs({ ...base, offer: [] }, "/x.clap", "id")).not.toContain("--offer");
    expect(clapRunnerArgs(base, "/x.clap", undefined).at(-1)).toBe("/x.clap");
  });

  it("an LV2 plugin is run as lv2:<uri> under its own deadline", () => {
    const args = lv2RunnerArgs({ rates: [48000], out: "o", log: "l" }, "urn:example:zero-path");
    expect(args.at(-1)).toBe("lv2:urn:example:zero-path");
    expect(args[args.indexOf("--wall-s") + 1]).toBe(String(LV2_HOSTING_TIMEOUT_S));
    expect(args).not.toContain("--child");
  });

  it("the runner is OMX_PROBE_RUNNER when set, else plugin-hostd-probe on the PATH", () => {
    expect(probeRunnerTool({})).toBe("plugin-hostd-probe");
    expect(probeRunnerTool({ [PROBE_RUNNER_ENV]: "" })).toBe("plugin-hostd-probe");
    expect(probeRunnerTool({ [PROBE_RUNNER_ENV]: "/opt/phd/plugin-hostd-probe" })).toBe("/opt/phd/plugin-hostd-probe");
    const { run, calls } = runner(() => successText);
    probeTarget(CLAP, { rates: [48000], run, env: { ...TOOLS, [PROBE_RUNNER_ENV]: "/opt/phd/plugin-hostd-probe" }, exists });
    expect(calls[0]?.tool).toBe("/opt/phd/plugin-hostd-probe");
  });
});

describe("the runner's exit decides whether there is a document", () => {
  const options = { rates: [48000], env: TOOLS, exists };

  it("exit 0 and exit 1 both leave a document to read; the bytes are kept as written", () => {
    for (const status of [0, 1]) {
      const { run } = runner(() => successText, status);
      const p = probeTarget(CLAP, { ...options, run });
      expect(p.bytes.toString("utf8")).toBe(successText);
      expect(p.output.plugin.id).toBe("org.example.plate");
      expect(p.output.grid[0]?.cost?.median).toBe(41.2);
    }
  });

  it("exit 2 is no document and says what the runner said", () => {
    const { run } = runner(undefined, 2, { stderr: "plugin-hostd-probe: a required limit is unavailable: memory\n" });
    expect(() => probeTarget(CLAP, { ...options, run })).toThrow(
      /exited 2 measuring urn:clap:org.example.plate, and wrote no document: plugin-hostd-probe: a required limit is unavailable: memory/,
    );
  });

  it("exit 3 is no such plugin", () => {
    const { run } = runner(undefined, 3);
    expect(() => probeTarget(CLAP, { ...options, run })).toThrow(/no such plugin urn:clap:org.example.plate/);
  });

  it("a runner that exits 0 and wrote nothing, or was killed, or is absent, is no measurement", () => {
    expect(() => probeTarget(CLAP, { ...options, run: runner(undefined, 0).run })).toThrow(/wrote no document at the path/);
    expect(() => probeTarget(CLAP, { ...options, run: runner(undefined, null as never, { signal: "SIGKILL" }).run })).toThrow(/killed \(SIGKILL\)/);
    const missing: ProbeRun = () => ({ status: null, error: new Error("spawn plugin-hostd-probe ENOENT") });
    expect(() => probeTarget(CLAP, { ...options, run: missing })).toThrow(new RegExp(`install plugin-hostd or set ${PROBE_RUNNER_ENV}`));
  });

  it("a document the reader refuses is reported with its code, never judged", () => {
    const major2 = JSON.stringify({ ...fixtureJson("success-msi"), formatVersion: "2.0" });
    const { run } = runner(() => major2);
    expect(() => probeTarget(CLAP, { ...options, run })).toThrow(/refused \(probe\.format\.major-unknown\)/);
    const mismatch = fixtureJson("success-msi");
    mismatch.machine.class.cstatesLimited = false;
    expect(() => probeTarget(CLAP, { ...options, run: runner(() => JSON.stringify(mismatch)).run })).toThrow(/probe\.format\.derived-mismatch/);
  });

  it("a document about another plugin than the one asked for is not judged as it", () => {
    const { run } = runner(() => successText);
    expect(() => probeTarget({ ...CLAP, uri: "urn:clap:org.example.other" }, { ...options, run })).toThrow(
      /measured org.example.plate when asked for org.example.other/,
    );
  });

  it("a CLAP target with no file to load, and a prober that is not installed, are refused before the runner is started", () => {
    const { run, calls } = runner(() => successText);
    expect(() => probeTarget({ format: "clap", uri: "urn:clap:x" }, { ...options, run })).toThrow(ProbeRunnerError);
    expect(() => probeTarget(CLAP, { rates: [48000], env: {}, exists: () => false, run })).toThrow(/no CLAP prober at/);
    expect(calls).toEqual([]);
  });
});

describe("qualifyTargets: a pass over the targets", () => {
  /** A runner that answers each run with a clean CLAP document taken with the extensions it was asked to offer. */
  function perOffer() {
    return runner((args) => {
      const at = args.indexOf("--offer");
      const offered = at < 0 ? [] : args[at + 1]!.split(",");
      const base = clapLineFixture().hostExtensions;
      return JSON.stringify(probeOutputOfLine(clapLineFixture({ hostExtensions: [...base, ...offered] })));
    });
  }
  const target = { format: "clap", uri: "urn:clap:org.example.fx", binaryPath: "/p/fx.clap" } as const;

  it("runs the runner once per offer and judges each profile from its own run", () => {
    const { run, calls } = perOffer();
    const pass = qualifyTargets([target], {
      rates: [48000],
      run,
      env: TOOLS,
      exists,
      profiles: [OPENMIXER_CONSOLE_PROFILE, OMX_CLAP_HOST_PROFILE, JALV_PROFILE],
    });
    expect(calls.map((c) => c.args.includes("--offer"))).toEqual([false, true]);
    expect(calls[1]?.args[calls[1].args.indexOf("--offer") + 1]).toBe(OMX_CLAP_HOST_CONFIGURED_EXTENSIONS.join(","));
    expect(pass.verdicts.map((v) => [v.uri, v.host, v.rating, v.measured])).toEqual([
      ["urn:clap:org.example.fx", "openmixer-console", "suitable", true],
      ["urn:clap:org.example.fx", "omx-clap-host", "suitable", true],
      ["urn:clap:org.example.fx", "jalv", "unknown", true],
    ]);
    expect(pass.verdicts[2]?.deciding).toBe(HOSTING_CODE.clapFormatNotHosted);
    expect(pass.failures).toEqual([]);
    expect(pass.runs.map((r) => r.judgment.hosts.map((h) => h.verdict.host))).toEqual([["openmixer-console", "jalv"], ["omx-clap-host"]]);
    expect(pass.documents.map((d) => d.console).sort()).toEqual(["jalv", "omx-clap-host", "openmixer-console"]);
  });

  it("a target the runner cannot measure reads unknown, unmeasured, under every profile, and the others go on", () => {
    let n = 0;
    const run: ProbeRun = (_tool, args) => {
      if (n++ === 0) return { status: 2, stderr: "no limits" };
      writeFileSync(args[args.indexOf("--out") + 1]!, JSON.stringify(probeOutputOfLine(clapLineFixture())));
      return { status: 0 };
    };
    const pass = qualifyTargets([target, { ...target, uri: "urn:clap:org.example.fx", binaryPath: "/p/b.clap" }], {
      rates: [48000],
      run,
      env: TOOLS,
      exists,
      profiles: [OPENMIXER_CONSOLE_PROFILE, JALV_PROFILE],
    });
    expect(pass.failures).toEqual([{ uri: "urn:clap:org.example.fx", problem: expect.stringContaining("exited 2") }]);
    expect(pass.verdicts.map((v) => [v.host, v.measured, v.rating, v.deciding])).toEqual([
      ["openmixer-console", false, "unknown", "not-measured"],
      ["jalv", false, "unknown", "not-measured"],
      ["openmixer-console", true, "suitable", undefined],
      ["jalv", true, "unknown", HOSTING_CODE.clapFormatNotHosted],
    ]);
  });

  it("a target whose second offer's run fails leaves no run and no document of its first one", () => {
    const perOfferRun = perOffer().run;
    let n = 0;
    const run: ProbeRun = (tool, args, env) => (n++ === 1 ? { status: 2, stderr: "no limits" } : perOfferRun(tool, args, env));
    // the same plugin id in two files: the first one's second run fails, the second file measures whole
    const pass = qualifyTargets([target, { ...target, binaryPath: "/p/b.clap" }], {
      rates: [48000],
      run,
      env: TOOLS,
      exists,
      profiles: [OPENMIXER_CONSOLE_PROFILE, OMX_CLAP_HOST_PROFILE],
    });
    expect(n).toBe(4);
    expect(pass.failures).toEqual([{ uri: "urn:clap:org.example.fx", problem: expect.stringContaining("exited 2") }]);
    expect(pass.verdicts.map((v) => [v.host, v.measured])).toEqual([
      ["openmixer-console", false],
      ["omx-clap-host", false],
      ["openmixer-console", true],
      ["omx-clap-host", true],
    ]);
    // only the second file's two runs and two documents: the failed target's first run counts for nothing
    expect(pass.runs.map((r) => r.judgment.hosts.map((h) => h.verdict.host))).toEqual([["openmixer-console"], ["omx-clap-host"]]);
    expect(pass.documents.map((d) => d.console)).toEqual(["openmixer-console", "omx-clap-host"]);
  });

  it("an LV2 plugin is run once for every profile, through the runner, and judged on its counts", () => {
    const doc = fixtureJson("success-msi");
    doc.plugin = { format: "lv2", id: LV2.uri };
    doc.grid[0].rtSafety.locks = 4;
    const { run, calls } = runner(() => JSON.stringify(doc));
    const pass = qualifyTargets([LV2], { rates: [48000], run, env: {}, profiles: [OPENMIXER_CONSOLE_PROFILE, JALV_PROFILE], admissions: HOSTS_ADMIT });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.at(-1)).toBe("lv2:urn:example:zero-path");
    expect(calls[0]?.preload).toBeUndefined();
    expect(pass.verdicts.map((v) => [v.uri, v.host, v.rating, v.deciding])).toEqual([
      [LV2.uri, "openmixer-console", "unsuitable", HOSTING_CODE.rtSafetyViolations],
      [LV2.uri, "jalv", "unsuitable", HOSTING_CODE.rtSafetyViolations],
    ]);
    expect(pass.documents).toEqual([]);
  });

  it("a run that crashed is a verdict of unknown, unmeasured, with the run's outcome, and its document is kept", () => {
    const { run } = runner(() => fixtureText("plugin-crash"), 1);
    const pass = qualifyTargets([LV2], { rates: [48000], run, env: {}, profiles: [OPENMIXER_CONSOLE_PROFILE] });
    expect(pass.failures).toEqual([]);
    expect(pass.verdicts).toEqual([{ uri: LV2.uri, host: "openmixer-console", measured: false, rating: "unknown", qualified: false, deciding: "probe.crashed" }]);
    expect(pass.runs).toHaveLength(1);
  });
});

describe("a real process stands in for the runner", () => {
  const script = join(scratch, "plugin-hostd-probe");
  writeFileSync(
    script,
    `#!/bin/sh
# records its arguments, writes $FIXTURE to the --out it is given, exits $EXITING
printf '%s\\n' "$@" > "$ARGS_FILE"
printf '%s' "$LD_PRELOAD" > "$ARGS_FILE.preload"
while [ $# -gt 0 ]; do
  if [ "$1" = "--out" ]; then out="$2"; fi
  shift
done
[ -n "$FIXTURE" ] && cp "$FIXTURE" "$out"
echo "stand-in said: $EXITING" >&2
exit "\${EXITING:-0}"
`,
  );
  chmodSync(script, 0o755);
  const fixture = join(scratch, "doc.json");
  writeFileSync(fixture, successText);
  const env = (extra: Record<string, string> = {}) => ({ ...TOOLS, PATH: process.env["PATH"], [PROBE_RUNNER_ENV]: script, FIXTURE: fixture, ARGS_FILE: join(scratch, "args"), ...extra });

  it("is started with the arguments, the interposer in LD_PRELOAD and no deadline of ours, and its document is read", () => {
    const p = probeTarget(CLAP, { rates: [48000], env: env(), exists });
    expect(p.output.run.outcome).toBe("probe.ok");
    const args = readFileSync(join(scratch, "args"), "utf8").split("\n");
    expect(args.slice(0, 2)).toEqual(["run", "--child"]);
    expect(args).toContain("org.example.plate");
    expect(readFileSync(join(scratch, "args.preload"), "utf8")).toBe("/t/rt.so");
    // the work directory is gone once the document is read
    expect(existsSync(dirname(args[args.indexOf("--out") + 1]!))).toBe(false);
  });

  it("its exit status crosses the process boundary: 3 is no such plugin, 2 is no document, and 2 says why", () => {
    expect(() => probeTarget(CLAP, { rates: [48000], env: env({ EXITING: "3", FIXTURE: "" }), exists })).toThrow(/no such plugin/);
    expect(() => probeTarget(CLAP, { rates: [48000], env: env({ EXITING: "2", FIXTURE: "" }), exists })).toThrow(/exited 2[\s\S]*stand-in said: 2/);
    expect(probeTarget(CLAP, { rates: [48000], env: env({ EXITING: "1" }), exists }).output.plugin.id).toBe("org.example.plate");
  });

  it("an absent runner is the spawn failure, named by its setting", () => {
    expect(() => probeTarget(CLAP, { rates: [48000], env: env({ [PROBE_RUNNER_ENV]: join(scratch, "nowhere") }), exists })).toThrow(
      new RegExp(`set ${PROBE_RUNNER_ENV}`),
    );
  });
});

describe("no timeout of ours sits around a prober", () => {
  const read = (rel: string) => readFileSync(join(PKG, "src", rel), "utf8");
  const TIMEOUT_OPTION = /timeout\s*:/;

  it("the scanner's spawn has one (positive control), the runner's and the CLAP arm's have none", () => {
    expect(TIMEOUT_OPTION.test(read("clap-loader.ts"))).toBe(true);
    expect(TIMEOUT_OPTION.test(read("probe-runner.ts"))).toBe(false);
    expect(read("clap-qualify.ts")).not.toMatch(/spawnSync/);
    expect(TIMEOUT_OPTION.test(read("direct-prober.support.ts"))).toBe(true);
  });
});
