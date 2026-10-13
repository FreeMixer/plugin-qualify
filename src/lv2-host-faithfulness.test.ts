// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Spec §2a: THE MEASURING HOST IS THE HOST THAT WILL RUN THE PLUGIN. The measurer as built
 * (`native/build/lv2_measure`, `make -C native`) against the fixture bundle
 * `native/fixtures/host-faithfulness.lv2`, plugins that each need one thing a third-party plugin
 * was found to need of its host, so every figure is read from the compiled host:
 *
 *   needs-options   refuses to instantiate without the sampleRate and maxBlockLength options (JUCE)
 *   worker-engine   its sound exists only after the host ran its worker (Hex Chain's amp)
 *   patch-gain      its parameter is patch:writable only (JUCE 8)
 *   wide-gain       a control port 1/64 .. 64 (Calf's gains)
 *   banner          prints on stdout while it instantiates (Guitarix)
 *
 * On CI a missing build is a failure; elsewhere the tests skip, saying how to build.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SOAK_SWEEP_DB, SOAK_SWEEP_RATIO } from "./qualify-declarations.js";

const NATIVE = join(dirname(fileURLToPath(import.meta.url)), "..", "native");
const BUILD = join(NATIVE, "build");
const MEASURE = join(BUILD, "lv2_measure");
const BUNDLES = join(BUILD, "fixtures", "lv2");
const BUILT = [MEASURE, join(BUNDLES, "host-faithfulness.lv2", "host-faithfulness.so")].every((p) => existsSync(p));
/** The rates the measurer probes, as its header declares them. */
const DECLARED_RATES = (/OMX_DECLARED_RATES\[[^\]]*\] = \{([^}]*)\}/.exec(readFileSync(join(NATIVE, "lv2-measure-rates.h"), "utf8"))?.[1] ?? "")
  .split(",")
  .map((r) => String(Number.parseFloat(r)));
const URN = (n: string): string => `urn:plugin-qualify:fixture:${n}`;

interface Run {
  readonly record: Record<string, any>;
  readonly stdout: string;
  readonly status: number | null;
}

function run(plugin: string, args: readonly string[], env: Readonly<Record<string, string>> = {}): Run {
  const r = spawnSync(MEASURE, [URN(plugin), ...args], {
    encoding: "utf8",
    env: { PATH: process.env["PATH"], LV2_PATH: BUNDLES, ...env },
    timeout: 110_000,
  });
  return { record: JSON.parse(r.stdout) as Record<string, any>, stdout: r.stdout, status: r.status };
}

function live(name: string, body: () => void, timeout?: number): void {
  it(
    name,
    (ctx) => {
      if (!BUILT) {
        if (process.env["CI"]) throw new Error("native/build is missing: CI builds it with make -C native deps all");
        ctx.skip("native/build is missing: make -C native deps all");
      }
      body();
    },
    timeout,
  );
}

describe("the measuring host against the faithfulness fixtures", () => {
  live("instantiates a plugin that refuses an empty options table, at every declared rate", () => {
    const r = run("needs-options", ["48000", "256", "2", "1"], { OMX_PROBE_BLOCKS: "24" });
    expect(r.status).toBe(0);
    expect(r.record["instantiated"]).toBe(true);
    expect(r.record["lifecycle"]).toMatchObject({ cycles: 2, instantiated: 2, failed: 0 });
    expect(DECLARED_RATES.length).toBeGreaterThan(0);
    expect(Object.keys(r.record["rates"])).toEqual(DECLARED_RATES);
    for (const rate of DECLARED_RATES) expect(r.record["rates"][rate].instantiated, rate).toBe(true);
    expect(r.record["host"].options).toBe(true);
  });

  live("runs the plugin's worker: jobs delivered, responses delivered, and the BUILT sound measured", () => {
    const worker = run("worker-engine", ["48000", "256", "2", "1"], { OMX_PROBE_BLOCKS: "48" });
    const plain = run("needs-options", ["48000", "256", "2", "1"], { OMX_PROBE_BLOCKS: "48" });
    expect(worker.record["host"].workerInterface).toBe(true);
    expect(worker.record["host"].workerJobs).toBeGreaterThan(0);
    expect(worker.record["host"].workerResponses).toBe(worker.record["host"].workerJobs);
    expect(worker.record["host"].workerDropped).toBe(0);
    // The plugin halves its output once its worker has answered; an unrun worker leaves it at the
    // plain level. -6.02 dB, measured.
    const delta = worker.record["rates"]["48000"].rmsDbfs - plain.record["rates"]["48000"].rmsDbfs;
    expect(delta).toBeGreaterThan(-6.5);
    expect(delta).toBeLessThan(-5.5);
  });

  live(
    "sweeps a patch:writable parameter through patch:Set, and the level moves",
    () => {
      const r = run("patch-gain", ["48000", "256", "2", "1"], { OMX_SOAK_SECONDS: "8", OMX_STIM: "noise" });
      expect(r.record["host"]).toMatchObject({ patchParams: 1, patchPort: true });
      expect(r.record["host"].patchSets).toBeGreaterThan(100);
      const s = r.record["soak"];
      expect(s.instantiated).toBe(true);
      // The gain goes 0..1 across the sweep: had the Sets never landed the level would be one number.
      expect(s.maxRmsDbfs - s.minRmsDbfs).toBeGreaterThan(6);
    },
    120_000,
  );

  live("without patch:Set the same plugin's level does not move (the injection is what moves it)", () => {
    // The rate probe never sweeps: the plugin sits at its default, so nothing has been sent.
    const r = run("patch-gain", ["48000", "256", "2", "1"], { OMX_PROBE_BLOCKS: "48" });
    expect(r.record["rates"]["48000"].rmsDbfs).toBeCloseTo(-29.03, 0);
  });

  live(
    "bounds the soak's sweep, and an unbounded sweep reaches the blast the bound prevents",
    () => {
      const bounded = run("wide-gain", ["48000", "256"], { OMX_SOAK_SECONDS: "45", OMX_STIM: "noise" });
      const unbounded = run("wide-gain", ["48000", "256"], { OMX_SOAK_SECONDS: "45", OMX_STIM: "noise", OMX_SWEEP_RATIO: "1e9" });
      // The noise is about -23 dBFS rms; a gain of 64 would put the output ~ +11 dBFS.
      expect(unbounded.record["soak"].maxRmsDbfs).toBeGreaterThan(5);
      const ceiling = -23 + 20 * Math.log10(SOAK_SWEEP_RATIO) + 1;
      expect(bounded.record["soak"].maxRmsDbfs).toBeLessThan(ceiling);
      expect(bounded.record["host"].sweepRatio).toBe(SOAK_SWEEP_RATIO);
    },
    240_000,
  );

  live("keeps a plugin's stdout banner out of the JSON line", () => {
    const r = run("banner", ["48000", "256", "2", "1"], { OMX_PROBE_BLOCKS: "24" });
    // stdout is the record and only the record: it parses as it stands (run() already parsed it).
    expect(r.stdout).not.toContain("using block size");
    expect(r.record["instantiated"]).toBe(true);
  });
});

describe("the measurer's sweep bounds", () => {
  it("are the TypeScript declarations (one value, two readers)", () => {
    const src = readFileSync(join(NATIVE, "lv2-measure.c"), "utf8");
    expect(Number(/#define SWEEP_DB_DEFAULT (\d+)/.exec(src)?.[1])).toBe(SOAK_SWEEP_DB);
    expect(Number(/#define SWEEP_RATIO_DEFAULT (\d+)/.exec(src)?.[1])).toBe(SOAK_SWEEP_RATIO);
  });
});
