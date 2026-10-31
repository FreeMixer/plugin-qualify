// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Each cost figure says what it was timed under (#214): the two measurers read the policy and priority on the thread
 * that runs the clock and print them beside the figure, so a record taken at SCHED_FIFO is known to be one. The live
 * tests run the built tools, as the runner is scheduled and, where the kernel grants it, under chrt at FIFO 7.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseClapQualifyLine, isClapCostFigure } from "./clap-qualify.js";
import { readTimingScheduling } from "./measurement/format.js";
import { clapQualifyToolPath, rtInterposePath } from "./tool-paths.js";

const BUILD = join(dirname(fileURLToPath(import.meta.url)), "..", "native", "build");
const MEASURE = join(BUILD, "lv2_measure");
const LV2_FIXTURES = join(BUILD, "fixtures", "lv2");
const GAIN_LV2 = "urn:plugin-qualify:fixture:lv2-rt-safe";
const GAIN_CLAP = join(BUILD, "fixtures", "rt-safe.clap");
const RATE = 48000;
const BUILT = [MEASURE, clapQualifyToolPath(), rtInterposePath(), GAIN_CLAP].every((p) => existsSync(p));

/** The measurers' own view of how this process runs: SCHED_OTHER at 0 unless the runner itself is real time. */
function runnerPolicy(): { policy: string; priority: number } {
  const sched = readFileSync("/proc/self/sched", "utf8");
  const policy = Number(/^policy\s*:\s*(\d+)/m.exec(sched)?.[1]);
  const prio = Number(/^prio\s*:\s*(\d+)/m.exec(sched)?.[1]);
  return policy === 1 ? { policy: "fifo", priority: 99 - prio } : { policy: "other", priority: 0 };
}

const FIFO_GRANTED = spawnSync("chrt", ["-f", "7", "true"]).status === 0;

function clapFigure(prefix: readonly string[]): unknown {
  const args = ["--rates", String(RATE), "--block", "512", "--blocks", "16", GAIN_CLAP];
  const [cmd, ...rest] = [...prefix, clapQualifyToolPath(), ...args];
  const r = spawnSync(cmd!, rest, { encoding: "utf8", env: { ...process.env, LD_PRELOAD: rtInterposePath() } });
  expect(r.status, r.stderr).toBe(0);
  const at = parseClapQualifyLine(r.stdout.trim().split("\n")[0]!).cost?.perRate[String(RATE)];
  if (at === undefined || !isClapCostFigure(at)) throw new Error(`no figure: ${r.stdout}`);
  return at.scheduling;
}

function lv2Figure(prefix: readonly string[]): unknown {
  const [cmd, ...rest] = [...prefix, MEASURE, GAIN_LV2, String(RATE), "512", "1", "1"];
  const r = spawnSync(cmd!, rest, {
    encoding: "utf8",
    env: { PATH: process.env["PATH"], LV2_PATH: LV2_FIXTURES, LD_PRELOAD: rtInterposePath() },
  });
  expect(r.status, r.stderr).toBe(0);
  const line = JSON.parse(r.stdout) as { cost: { perRate: Record<string, { scheduling?: unknown }> } };
  return line.cost.perRate[String(RATE)]?.scheduling;
}

describe("a cost figure says what it was timed under", () => {
  for (const [tool, figure] of [["clap-qualify", clapFigure], ["lv2_measure", lv2Figure]] as const) {
    it(`${tool} prints the policy this process runs at`, (ctx) => {
      if (!BUILT) {
        if (process.env["CI"]) throw new Error("native/build is missing: CI builds it with make -C native deps all");
        ctx.skip("native/build is missing: make -C native deps all");
      }
      expect(figure([])).toEqual(runnerPolicy());
    });

    it(`${tool} prints fifo and the priority when it is run at FIFO`, (ctx) => {
      if (!BUILT || !FIFO_GRANTED) ctx.skip("this kernel grants no SCHED_FIFO here, or native/build is missing");
      expect(figure(["chrt", "-f", "7"])).toEqual({ policy: "fifo", priority: 7 });
    });
  }

  it("the reader takes both fields or neither", () => {
    expect(readTimingScheduling({ policy: "fifo", priority: 7 })).toEqual({ policy: "fifo", priority: 7 });
    expect(readTimingScheduling({ policy: "fifo" })).toBeUndefined();
    expect(readTimingScheduling({ priority: 7 })).toBeUndefined();
    expect(readTimingScheduling({ policy: "", priority: 0 })).toBeUndefined();
    expect(readTimingScheduling(undefined)).toBeUndefined();
  });
});
