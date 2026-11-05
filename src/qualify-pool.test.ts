// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * THE POOL STEP. The pin's `pool=cores` word is the plugin's qualification to give: it is written when the plugin asks for
 * clap.thread-pool, is safe with the pool on and is faster with it, and by nothing else. The decision table is pure; the
 * live arms run the step on a private JACK server under a real plugin-hostd with omx-clap-host's pool, on fixtures that
 * ask for the pool and gain from it, gain nothing, have nothing to run in parallel, or never ask.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { PIN_POOLS, pinLine, type PinEntry } from "./pins-file.js";
import type { QualificationRecord, RunStep } from "./qualification-record.js";
import {
  POOL_CODE,
  POOL_GAIN,
  POOL_MIN_GAIN,
  POOL_RESULT,
  POOL_STEP,
  judgePoolRun,
  owesPool,
  pinAfterPool,
  poolWordOf,
  spawnedPoolRunner,
  withPoolStep,
  completePool,
  type PoolRunFacts,
  type PoolWindowFacts,
} from "./qualify-pool.js";

const CELL = { rate: 48000, quantum: 128 };
const win = (over: Partial<PoolWindowFacts> = {}): PoolWindowFacts => ({ alive: true, workers: 1, xruns: 0, finite: true, silent: false, dspLoad: 40, poolOfWorker: "qualified", ...over });
/** A plugin that asks, runs under both words, and is twice as fast with the pool. */
const FASTER: PoolRunFacts = { started: true, asks: true, added: true, off: win(), on: win({ dspLoad: 20, poolOfWorker: "on" }), poolApplied: true };
const A = "a".repeat(64);
const B = "b".repeat(64);
const pin = (extra: Partial<PinEntry> = {}): PinEntry => ({
  uri: "clap:/p/x.clap#id",
  integrity: { files: [{ path: "x.clap", sha256: A }], layout: { scheme: "omx-layout/1", sha256: B } },
  ...extra,
});

