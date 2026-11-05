#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
// The pool step: does the CLAP thread pool help this plugin, and is it safe? A plugin-hostd of its own on the JACK server
// the environment names. The plugin is added once so the daemon learns its pin, and the pin is then set twice, `pool=off`
// and `pool=cores`, twice each in turn: each time the plugin is added alone in a worker (the daemon starts that worker with
// the thread pool on only for `pool=cores`), the same notes are played through it for a window, and the window's xruns,
// its output and the server's DSP load are read; a mode is judged by its best window. Prints one JSON line for src/qualify-pool.ts to judge. A host that never listened says so:
// nothing was learned about the plugin then. That the plugin asks for the pool at all is the caller's to know first.
//
//   pool-step.mjs <clap uri> <window ms>
//   environment: OMX_ISOLATED_SIGNAL (the signal tool), PLUGIN_HOSTD
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pinWord, pinWords } from "../dist/pins-file.js";

const [uri, windowMsWord] = process.argv.slice(2);
const windowMs = Number(windowMsWord);
const signalTool = process.env.OMX_ISOLATED_SIGNAL;
const hostd = process.env.PLUGIN_HOSTD ?? "plugin-hostd";
const port = 40000 + (process.pid % 20000);
const CONNECT_TRIES = 50;
const COMMAND_MS = Number(process.env.OMX_ADMIT_STEP_MS ?? 0) || 30000;
const INSTANCE = 0;
const WORKER_SPAWN = -503;
/** How many times each mode is run, the two alternating. */
const ROUNDS = 2;
/** hostd's worker_list field for a worker started with the thread pool on. */
const POOL_ON = "on";

const state = mkdtempSync(join(tmpdir(), "plugin-qualify-pool-"));
const host = spawn(hostd, ["-n", "-p", String(port)], { stdio: "ignore", detached: true, env: { ...process.env, XDG_STATE_HOME: state } });
let ended = false;
host.on("exit", () => (ended = true));
host.on("error", () => (ended = true));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < CONNECT_TRIES && !ended; i++) {
    const s = await new Promise((resolve) => {
      const c = createConnection({ port, host: "127.0.0.1" }, () => resolve(c));
      c.on("error", () => resolve(undefined));
    });
    if (s !== undefined) return s;
    await sleep(100);
  }
  return undefined;
}

function commander(sock) {
  let buffer = "";
  let closed = false;
  sock.on("data", (d) => (buffer += d.toString()));
  sock.on("close", () => (closed = true));
  sock.on("error", () => (closed = true));
  return async (line) => {
    buffer = "";
    sock.write(`${line}\0`);
    const until = Date.now() + COMMAND_MS;
    while (Date.now() < until && !closed) {
      const m = /resp (-?\d+)([^\0]*)\0?/.exec(buffer);
      if (m !== null && buffer.includes("\0")) return { code: Number(m[1]), rest: m[2].trim() };
      await sleep(20);
    }
    return undefined;
  };
}

/** `<worker>:<pid>:<format>:<state>:<core>:<pool>:<place>:<i>,<i>,...` per worker. */
const workersOf = (answer) =>
  (answer?.rest ?? "").split(/\s+/).filter(Boolean).map((w) => {
    const f = w.split(":");
    return { pid: Number(f[1]), pool: f[5], instances: (f[7] ?? "").split(",").filter(Boolean) };
  });

