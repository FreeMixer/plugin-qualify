// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * THE TIMING RUNS ON THE THREAD WHOSE POLICY THE RECORD READS (#214).
 *
 * plugin-hostd's probe measures at SCHED_FIFO and records `realtime.observed` from the measured child's main thread
 * right after exec (plugin-hostd#235). Those figures are FIFO figures only if clap-qualify and lv2_measure time the
 * plugin on that thread, or on one that inherits it: an explicit-scheduling attribute or a policy set on a thread
 * would put the measurement back on CFS while the record says fifo. Three facts of native/ hold that:
 *  - nothing in it sets a thread's scheduling (no PTHREAD_EXPLICIT_SCHED, pthread_attr_setinheritsched,
 *    pthread_attr_setschedpolicy/param, pthread_setschedparam, sched_setscheduler, sched_setparam);
 *  - clap-qualify and lv2_measure create no thread: their timing runs on the main thread;
 *  - a thread created anywhere else in native/ passes NULL attributes, so it inherits the creator's policy.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const NATIVE = join(dirname(fileURLToPath(import.meta.url)), "..", "native");
const SETS_SCHEDULING = /\b(PTHREAD_EXPLICIT_SCHED|pthread_attr_setinheritsched|pthread_attr_setschedpolicy|pthread_attr_setschedparam|pthread_setschedparam|sched_setscheduler|sched_setparam)\b/;
const CREATES_THREAD = /\bpthread_create\s*\(/;
const CREATE_WITH_ATTR = /\bpthread_create\s*\(\s*[^,]+,\s*(?!NULL\b)[^,\s][^,]*,/;
/** The measuring tools: the timing loop is theirs. */
const TIMING = /^(clap-qualify|lv2-measure[\w-]*)\.c$/;

/** What a source file breaks of the three facts: a list of reasons, empty when it holds them. */
function schedFindings(name: string, text: string): string[] {
  const out: string[] = [];
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  if (SETS_SCHEDULING.test(code)) out.push(`${name}: sets a thread's scheduling (${SETS_SCHEDULING.exec(code)![1]})`);
  if (TIMING.test(name) && CREATES_THREAD.test(code)) out.push(`${name}: a measuring tool creates a thread; its timing must stay on the main thread`);
  if (CREATE_WITH_ATTR.test(code)) out.push(`${name}: pthread_create with attributes; a thread here must inherit (NULL attributes)`);
  return out;
}

const sources = (): string[] => readdirSync(NATIVE).filter((f) => /\.[ch]$/.test(f));

describe("the timing thread inherits the probe's scheduling (#214)", () => {
  it("positive control: each fact's detector fires on a planted line", () => {
    expect(schedFindings("x.c", "pthread_attr_setinheritsched(&a, PTHREAD_EXPLICIT_SCHED);")).toHaveLength(1);
    expect(schedFindings("x.c", "sched_setscheduler(0, SCHED_OTHER, &p);")).toHaveLength(1);
    expect(schedFindings("clap-qualify.c", "pthread_create(&t, NULL, run, x);")).toHaveLength(1);
    expect(schedFindings("lv2-host-probe.c", "pthread_create(&t, &attr, run, x);")).toHaveLength(1);
    expect(schedFindings("lv2-host-probe.c", "pthread_create(&tid, NULL, worker_thread, h);")).toEqual([]);
    expect(schedFindings("x.c", "/* PTHREAD_EXPLICIT_SCHED is not used */")).toEqual([]);
  });

  it("native/ holds all three: no scheduling set, no thread in a measuring tool, every other thread inherits", () => {
    const files = sources();
    expect(files.filter((f) => TIMING.test(f)).length, "the measuring tools were not found").toBeGreaterThanOrEqual(2);
    expect(files.flatMap((f) => schedFindings(f, readFileSync(join(NATIVE, f), "utf8")))).toEqual([]);
  });
});
