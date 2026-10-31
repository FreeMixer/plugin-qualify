#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
// One isolated step (plugin-qualify#249): a plugin-hostd of its own on the JACK server the environment names, the plugin
// added alone, worker_list read, a sine through it for a window, and worker_list read again. Prints one JSON line for
// src/qualify-isolated.ts to judge. A host that never listened says started: false: nothing was learned about the plugin.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [uri, windowMsWord] = process.argv.slice(2);
const windowMs = Number(windowMsWord);
const signalTool = process.env.OMX_ISOLATED_SIGNAL;
const hostd = process.env.PLUGIN_HOSTD ?? "plugin-hostd";
const port = 40000 + (process.pid % 20000);
const CONNECT_TRIES = 50;
// the sync gives each command its budget: a plugin that hangs in add ends there
const COMMAND_MS = Number(process.env.OMX_ADMIT_STEP_MS ?? 0) || 30000;
const INSTANCE = 0;
const CLOCK_TICKS = 100;
const WORKER_SPAWN = -503;

const state = mkdtempSync(join(tmpdir(), "plugin-qualify-isolated-"));
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
    return { pid: Number(f[1]), instances: (f[7] ?? "").split(",").filter(Boolean) };
  });

function cpuTicks(pid) {
  try {
    const after = readFileSync(`/proc/${String(pid)}/stat`, "utf8").replace(/^.*\) /, "").split(" ");
    return Number(after[11]) + Number(after[12]);
  } catch {
    return undefined;
  }
}

async function main() {
  const sock = await connect();
  if (sock === undefined) return { started: false, problem: `${hostd} did not listen` };
  const send = commander(sock);
  const added = await send(`add ${uri} ${String(INSTANCE)}`);
  // WORKER_SPAWN: no worker came up to hold the plugin, which says nothing of the plugin. The next pass tries it again.
  if (added?.code === WORKER_SPAWN) return { started: false, problem: `no worker came up: add answered ${String(WORKER_SPAWN)}` };
  if (added === undefined || added.code < 0) return { started: true, added: false, problem: added === undefined ? "the host gave no answer to add" : `add answered ${String(added.code)}` };
  const before = workersOf(await send("worker_list"));
  const worker = before[0];
  const ticksBefore = worker === undefined ? undefined : cpuTicks(worker.pid);
  const signal = spawnSync(signalTool, [`effect_${String(INSTANCE)}`, String(windowMs)], { encoding: "utf8", timeout: windowMs + 15000, killSignal: "SIGKILL" });
  const ticksAfter = worker === undefined ? undefined : cpuTicks(worker.pid);
  const after = workersOf(await send("worker_list"));
  sock.destroy();
  const alive = after.length > 0 && after[0].pid === worker?.pid && ticksAfter !== undefined;
  if (signal.error !== undefined || signal.status !== 0) {
    if (signal.status === 2 && alive) return { started: false, problem: `isolated_signal: ${signal.stderr.trim()}` };
    return { started: true, added: true, alive, workers: before.length, instancesInWorker: worker?.instances.length ?? 0, problem: signal.stderr?.trim() };
  }
  const heard = JSON.parse(signal.stdout);
  return {
    started: true,
    added: true,
    alive,
    workers: before.length,
    instancesInWorker: worker?.instances.length ?? 0,
    latencyFrames: heard.latencyFrames,
    xruns: heard.xruns,
    finite: heard.finite,
    silent: heard.silent,
    ...(ticksBefore === undefined || ticksAfter === undefined ? {} : { cpuPercent: ((ticksAfter - ticksBefore) * 100000) / CLOCK_TICKS / windowMs }),
  };
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
