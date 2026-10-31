#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
// One mod-host admission: a fresh `mod-host -n` on its own port, then `add` and `remove` of one plugin on its
// socket. Prints one JSON line, {installed, steps:[{cmd, resp | died}]}, for src/host-admission.ts to classify. The host
// is always killed at the end, so the next plugin gets a fresh one.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

const uri = process.argv[2];
// the host to admit under: mod-host, or omx-clap-host for plugin-hostd's LV2 adapter, which answers the same protocol
const bin = process.argv[3] ?? "mod-host";
const port = 20000 + (process.pid % 20000);
// an adapter-only pass gives the host its budget for a command, an address space and a state directory of the plugin's own
const STEP_MS = Number(process.env.OMX_ADMIT_STEP_MS ?? 0) || 10000;
const ADDRESS_KB = process.env.OMX_ADMIT_ADDRESS_KB;
const STATE_DIR = process.env.OMX_ADMIT_STATE_DIR;
const INSTANCE = 0;
// an instrument under the adapter is played: one note, held this long, its output read at its JACK ports
const NOTE_WINDOW_MS = 1000;
const NOTE_ON = `note_on ${INSTANCE} 0 60 100`;
const ADAPTER = "omx-clap-host";
const COMMANDS = [
  ["add", `add ${uri} ${INSTANCE}`],
  ["remove", `remove ${INSTANCE}`],
];

const args = ["-n", "-p", String(port), ...(STATE_DIR === undefined ? [] : ["-s", STATE_DIR])];
// in a process group of its own, so that the end below takes whatever a plugin started as well
const host =
  ADDRESS_KB === undefined
    ? spawn(bin, args, { stdio: "ignore", detached: true })
    : spawn("/bin/sh", ["-c", `command -v "$1" >/dev/null || exit 127; ulimit -v ${ADDRESS_KB} && exec "$@"`, "sh", bin, ...args], { stdio: "ignore", detached: true });
let hostEnd; // how the host went, once it has
let shellNotFound = false;
host.on("exit", (code, signal) => {
  hostEnd = signal ?? "exit";
  if (code === 127) shellNotFound = true;
});
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

// the LV2 class says it is an instrument; the note port and the audio input say nothing, a synth can have both, an effect
// can have both. omx-clap-scan comes with omx-clap-host: without an answer from it this is not known to be an instrument
function isInstrument() {
  const r = spawnSync("omx-clap-scan", ["--fields", `lv2:${uri}`], { encoding: "utf8", timeout: STEP_MS });
  return r.status === 0 && /^plugin\trdf:type\tlv2:InstrumentPlugin$/m.test(r.stdout);
}

// the JACK output ports of the instance, from audio_ports's reply: resp 0 [dry] in:... out:main:1:2:stereo:"out":out_1,out_2
function outputPorts(reply) {
  return [...reply.matchAll(/ out:[^ "]*"[^"]*":([^ ]+)/g)].flatMap((m) => m[1].split(",")).map((p) => `effect_${INSTANCE}:${p}`);
}

const PEAK_TOOL_DIRS = [fileURLToPath(new URL("../native/build/", import.meta.url)), "/usr/libexec/plugin-qualify/", "/usr/lib/plugin-qualify/"];
const peakTool = () => process.env.OMX_JACK_PEAK || PEAK_TOOL_DIRS.map((d) => `${d}jack_peak`).find((p) => existsSync(p));

// the peak on `ports` while `during` runs: { peak } in linear magnitude, or { problem } with why
async function peakDuring(ports, during) {
  const tool = peakTool();
  if (tool === undefined) return { problem: "no jack_peak" };
  const meter = spawn(tool, ports, { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  const ended = new Promise((resolve) => {
    meter.on("error", (e) => resolve(e.code ?? "error"));
    meter.on("exit", (code) => resolve(code));
  });
  meter.stdout.on("data", (d) => (out += d.toString()));
  meter.stderr.on("data", (d) => (err += d.toString()));
  const until = Date.now() + STEP_MS;
  while (!out.includes("ready") && Date.now() < until && meter.exitCode === null) await sleep(10);
  if (!out.includes("ready")) {
    meter.kill("SIGKILL");
    await ended;
    return { problem: err.trim() || "jack_peak did not start" };
  }
  await during();
  meter.stdin.end();
  await Promise.race([ended, sleep(STEP_MS)]);
  meter.kill("SIGKILL");
  try {
    return { peak: JSON.parse(out.slice(out.indexOf("ready") + 5)).peak };
  } catch {
    return { problem: err.trim() || "jack_peak gave no figure" };
  }
}

async function main() {
  if ((await Promise.race([spawnFailed, sleep(200).then(() => undefined)])) === "ENOENT" || shellNotFound) return { installed: false, steps: [] };
  const sock = await connect();
  // the host never listened (omx-clap-host with no JACK server): the plugin was never loaded
  if (sock === undefined) return { installed: true, started: false, steps: [] };
  let buffer = "";
  let closed = false;
  sock.on("data", (d) => (buffer += d.toString()));
  sock.on("close", () => (closed = true));
  sock.on("error", () => (closed = true));
  const steps = [];
  let sound;
  // one line on the socket and its whole answer: undefined when none came in time
  const ask = async (line) => {
    buffer = "";
    sock.write(`${line}\0`);
    const until = Date.now() + STEP_MS;
    while (Date.now() < until && !closed && hostEnd === undefined) {
      const m = /resp -?\d+[^\0]*/.exec(buffer);
      if (m !== null && buffer.includes("\0")) return m[0];
      await sleep(20);
    }
    return undefined;
  };
  for (const [cmd, line] of COMMANDS) {
    // an instrument the adapter took: does a held note sound? A plugin that dies on the note dies at the remove below
    if (cmd === "remove" && bin === ADAPTER && isInstrument()) {
      const ports = outputPorts((await ask(`audio_ports ${INSTANCE}`)) ?? "");
      sound =
        ports.length === 0
          ? { problem: "no output port" }
          : await peakDuring(ports, async () => {
              await ask(NOTE_ON);
              await sleep(NOTE_WINDOW_MS);
            });
    }
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
  return { installed: true, steps, ...(sound === undefined ? {} : { sound }) };
}

const result = await main();
try {
  process.kill(-host.pid, "SIGKILL");
} catch {
  // the host went on its own
}
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(0);