describe("the decision table", () => {
  it("a plugin safe and faster with the pool is granted it, with the figures that decided", () => {
    expect(judgePoolRun(FASTER)).toEqual({
      step: POOL_STEP,
      result: POOL_RESULT.cores,
      pool: { dspLoadOff: 40, dspLoadOn: 20, xrunsOff: 0, xrunsOn: 0 },
    });
  });

  it("the gain is a ratio of the loads: just inside it is granted, just outside it is not", () => {
    const at = (ratio: number) => judgePoolRun({ ...FASTER, on: win({ dspLoad: 40 * ratio, poolOfWorker: "on" }) });
    expect(at(POOL_GAIN - 0.01).result).toBe(POOL_RESULT.cores);
    expect(at(POOL_GAIN + 0.01)).toMatchObject({ result: POOL_RESULT.off, code: POOL_CODE.notFaster });
    expect(at(1.2)).toMatchObject({ result: POOL_RESULT.off, code: POOL_CODE.notFaster });
  });

  it("a fall of a few points of a small load is not a gain, whatever its ratio", () => {
    const small = judgePoolRun({ ...FASTER, off: win({ dspLoad: 6 }), on: win({ dspLoad: 6 - (POOL_MIN_GAIN - 0.5), poolOfWorker: "on" }) });
    expect(small).toMatchObject({ result: POOL_RESULT.off, code: POOL_CODE.notFaster });
    const enough = judgePoolRun({ ...FASTER, off: win({ dspLoad: 6 }), on: win({ dspLoad: 6 - (POOL_MIN_GAIN + 0.5), poolOfWorker: "on" }) });
    expect(enough.result).toBe(POOL_RESULT.cores);
  });

  it("a window whose load was not read decides nothing", () => {
    const { dspLoad: _l, ...unread } = win({ poolOfWorker: "on" });
    expect(judgePoolRun({ ...FASTER, on: unread })).toMatchObject({ result: POOL_RESULT.notRun, code: POOL_CODE.windowFailed });
  });

  it("more xruns with the pool than without is off; as many is not", () => {
    expect(judgePoolRun({ ...FASTER, on: win({ dspLoad: 20, xruns: 3, poolOfWorker: "on" }) })).toMatchObject({ result: POOL_RESULT.off, code: POOL_CODE.xruns });
    const noisy = { ...FASTER, off: win({ xruns: 3 }), on: win({ dspLoad: 20, xruns: 3, poolOfWorker: "on" }) };
    expect(judgePoolRun(noisy).result).toBe(POOL_RESULT.cores);
  });

  it.each([
    ["a worker that died with the pool", { alive: false, problem: "gone" }, POOL_CODE.crashed],
    ["output that is not finite with the pool", { finite: false }, POOL_CODE.unsafeOutput],
    ["silence with the pool", { silent: true }, POOL_CODE.unsafeOutput],
  ] as const)("%s is off, with the reason", (_what, over, code) => {
    const step = judgePoolRun({ ...FASTER, on: win({ dspLoad: 20, poolOfWorker: "on", ...over }) });
    expect(step).toMatchObject({ result: POOL_RESULT.off, code });
  });

  it("a plugin that does not offer the pool is not asked, and its step carries no figures", () => {
    expect(judgePoolRun({ started: true, asks: false })).toEqual({ step: POOL_STEP, result: POOL_RESULT.notAsked });
  });

  it.each([
    ["a machine that could not run it", { started: false, problem: "no jackd" }, POOL_CODE.noHost],
    ["a plugin that was not added", { started: true, asks: true, added: false, problem: "add answered -1" }, POOL_CODE.notAdded],
    ["a window without the pool that failed", { ...FASTER, off: win({ problem: "isolated_signal: no ports", alive: false }) }, POOL_CODE.windowFailed],
    ["a window without the pool whose output is not finite", { ...FASTER, off: win({ finite: false }) }, POOL_CODE.windowFailed],
    ["a daemon that did not start the worker with the pool", { ...FASTER, poolApplied: false }, POOL_CODE.notApplied],
    ["a window with the pool that failed to run", { ...FASTER, on: win({ problem: "isolated_signal: no ports", poolOfWorker: "on" }) }, POOL_CODE.windowFailed],
  ] as const)("%s decides nothing: not-run, tried again", (_what, facts, code) => {
    const step = judgePoolRun(facts as PoolRunFacts);
    expect(step.result).toBe(POOL_RESULT.notRun);
    expect(step.code).toBe(code);
  });

  it("the words the step grants are the pin's own", () => {
    for (const result of [POOL_RESULT.cores, POOL_RESULT.off]) expect(PIN_POOLS).toContain(result);
  });
});

describe("the pin follows the step", () => {
  it("cores and off become the pin's pool word, and the line carries it after the verdict", () => {
    const granted = pinAfterPool(pin({ verdict: "isolated" }), judgePoolRun(FASTER))!;
    expect(granted.pool).toBe("cores");
    expect(pinLine(granted)).toBe(`pin_set clap:/p/x.clap#id x.clap=${A} omx-layout/1:${B} verdict=isolated pool=cores`);
    expect(pinAfterPool(pin({ verdict: "isolated" }), judgePoolRun({ ...FASTER, on: win({ dspLoad: 39, poolOfWorker: "on" }) }))!.pool).toBe("off");
  });

  it("a plugin not asked, or a step not run, leaves no word, and takes away one an earlier step gave", () => {
    expect(pinAfterPool(pin({ pool: "cores" }), judgePoolRun({ started: true, asks: false }))).not.toHaveProperty("pool");
    expect(pinAfterPool(pin({ pool: "cores" }), judgePoolRun({ started: false }))).not.toHaveProperty("pool");
    expect(pinAfterPool(pin({ pool: "cores" }), undefined)).not.toHaveProperty("pool");
  });

  it("a refused plugin is granted nothing, whatever it measured", () => {
    expect(pinAfterPool(pin({ verdict: "refused" }), judgePoolRun(FASTER))).not.toHaveProperty("pool");
  });

  it("only cores and off are words", () => {
    expect(poolWordOf({ step: POOL_STEP, result: POOL_RESULT.cores })).toBe("cores");
    expect(poolWordOf({ step: POOL_STEP, result: POOL_RESULT.off })).toBe("off");
    expect(poolWordOf({ step: POOL_STEP, result: POOL_RESULT.notAsked })).toBeUndefined();
    expect(poolWordOf({ step: "isolated", result: "cores" })).toBeUndefined();
  });
});

