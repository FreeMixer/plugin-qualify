// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * THE ISOLATED STEP (plugin-qualify#249). `verdict=isolated` means the plugin was seen running alone, each record shows the
 * steps that judged it, a record missing a step its outcome calls for is refused, and a completion adds only that step.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import type { QualificationRecord } from "./qualification-record.js";
import {
  ISOLATED_CODE,
  ISOLATED_RESULT,
  RUN_STEP,
  baseSteps,
  completeIsolated,
  judgeIsolatedRun,
  missingSteps,
  owesIsolated,
  pinAfterStep,
  provenAlone,
  spawnedIsolatedRunner,
  stepsCalledFor,
  type IsolatedRunFacts,
} from "./qualify-isolated.js";
import { isolatedPass, type SyncContext, type SyncState } from "./qualify-sync.js";

const scratch = mkdtempSync(join(tmpdir(), "qualify-isolated-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const CELL = { rate: 48000, quantum: 128 };
const WELL: IsolatedRunFacts = { started: true, added: true, alive: true, workers: 1, instancesInWorker: 1, latencyFrames: 128, cpuPercent: 12.5, xruns: 0, finite: true, silent: false, midiInputsLinked: 1 };
const pin = { uri: "urn:p", integrity: {}, verdict: "isolated" as const };

function record(over: { rating?: string; outcome?: string; run?: QualificationRecord["run"] } = {}): QualificationRecord {
  return {
    plugin: { format: "lv2", id: "urn:p" },
    verdicts: [{ host: "omx-clap-host", measured: true, rating: over.rating ?? "conditional", qualified: false, hosting: "isolated", arm: "run", reasons: [] }],
    cost: [{ host: "omx-clap-host", rate: 48000, quantum: 128, reasons: [] }],
    measurements: { grid: [{ rtSafety: {} }] },
    rejudged: { figures: { runId: "run-from-the-figures" } },
    probe: { file: "p.probe.json", outcome: over.outcome ?? "probe.ok" },
    ...(over.run === undefined ? {} : { run: over.run }),
  } as unknown as QualificationRecord;
}

describe("the decision table", () => {
  it("a plugin added, alive, alone and sounding is isolated, with the figures", () => {
    expect(judgeIsolatedRun(WELL)).toEqual({ step: "isolated", result: "isolated", figures: { latencyFrames: 128, cpuPercent: 12.5, xruns: 0, midiInputsLinked: 1 } });
  });

  it.each([
    ["never added", { ...WELL, added: false }, ISOLATED_CODE.notAdded],
    ["crashed in the window", { ...WELL, alive: false }, ISOLATED_CODE.crashed],
    ["no worker", { ...WELL, workers: 0 }, ISOLATED_CODE.noWorker],
    ["a second worker", { ...WELL, workers: 2 }, ISOLATED_CODE.notAlone],
    ["sharing its worker", { ...WELL, instancesInWorker: 2 }, ISOLATED_CODE.notAlone],
    ["silent output", { ...WELL, silent: true }, ISOLATED_CODE.silent],
    ["non-finite output", { ...WELL, finite: false }, ISOLATED_CODE.nonFinite],
    ["output nobody read", { started: true, added: true, alive: true, workers: 1, instancesInWorker: 1 }, ISOLATED_CODE.nonFinite],
  ] as const)("%s is refused, with the reason", (_name, facts, code) => {
    const step = judgeIsolatedRun(facts);
    expect(step.result).toBe(ISOLATED_RESULT.refused);
    expect(step.code).toBe(code);
  });

  it("silent says whether a note was linked", () => {
    expect(judgeIsolatedRun({ ...WELL, silent: true }).detail).toBe("notes held on 1 MIDI input and a sine at its audio inputs");
    expect(judgeIsolatedRun({ ...WELL, silent: true, midiInputsLinked: 0 }).detail).toBe("no note input to link: a sine played at its audio inputs");
  });

  it("a machine that could not run it decides nothing about the plugin", () => {
    const step = judgeIsolatedRun({ started: false, problem: "no jackd" });
    expect(step.result).toBe(ISOLATED_RESULT.notRun);
    expect(step.detail).toBe("no jackd");
  });

  it("the pin's word follows the step, and a step not run leaves no word", () => {
    expect(pinAfterStep({ uri: "u", integrity: {} }, judgeIsolatedRun(WELL))?.verdict).toBe("isolated");
    expect(pinAfterStep(pin, judgeIsolatedRun({ ...WELL, silent: true }))?.verdict).toBe("refused");
    expect(pinAfterStep(pin, judgeIsolatedRun({ started: false }))).toEqual({ uri: "urn:p", integrity: {} });
  });
});

describe("the steps a record's outcome calls for", () => {
  it("an RT-unsafe rating and a probe that crashed or hung take the isolated step; a suitable plugin does not", () => {
    expect(owesIsolated(record())).toBe(true);
    expect(owesIsolated(record({ rating: "unknown", outcome: "probe.crashed" }))).toBe(true);
    expect(owesIsolated(record({ rating: "unknown", outcome: "probe.timeout" }))).toBe(true);
    expect(owesIsolated(record({ rating: "suitable" }))).toBe(false);
    expect(stepsCalledFor(record({ rating: "suitable" }))).toEqual(["scan", "describe", "probe", "rt-safety"]);
  });

  it("sabotage: each step dropped from a whole run is named as missing, and the whole run lacks none", () => {
    const whole = [...baseSteps(record()), judgeIsolatedRun(WELL)];
    expect(missingSteps(record({ run: { id: "r", steps: whole } }))).toEqual([]);
    for (const dropped of Object.values(RUN_STEP)) {
      const run = { id: "r", steps: whole.filter((s) => s.step !== dropped) };
      expect(missingSteps(record({ run }))).toEqual([dropped]);
    }
  });

  it("a record from before the steps lacks none: it owes a completion, not a new measurement", () => {
    expect(missingSteps(record())).toEqual([]);
  });

  it("only a step that saw it alone proves it: an old record's word does not, nor a refusal, nor a step not run", () => {
    expect(provenAlone(record())).toBe(false);
    const after = (facts: IsolatedRunFacts) => record({ run: { id: "r", steps: [...baseSteps(record()), judgeIsolatedRun(facts)] } });
    expect(provenAlone(after(WELL))).toBe(true);
    expect(provenAlone(after({ ...WELL, silent: true }))).toBe(false);
    expect(provenAlone(after({ started: false }))).toBe(false);
  });
});

describe("the step itself, on a private server", () => {
  const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "native", "build", "fixtures", "rt-safe.clap");
  const ID = "org.freemixer.plugin-qualify.fixture.rt-safe";
  const SYNTH = join(dirname(FIXTURE), "synth.clap");
  const SYNTH_ID = "org.freemixer.plugin-qualify.fixture.synth";
  const installed = (tool: string): boolean => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;
  const ready = existsSync(FIXTURE) && installed("jackd") && installed("plugin-hostd");

  it("the fixture gain runs alone and sounds: isolated, with the figures of its window", (ctx) => {
    if (!ready) {
      if (process.env["CI"] !== undefined) throw new Error("jackd, plugin-hostd or native/build is missing: CI installs them");
      ctx.skip("needs jackd, plugin-hostd and native/build");
    }
    const facts = spawnedIsolatedRunner()(`clap:${FIXTURE}#${ID}`, CELL, process.env);
    const step = judgeIsolatedRun(facts);
    expect(step.result, JSON.stringify(facts)).toBe(ISOLATED_RESULT.isolated);
    expect(facts.xruns).toBeGreaterThanOrEqual(0);
    expect(facts.cpuPercent).toBeGreaterThanOrEqual(0);
  });

  it("an instrument, silent until it hears a note, gets the note and sounds: isolated", (ctx) => {
    if (!ready) {
      if (process.env["CI"] !== undefined) throw new Error("jackd, plugin-hostd or native/build is missing: CI installs them");
      ctx.skip("needs jackd, plugin-hostd and native/build");
    }
    const facts = spawnedIsolatedRunner()(`clap:${SYNTH}#${SYNTH_ID}`, CELL, process.env);
    const step = judgeIsolatedRun(facts);
    expect(step.result, JSON.stringify(facts)).toBe(ISOLATED_RESULT.isolated);
    expect(facts.midiInputsLinked, JSON.stringify(facts)).toBeGreaterThan(0);
  });

  it("a drum kit, which answers only some keys with a short hit, is heard: isolated", (ctx) => {
    if (!ready) {
      if (process.env["CI"] !== undefined) throw new Error("jackd, plugin-hostd or native/build is missing: CI installs them");
      ctx.skip("needs jackd, plugin-hostd and native/build");
    }
    const facts = spawnedIsolatedRunner()(`clap:${join(dirname(FIXTURE), "synth-drum.clap")}#${SYNTH_ID}-drum`, CELL, process.env);
    expect(judgeIsolatedRun(facts).result, JSON.stringify(facts)).toBe(ISOLATED_RESULT.isolated);
  });

  it("a pass runs the step plugin after plugin: the server of the last one leaves its name free", (ctx) => {
    if (!ready) {
      if (process.env["CI"] !== undefined) throw new Error("jackd, plugin-hostd or native/build is missing: CI installs them");
      ctx.skip("needs jackd, plugin-hostd and native/build");
    }
    const runner = spawnedIsolatedRunner();
    for (const run of ["first", "second", "third"]) {
      const facts = runner(`clap:${FIXTURE}#${ID}`, CELL, process.env);
      expect(judgeIsolatedRun(facts).result, `${run}: ${JSON.stringify(facts)}`).toBe(ISOLATED_RESULT.isolated);
    }
  });
});

describe("the completion of a record already judged", () => {
  const write = (r: QualificationRecord, name: string): string => {
    const path = join(scratch, name);
    writeFileSync(path, JSON.stringify(r));
    return path;
  };

  it("adds the step and keeps the run's id; the rest of the record is untouched", () => {
    const steps = baseSteps(record());
    const before = record({ run: { id: "run-1", steps } });
    const path = write(before, "keep.qualification.json");
    const done = completeIsolated(path, before, "urn:p", CELL, () => WELL, {});
    const after = JSON.parse(readFileSync(path, "utf8")) as QualificationRecord;
    expect(after.run?.id).toBe("run-1");
    expect(after.run?.steps).toEqual([...steps, done?.step]);
    expect({ ...after, run: undefined }).toEqual(JSON.parse(JSON.stringify({ ...before, run: undefined })));
  });

  it("a record with no run takes the id of its figures", () => {
    const path = write(record(), "old.qualification.json");
    expect(completeIsolated(path, record(), "urn:p", CELL, () => WELL, {})?.record.run?.id).toBe("run-from-the-figures");
  });

  it("runs nothing when the record owes nothing, or has the step already", () => {
    let ran = 0;
    const runner = () => {
      ran++;
      return WELL;
    };
    const suitable = record({ rating: "suitable" });
    expect(completeIsolated(write(suitable, "s.qualification.json"), suitable, "urn:p", CELL, runner, {})).toBeUndefined();
    const done = record({ run: { id: "r", steps: [...baseSteps(record()), judgeIsolatedRun(WELL)] } });
    expect(completeIsolated(write(done, "d.qualification.json"), done, "urn:p", CELL, runner, {})).toBeUndefined();
    expect(ran).toBe(0);
  });

  it("a step that could not run is tried again and replaced; one that ran is not", () => {
    const notRun = judgeIsolatedRun({ started: false, problem: "no server" });
    const before = record({ run: { id: "r", steps: [...baseSteps(record()), notRun] } });
    const path = write(before, "again.qualification.json");
    const done = completeIsolated(path, before, "urn:p", CELL, () => WELL, {});
    expect(done?.step.result).toBe(ISOLATED_RESULT.isolated);
    const isolatedSteps = (JSON.parse(readFileSync(path, "utf8")) as QualificationRecord).run?.steps.filter((s) => s.step === "isolated");
    expect(isolatedSteps).toEqual([done?.step]);
    // silence from the tool that played its note before the link says nothing; silence that heard the notes does
    const { midiInputsLinked: _linked, ...beforeTheLink } = WELL;
    const unheard = judgeIsolatedRun({ ...beforeTheLink, silent: true });
    const old = record({ run: { id: "r", steps: [...baseSteps(record()), unheard] } });
    expect(completeIsolated(write(old, "unheard.qualification.json"), old, "urn:p", CELL, () => WELL, {})?.step.result).toBe(ISOLATED_RESULT.isolated);
    const heard = record({ run: { id: "r", steps: [...baseSteps(record()), judgeIsolatedRun({ ...WELL, silent: true })] } });
    expect(completeIsolated(write(heard, "heard.qualification.json"), heard, "urn:p", CELL, () => WELL, {})).toBeUndefined();
    const refused = judgeIsolatedRun({ started: true, added: false });
    const seen = record({ run: { id: "r", steps: [...baseSteps(record()), refused] } });
    expect(completeIsolated(write(seen, "seen.qualification.json"), seen, "urn:p", CELL, () => WELL, {})).toBeUndefined();
  });

  it("the pass moves each pin with its step, counts them, and a second pass runs only the step that could not run", () => {
    const dir = mkdtempSync(join(scratch, "pass-"));
    const names = ["a", "b", "c"].map((n) => `${n}.qualification.json`);
    for (const n of names) writeFileSync(join(dir, n), JSON.stringify(record()));
    const facts: Record<string, IsolatedRunFacts> = { "urn:a": WELL, "urn:b": { ...WELL, silent: true }, "urn:c": { started: false, problem: "no jackd" } };
    const ctx = { settings: { qualificationDir: dir, hostProfile: { id: "omx-clap-host" } }, env: {}, log: () => {}, isolatedRunner: (uri: string) => facts[uri]! } as unknown as SyncContext;
    const state = {
      entries: { k: { plugins: ["a", "b", "c"].map((n) => ({ uri: `urn:${n}`, outcome: "qualified", record: join(dir, `${n}.qualification.json`), pin: { uri: `urn:${n}`, integrity: {}, verdict: "isolated" } })) } },
    } as unknown as SyncState;
    const first = isolatedPass(ctx, state);
    expect(first).toMatchObject({ isolated: 1, refused: 1, notRun: 1 });
    const [a, b, c] = first.state.entries["k"]!.plugins;
    expect([a?.outcome, a?.pin?.verdict]).toEqual(["qualified", "isolated"]);
    expect([b?.outcome, b?.pin?.verdict, b?.code]).toEqual(["refused", "refused", ISOLATED_CODE.silent]);
    expect([c?.outcome, c?.pin?.verdict]).toEqual(["unmeasured", undefined]);
    const second = isolatedPass(ctx, first.state);
    expect(second).toMatchObject({ isolated: 0, refused: 0, notRun: 1 });
  });
});