/** The pin the daemon learned for the uri, as its store holds it: the files and the layout words, and none of the optional ones. */
function learnedPin() {
  let text;
  try {
    text = readFileSync(join(state, "plugin-hostd", "pins"), "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split("\n")) {
    // the store writes the uri as it is: look for it as a prefix, whatever it holds
    const head = `pin_set ${uri} `;
    const quoted = `pin_set ${pinWord(uri)} `;
    const rest = line.startsWith(quoted) ? line.slice(quoted.length) : line.startsWith(head) ? line.slice(head.length) : undefined;
    if (rest === undefined) continue;
    const words = pinWords(rest);
    if (words.length >= 2) return { files: words[0], layout: words[1] };
  }
  return undefined;
}

/** One window: the plugin added alone under `pool=<word>`, the notes played, what was seen. */
async function window(send, pool, pin) {
  const set = await send(`pin_set ${pinWord(uri)} ${pinWord(pin.files)} ${pin.layout} pool=${pool}`);
  if (set === undefined || set.code !== 0) return { problem: `pin_set pool=${pool} answered ${set === undefined ? "nothing" : String(set.code)}` };
  const added = await send(`add ${pinWord(uri)} ${String(INSTANCE)}`);
  if (added?.code === WORKER_SPAWN) return { problem: `no worker came up: add answered ${String(WORKER_SPAWN)}` };
  if (added === undefined || added.code < 0) return { problem: added === undefined ? "the host gave no answer to add" : `add answered ${String(added.code)}` };
  const workers = workersOf(await send("worker_list"));
  const worker = workers[0];
  const heard = spawnSync(signalTool, [`effect_${String(INSTANCE)}`, String(windowMs)], { encoding: "utf8", timeout: windowMs + 15000, killSignal: "SIGKILL" });
  const after = workersOf(await send("worker_list"));
  await send(`remove ${String(INSTANCE)}`);
  const alive = after.length > 0 && after[0].pid === worker?.pid;
  if (heard.error !== undefined || heard.status !== 0) return { problem: `isolated_signal: ${(heard.stderr ?? "").trim()}`, alive };
  const f = JSON.parse(heard.stdout);
  return { alive, workers: workers.length, poolOfWorker: worker?.pool, xruns: f.xruns, finite: f.finite, silent: f.silent, dspLoad: f.dspLoad };
}

/** The windows of one mode as one: the lowest load and the fewest xruns, and any window that failed, died or was silent counts. */
function best(windows) {
  const failed = windows.find((w) => w.problem !== undefined);
  if (failed !== undefined) return failed;
  const low = (key) => Math.min(...windows.map((w) => w[key]));
  return {
    alive: windows.every((w) => w.alive),
    workers: windows[0].workers,
    poolOfWorker: windows[0].poolOfWorker,
    xruns: low("xruns"),
    finite: windows.every((w) => w.finite),
    silent: windows.some((w) => w.silent),
    dspLoad: low("dspLoad"),
  };
}

async function main() {
  const sock = await connect();
  if (sock === undefined) return { started: false, problem: `${hostd} did not listen` };
  const send = commander(sock);
  // the first add teaches the daemon the plugin's pin; the store holds it once the plugin is in
  const first = await send(`add ${pinWord(uri)} ${String(INSTANCE)}`);
  if (first?.code === WORKER_SPAWN) return { started: false, problem: `no worker came up: add answered ${String(WORKER_SPAWN)}` };
  if (first === undefined || first.code < 0) return { started: true, added: false, problem: first === undefined ? "the host gave no answer to add" : `add answered ${String(first.code)}` };
  await send(`remove ${String(INSTANCE)}`);
  await sleep(300);
  const pin = learnedPin();
  if (pin === undefined) return { started: false, problem: "the daemon kept no pin of the plugin" };
  // the two modes alternate, and each is read at its best window: the cost of a block only ever grows with what else runs on
  // the machine, so the lowest load of a mode is the one least disturbed, and a pool that causes xruns causes them in
  // every window it runs
  const offs = [];
  const ons = [];
  for (let round = 0; round < ROUNDS; round++) {
    offs.push(await window(send, "off", pin));
    ons.push(await window(send, "cores", pin));
  }
  const off = best(offs);
  const on = best(ons);
  sock.destroy();
  return { started: true, added: true, off, on, poolApplied: on.poolOfWorker === POOL_ON && off.poolOfWorker !== POOL_ON };
}

const result = await main();
try {
  process.kill(-host.pid, "SIGKILL");
} catch {
  // the host went on its own
}
rmSync(state, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(0);