function record(over: { format?: string; rating?: string; steps?: RunStep[]; run?: boolean } = {}): QualificationRecord {
  return {
    plugin: { format: over.format ?? "clap", id: "id" },
    verdicts: [{ host: "omx-clap-host", measured: true, rating: over.rating ?? "suitable", qualified: true, hosting: "in-process", arm: "run", reasons: [] }],
    ...(over.run === false ? {} : { run: { id: "r", steps: over.steps ?? [{ step: "probe", result: "probe.ok" }] } }),
  } as unknown as QualificationRecord;
}

describe("what owes the step", () => {
  it("a CLAP plugin judged in a pass with steps, not refused, with no decided pool step", () => {
    expect(owesPool(record())).toBe(true);
    expect(owesPool(record({ rating: "conditional" }))).toBe(true);
  });

  it("an LV2 plugin, a refused one, one rated unsuitable and a record from before the steps do not", () => {
    expect(owesPool(record({ format: "lv2" }))).toBe(false);
    expect(owesPool(record({ steps: [{ step: "isolated", result: "refused" }] }))).toBe(false);
    expect(owesPool(record({ rating: "unsuitable" }))).toBe(false);
    expect(owesPool(record({ run: false }))).toBe(false);
  });

  it("a decided step is not run again, and a step that could not run is", () => {
    for (const result of [POOL_RESULT.cores, POOL_RESULT.off, POOL_RESULT.notAsked]) expect(owesPool(record({ steps: [{ step: POOL_STEP, result }] }))).toBe(false);
    expect(owesPool(record({ steps: [{ step: POOL_STEP, result: POOL_RESULT.notRun }] }))).toBe(true);
  });

  it("a new step takes the place of the old one", () => {
    const steps = withPoolStep([{ step: "probe", result: "probe.ok" }, { step: POOL_STEP, result: POOL_RESULT.notRun }], { step: POOL_STEP, result: POOL_RESULT.cores });
    expect(steps.map((s) => `${s.step}:${s.result}`)).toEqual(["probe:probe.ok", "pool:cores"]);
  });
});

describe("the step itself, on a private server, under a real plugin-hostd with omx-clap-host's pool", () => {
  const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "native", "build", "fixtures");
  const installed = (tool: string): boolean => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;
  const uri = (file: string, id: string): string => `clap:${join(FIXTURES, file)}#org.freemixer.plugin-qualify.fixture.${id}`;
  const ready = existsSync(join(FIXTURES, "pool-synth.clap")) && installed("jackd") && installed("plugin-hostd") && installed("omx-clap-host");
  const run = (file: string, id: string): PoolRunFacts => spawnedPoolRunner()(uri(file, id), CELL, process.env);
  /**
   * A gain is only ever lost to what else runs on the machine (the helpers need idle cores), never made by it, so an arm
   * that expects the pool to be granted may take it from the best of three runs; the arms that expect it refused take the
   * first, since no run may grant it.
   */
  const granted = (file: string, id: string, uriOf: (f: string, i: string) => string = uri): { facts: PoolRunFacts; step: ReturnType<typeof judgePoolRun>; tries: number } => {
    let last: { facts: PoolRunFacts; step: ReturnType<typeof judgePoolRun> } | undefined;
    for (let tries = 1; tries <= 3; tries++) {
      const facts = spawnedPoolRunner()(uriOf(file, id), CELL, process.env);
      last = { facts, step: judgePoolRun(facts) };
      if (last.step.result === POOL_RESULT.cores) return { ...last, tries };
    }
    return { ...last!, tries: 3 };
  };
  const need = (ctx: { skip: (why: string) => void }): void => {
    if (ready) return;
    if (process.env["CI"] !== undefined) throw new Error("jackd, plugin-hostd, omx-clap-host or native/build is missing: CI installs them");
    ctx.skip("needs jackd, plugin-hostd, omx-clap-host and native/build");
  };

  it("an instrument that asks for the pool and has voices to share is granted cores, the worker having started with it", (ctx) => {
    need(ctx);
    const { facts, step, tries } = granted("pool-synth.clap", "pool-synth");
    expect(facts.asks, JSON.stringify(facts)).toBe(true);
    expect(facts.poolApplied, JSON.stringify(facts)).toBe(true);
    expect(facts.off?.poolOfWorker).not.toBe("on");
    expect(facts.on?.poolOfWorker).toBe("on");
    expect(step.result, JSON.stringify({ facts, step, tries })).toBe(POOL_RESULT.cores);
    expect(step.pool!.dspLoadOn).toBeLessThan(step.pool!.dspLoadOff * POOL_GAIN);
  });

  it("one whose tasks fight over a lock asks and gains nothing: off", (ctx) => {
    need(ctx);
    const facts = run("pool-synth-slow.clap", "pool-synth-slow");
    expect(facts.poolApplied, JSON.stringify(facts)).toBe(true);
    expect(judgePoolRun(facts).result, JSON.stringify(facts)).toBe(POOL_RESULT.off);
  });

  it("one with next to nothing to do has nothing to run in parallel: off", (ctx) => {
    need(ctx);
    const facts = run("pool-synth-quiet.clap", "pool-synth-quiet");
    expect(judgePoolRun(facts), JSON.stringify(facts)).toMatchObject({ result: POOL_RESULT.off, code: POOL_CODE.notFaster });
  });

  it("one that never offers the extension is not asked, and the daemon is not started for it", (ctx) => {
    need(ctx);
    const facts = run("pool-synth-serial.clap", "pool-synth-serial");
    expect(facts).toEqual({ started: true, asks: false });
  });

  it("the real omx-test-pool-voice is granted the pool too, when OMX_TEST_POOL_VOICE names its .clap", (ctx) => {
    need(ctx);
    const clap = process.env["OMX_TEST_POOL_VOICE"];
    if (clap === undefined) return ctx.skip("OMX_TEST_POOL_VOICE names omx-plugins' build/omx-test-pool-voice.clap: no release carries it yet");
    const { facts, step, tries } = granted(clap, "org.openmixer.test-pool-voice", (f, i) => `clap:${f}#${i}`);
    expect(step.result, JSON.stringify({ facts, step, tries })).toBe(POOL_RESULT.cores);
  });
});

