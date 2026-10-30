#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
// One mod-host admission: a fresh `mod-host -n` on its own port, then `add` and `remove` of one plugin on its
// socket. Prints one JSON line, {installed, steps:[{cmd, resp | died}]}, for src/host-admission.ts to classify. The host
// is always killed at the end, so the next plugin gets a fresh one.
import { spawn } from "node:child_process";
import { createConnection } from "node:net";

const uri = process.argv[2];
// the host to admit under: mod-host, or omx-clap-host for plugin-hostd's LV2 adapter, which answers the same protocol
const bin = process.argv[3] ?? "mod-host";
const port = 20000 + (process.pid % 20000);
const STEP_MS = 10000;
const INSTANCE = 0;
const COMMANDS = [
  ["add", `add ${uri} ${INSTANCE}`],
  ["remove", `remove ${INSTANCE}`],
];

const host = spawn(bin, ["-n", "-p", String(port)], { stdio: "ignore" });
let hostEnd; // how the host went, once it has
host.on("exit", (code, signal) => (hostEnd = signal ?? "exit"));
const spawnFailed = new Promise((resolve) => host.on("error", (e) => resolve(e.code)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function connect() {
  for (let i = 0; i < 50; i++) {
    if (hostEnd !== undefined) return undefined;
    const s = await new Promise((resolve) => {
      const c = createConnection({ port, host: "127.0.0.1" }, () => resolve(c));
      c.on("error", () => resolve(undefined));
    });
    if (s !== undefined) return s;
    await sleep(100);
  }
  return undefined;
}

async function main() {
  if ((await Promise.race([spawnFailed, sleep(200).then(() => undefined)])) === "ENOENT") return { installed: false, steps: [] };
  const sock = await connect();
  // the host never listened (omx-clap-host with no JACK server): the plugin was never loaded
  if (sock === undefined) return { installed: true, started: false, steps: [] };
  let buffer = "";
  let closed = false;
  sock.on("data", (d) => (buffer += d.toString()));
  sock.on("close", () => (closed = true));
  sock.on("error", () => (closed = true));
  const steps = [];
  for (const [cmd, line] of COMMANDS) {
    buffer = "";
    sock.write(`${line}\0`);
    const until = Date.now() + STEP_MS;
    let resp;
    while (Date.now() < until && resp === undefined && !closed && hostEnd === undefined) {
      const m = /resp (-?\d+)/.exec(buffer);
      if (m !== null) resp = Number(m[1]);
      else await sleep(20);
    }
    if (resp === undefined) {
      await sleep(100); // a host that dies on the command closes the socket a moment before it is reaped
      steps.push({ cmd, died: hostEnd ?? (closed ? "closed" : "timeout") });
      if (hostEnd === undefined && !closed) steps[steps.length - 1] = { cmd };
      break;
    }
    steps.push({ cmd, resp });
    if (resp < 0) break;
  }
  sock.destroy();
  return { installed: true, steps };
}

const result = await main();
host.kill("SIGKILL");
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(0);
