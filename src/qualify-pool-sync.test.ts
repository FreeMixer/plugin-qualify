// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The pool step through the run a device makes. The records are the ones a Raspberry Pi 5 wrote under 0.16.1
 * (`fixtures/records-0.16.1/`), a CLAP plugin judged conditional (isolated, so its pin carries a verdict) and one that
 * is not a candidate for a worker of its own; the step is a stand-in that says what the host saw, and the live arms are in
 * `qualify-pool.test.ts`.
 */
import { afterAll, describe, expect, it } from "vitest";

import type { QualificationRecord } from "./qualification-record.js";
import { POOL_CODE, POOL_RESULT, POOL_STEP, type PoolRunFacts } from "./qualify-pool.js";
import { parseSyncArgs, runSync, summaryLine } from "./qualify-sync.js";
import { CLAP_NOTES, CLAP_RT, LV2_CLEAN, device, rejudge, removeDevices } from "./qualify-rejudge.support.js";

afterAll(removeDevices);

const win = (over: object = {}) => ({ alive: true, workers: 1, xruns: 0, finite: true, silent: false, dspLoad: 40, poolOfWorker: "qualified", ...over });
const FASTER: PoolRunFacts = { started: true, asks: true, added: true, off: win(), on: win({ dspLoad: 20, poolOfWorker: "on" }), poolApplied: true };
const NOT_FASTER: PoolRunFacts = { ...FASTER, on: win({ dspLoad: 39, poolOfWorker: "on" }) };
const NOT_ASKED: PoolRunFacts = { started: true, asks: false };
const NO_HOST: PoolRunFacts = { started: false, problem: "no jackd" };
const ENV = { OMX_PROBE_RUNNER: "/nonexistent", OMX_CLAP_QUALIFY: "/nonexistent" };
const ALONE = { started: true, added: true, alive: true, workers: 1, instancesInWorker: 1, latencyFrames: 128, cpuPercent: 3, xruns: 0, finite: true, silent: false };
const steps = (r: QualificationRecord) => r.run?.steps.filter((s) => s.step === POOL_STEP) ?? [];

/** A device whose record the isolated step has run for, as the pool step needs: a plugin the pass saw running alone. */
async function seen(stems: readonly string[]) {
  const d = device(stems);
  await rejudge(d);
  await runSync(d.settings, { isolatedOnly: true, isolatedRunner: () => ALONE, env: ENV, log: () => {} });
  return d;
}

describe("--pool-only", () => {
  it("is a run of its own: one at a time with the others, and never with --rejudge", () => {
    expect(parseSyncArgs(["--pool-only"]).ok).toBe(true);
    expect(parseSyncArgs(["--pool-only", "--isolated-only"]).ok).toBe(false);
    expect(parseSyncArgs(["--pool-only", "--rejudge"]).ok).toBe(false);
  });

  it("gives the pin of a plugin that gains from the pool pool=cores, and keeps its verdict", async () => {
    const d = await seen([CLAP_RT]);
    expect(d.pins()[0]).not.toHaveProperty("pool");
    const done = await runSync(d.settings, { poolOnly: true, poolRunner: () => FASTER, env: ENV, log: () => {} });
    expect(done?.poolOnly).toEqual({ cores: 1, off: 0, notAsked: 0, notRun: 0 });
    expect(summaryLine(done!)).toContain("pool granted 1");
    expect(d.pins()[0]).toMatchObject({ verdict: "isolated", pool: "cores" });
    expect(steps(d.record(CLAP_RT))).toEqual([expect.objectContaining({ result: POOL_RESULT.cores, pool: { dspLoadOff: 40, dspLoadOn: 20, xrunsOff: 0, xrunsOn: 0 } })]);
    expect(Object.values(d.state().entries)[0]!.plugins[0]!.pin).toMatchObject({ pool: "cores" });
  });

  it("a plugin measured and not faster gets pool=off, and one that does not ask for the pool gets none", async () => {
    const off = await seen([CLAP_RT]);
    await runSync(off.settings, { poolOnly: true, poolRunner: () => NOT_FASTER, env: ENV, log: () => {} });
    expect(off.pins()[0]).toMatchObject({ pool: "off" });
    expect(steps(off.record(CLAP_RT))[0]).toMatchObject({ result: POOL_RESULT.off, code: POOL_CODE.notFaster });

    const none = await seen([CLAP_RT]);
    const done = await runSync(none.settings, { poolOnly: true, poolRunner: () => NOT_ASKED, env: ENV, log: () => {} });
    expect(done?.poolOnly).toEqual({ cores: 0, off: 0, notAsked: 1, notRun: 0 });
    expect(none.pins()[0]).not.toHaveProperty("pool");
    expect(steps(none.record(CLAP_RT))[0]).toMatchObject({ result: POOL_RESULT.notAsked });
  });

  it("a second run asks nothing of a plugin the step decided, and asks again one it could not run", async () => {
    const d = await seen([CLAP_RT]);
    let ran = 0;
    const runner = (facts: PoolRunFacts) => () => {
      ran++;
      return facts;
    };
    await runSync(d.settings, { poolOnly: true, poolRunner: runner(NO_HOST), env: ENV, log: () => {} });
    expect(ran).toBe(1);
    expect(d.pins()[0]).not.toHaveProperty("pool");
    expect(steps(d.record(CLAP_RT))[0]).toMatchObject({ result: POOL_RESULT.notRun, code: POOL_CODE.noHost });
    const again = await runSync(d.settings, { poolOnly: true, poolRunner: runner(FASTER), env: ENV, log: () => {} });
    expect(ran).toBe(2);
    expect(again?.poolOnly).toMatchObject({ cores: 1, notRun: 0 });
    expect(steps(d.record(CLAP_RT))).toHaveLength(1);
    await runSync(d.settings, { poolOnly: true, poolRunner: runner(FASTER), env: ENV, log: () => {} });
    expect(ran).toBe(2);
  });

  it("an LV2 plugin is never asked", async () => {
    const d = await seen([LV2_CLEAN, CLAP_NOTES]);
    const asked: string[] = [];
    await runSync(d.settings, {
      poolOnly: true,
      poolRunner: (uri) => {
        asked.push(uri);
        return FASTER;
      },
      env: ENV,
      log: () => {},
    });
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((u) => u.startsWith("clap:"))).toBe(true);
    const lv2 = d.pins().find((p) => !p!.uri.startsWith("clap:"));
    expect(lv2).toBeDefined();
    expect(lv2).not.toHaveProperty("pool");
  });

  it("a re-judge keeps the pool word the record's step gave, measuring nothing", async () => {
    const d = await seen([CLAP_RT]);
    await runSync(d.settings, { poolOnly: true, poolRunner: () => FASTER, env: ENV, log: () => {} });
    expect(d.pins()[0]).toMatchObject({ pool: "cores" });
    await rejudge(d);
    expect(d.pins()[0]).toMatchObject({ verdict: "isolated", pool: "cores" });
  });
});