describe("the completion of a record already judged", () => {
  const scratch = mkdtempSync(join(tmpdir(), "qualify-pool-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const write = (r: QualificationRecord, name: string): string => {
    const path = join(scratch, name);
    writeFileSync(path, JSON.stringify(r));
    return path;
  };
  const rec = (steps: RunStep[]): QualificationRecord => ({ ...record({ steps }), rejudged: { figures: { runId: "run-from-the-figures" } } }) as unknown as QualificationRecord;

  it("adds the step and keeps the run's id and its other steps; the rest of the record is untouched", () => {
    const before = rec([{ step: "probe", result: "probe.ok" }]);
    const path = write(before, "keep.qualification.json");
    const done = completePool(path, before, "clap:/p.clap#id", CELL, () => FASTER, {});
    const after = JSON.parse(readFileSync(path, "utf8")) as QualificationRecord;
    expect(done?.step.result).toBe(POOL_RESULT.cores);
    expect(after.run?.id).toBe("r");
    expect(after.run?.steps).toEqual([{ step: "probe", result: "probe.ok" }, done?.step]);
    expect({ ...after, run: undefined }).toEqual(JSON.parse(JSON.stringify({ ...before, run: undefined })));
  });

  it("runs nothing for a record that owes nothing, and runs again the step that could not run", () => {
    let ran = 0;
    const runner = (): PoolRunFacts => {
      ran++;
      return FASTER;
    };
    const decided = rec([{ step: POOL_STEP, result: POOL_RESULT.off }]);
    expect(completePool(write(decided, "decided.qualification.json"), decided, "u", CELL, runner, {})).toBeUndefined();
    expect(ran).toBe(0);
    const notRun = rec([{ step: POOL_STEP, result: POOL_RESULT.notRun, code: POOL_CODE.noHost }]);
    const path = write(notRun, "again.qualification.json");
    expect(completePool(path, notRun, "u", CELL, runner, {})?.step.result).toBe(POOL_RESULT.cores);
    expect((JSON.parse(readFileSync(path, "utf8")) as QualificationRecord).run?.steps.filter((s) => s.step === POOL_STEP)).toHaveLength(1);
    expect(ran).toBe(1);
  });
});
