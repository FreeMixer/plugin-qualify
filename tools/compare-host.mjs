#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
// One plugin under one host, for `plugin-qualify compare`: the same steps for every host, and one JSON line of what was
// seen (src/compare.ts `HostObservation`); no judgment here, src/compare.ts `hostRowOf` makes the row.
//
//   compare-host.mjs <host> <add spec> <options JSON>
//
// <host> is omx-clap-host, plugin-hostd or mod-host (driven over the mod-host socket protocol) or jalv (one process per
// plugin). <add spec> is what `add` takes: an LV2 URI, or clap:<path>#<id>. The options: server (the JACK server's name),
// cycles, soakS, windowMs, timeoutMs, stimulus (tone | notes | none: what the plugin's class asks for; the ports decide
// when the plugin has no input of that kind), workdir.
//
// The steps: start the host; load and unload the plugin `cycles` times (the first load is the load check, its ports on
// the graph the instantiation check); load it again, feed it its stimulus, read the peak of its outputs over a window,
// keep it running `soakS` seconds, read the peak again, the CPU its processes used over the soak, the latency on its
// output port, then ask every process of the host for its rt_watch.so report (SIGUSR2) and end it. Every host starts
// under LD_PRELOAD=rt_watch.so in a process group of its own, which the end takes whole.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [host, spec, optText] = process.argv.slice(2);
const opt = JSON.parse(optText ?? "{}");
const STEP_MS = opt.timeoutMs ?? 10000;
const WINDOW_MS = opt.windowMs ?? 2000;
const SOAK_S = opt.soakS ?? 10;
const CYCLES = opt.cycles ?? 5;
const WORK = opt.workdir;
const RT_DIR = join(WORK, "rt");
const INSTANCE = 0;
const CLK_TCK = 100;

const TOOL_DIRS = [fileURLToPath(new URL("../native/build/", import.meta.url)), "/usr/libexec/plugin-qualify/", "/usr/lib/plugin-qualify/"];
const tool = (name, env) => process.env[env] || TOOL_DIRS.map((d) => `${d}${name}`).find((p) => existsSync(p));
const JACK_PEAK = tool("jack_peak", "OMX_JACK_PEAK");
const JACK_COMPARE = tool("jack_compare", "OMX_JACK_COMPARE");
const RT_WATCH = tool("rt_watch.so", "OMX_RT_WATCH");

const jackEnv = { ...process.env, JACK_DEFAULT_SERVER: opt.server, JACK_NO_START_SERVER: "1" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostEnv = () => {
  const env = { ...jackEnv };
  if (RT_WATCH) {
    env.LD_PRELOAD = [RT_WATCH, process.env.LD_PRELOAD].filter(Boolean).join(" ");
    env.OMX_RT_WATCH_DIR = RT_DIR;
  }
  return env;
};

// ------------------------------------------------------------------ the graph

function ports() {
  const r = spawnSync(JACK_COMPARE, ["ports"], { env: jackEnv, encoding: "utf8", timeout: STEP_MS });
  if (r.status !== 0) return undefined;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return undefined;
  }
}

/** The ports that came after `before`, of one client: the plugin's. */
function newPorts(before, client) {
  const had = new Set(before.map((p) => p.name));
  const now = ports() ?? [];
  return now.filter((p) => !had.has(p.name) && !p.name.startsWith("jack_compare:") && !p.name.startsWith("jack_peak:") && (client === undefined || p.name.startsWith(`${client}:`)));
}

function portCounts(list) {
  return {
    audioIn: list.filter((p) => p.type === "audio" && p.input).length,
    audioOut: list.filter((p) => p.type === "audio" && !p.input).length,
    midiIn: list.filter((p) => p.type === "midi" && p.input).length,
  };
}

/** Waits for the plugin's ports; the list stays empty when none came in time or the host ended. */
async function awaitPorts(before, client, alive) {
  const until = Date.now() + STEP_MS;
  let last = [];
  while (Date.now() < until && alive()) {
    const got = newPorts(before, client);
    // a moment more once ports appear, so a plugin's late ports are counted too
    if (got.length > 0 && got.length === last.length) return got;
    last = got;
    await sleep(got.length > 0 ? 150 : 100);
  }
  return last;
}

/** A long-running JACK helper that prints "ready": the stimulus, or the peak meter. */
async function helper(bin, args) {
  if (bin === undefined) return { problem: `${args[0] === undefined ? "a tool" : "jack_compare"} is not installed` };
  const p = spawn(bin, args, { env: jackEnv, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  const ended = new Promise((resolve) => {
    p.on("error", (e) => resolve(e.code ?? "error"));
    p.on("exit", (code) => resolve(code));
  });
  p.stdout.on("data", (d) => (out += d.toString()));
  p.stderr.on("data", (d) => (err += d.toString()));
  const until = Date.now() + STEP_MS;
  while (!out.includes("ready") && Date.now() < until && p.exitCode === null) await sleep(10);
  if (!out.includes("ready")) {
    p.kill("SIGKILL");
    await ended;
    return { problem: err.trim() || `${bin} did not start` };
  }
  return {
    stop: async () => {
      p.stdin.end();
      await Promise.race([ended, sleep(STEP_MS)]);
      p.kill("SIGKILL");
      return { out: out.slice(out.indexOf("ready") + 5), err };
    },
  };
}

/** The peak of `outs` over the window. */
async function peakOver(outs) {
  if (JACK_PEAK === undefined) return { problem: "jack_peak is not installed" };
  const m = await helper(JACK_PEAK, outs.map((p) => p.name));
  if (m.problem) return m;
  await sleep(WINDOW_MS);
  const r = await m.stop();
  try {
    return { peak: JSON.parse(r.out).peak };
  } catch {
    return { problem: r.err.trim() || "jack_peak gave no figure" };
  }
}

function latencyOf(outs) {
  if (outs.length === 0 || JACK_COMPARE === undefined) return null;
  const r = spawnSync(JACK_COMPARE, ["latency", outs[0].name], { env: jackEnv, encoding: "utf8", timeout: STEP_MS });
  try {
    return JSON.parse(r.stdout).capture[1];
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ the host's processes

/** The pids of a process group. */
function groupPids(pgid) {
  const out = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, "utf8");
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(f[2]) === pgid) out.push({ pid: Number(d), ticks: Number(f[11]) + Number(f[12]) });
    } catch {
      // gone between the list and the read
    }
  }
  return out;
}
const groupTicks = (pgid) => groupPids(pgid).reduce((s, p) => s + p.ticks, 0);

/** Every process of the group writes its rt_watch.so report; the reports read back. */
async function rtReports(pgid) {
  if (!RT_WATCH) return undefined;
  try {
    process.kill(-pgid, "SIGUSR2");
  } catch {
    return [];
  }
  await sleep(400);
  const out = [];
  for (const f of existsSync(RT_DIR) ? readdirSync(RT_DIR) : []) {
    try {
      out.push(JSON.parse(readFileSync(join(RT_DIR, f), "utf8")));
    } catch {
      // a report cut short is no report
    }
  }
  return out;
}

/** What the plugin is fed: notes when its class says instrument, or when it takes MIDI and no audio; else a tone. */
function stimulusFor(want, counts) {
  if (counts.midiIn > 0 && (want === "notes" || counts.audioIn === 0)) return "notes";
  if (counts.audioIn > 0) return "tone";
  return "none";
}

/** Feeds the stimulus, measures, soaks: the run every host gets once the plugin is in. */
async function run(plugin, pgid, alive, deathOf) {
  const counts = portCounts(plugin);
  const stimulus = stimulusFor(opt.stimulus, counts);
  const targets = plugin.filter((p) => p.input && p.type === (stimulus === "notes" ? "midi" : "audio")).map((p) => p.name);
  const outs = plugin.filter((p) => !p.input && p.type === "audio");
  const obs = { stimulus };
  let feed;
  if (stimulus !== "none") {
    feed = await helper(JACK_COMPARE, [stimulus, ...targets]);
    if (feed.problem) obs.peakProblem = `the ${stimulus} could not be fed: ${feed.problem}`;
  }
  if (outs.length > 0 && obs.peakProblem === undefined) {
    const p = await peakOver(outs);
    if (p.problem) obs.peakProblem = p.problem;
    else obs.peak = p.peak;
  }
  const t0 = groupTicks(pgid);
  const s0 = Date.now();
  while (Date.now() - s0 < SOAK_S * 1000 && alive()) await sleep(100);
  const seconds = (Date.now() - s0) / 1000;
  const t1 = groupTicks(pgid);
  const survived = alive();
  let peakAtEnd;
  if (survived && outs.length > 0 && obs.peakProblem === undefined) {
    const p = await peakOver(outs);
    peakAtEnd = p.peak ?? null;
  }
  obs.soak = { seconds: Math.round(seconds * 10) / 10, alive: survived && alive(), ...(survived ? {} : { died: deathOf() }), ...(peakAtEnd === undefined ? {} : { peakAtEnd }) };
  obs.cpu = survived ? { percent: (100 * (t1 - t0)) / CLK_TCK / Math.max(seconds, 0.001) } : { problem: "the host ended during the soak" };
  obs.latencyFrames = survived ? latencyOf(outs) : null;
  if (survived) obs.rt = await rtReports(pgid);
  if (feed?.stop) await feed.stop();
  return obs;
}

/** SIGTERM to the group, then SIGKILL to whatever of it is left after the step budget. */
async function endGroup(pgid, alive) {
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    return;
  }
  const until = Date.now() + Math.min(STEP_MS, 5000);
  while (Date.now() < until && (alive() || groupPids(pgid).length > 0)) await sleep(50);
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {}
}

// ------------------------------------------------------------------ the protocol hosts

async function protocolHost() {
  const port = 20000 + (process.pid % 20000);
  const args = ["-n", "-p", String(port)];
  if (host === "plugin-hostd") {
    // the comparison asks plugin-hostd to host, not to judge: the pins are plugin-qualify's other job
    const conf = join(WORK, "plugin-hostd.conf");
    writeFileSync(conf, "require_pins 0\n");
    args.push("-c", conf);
  }
  const before0 = ports();
  if (before0 === undefined) return { installed: true, started: false, problem: "no JACK server answers" };
  const h = spawn(host, args, { stdio: ["ignore", "ignore", "pipe"], detached: true, env: hostEnv() });
  let end;
  let stderr = "";
  h.stderr.on("data", (d) => (stderr = (stderr + d.toString()).slice(-4000)));
  h.on("exit", (code, signal) => (end = signal ?? `exit ${String(code)}`));
  const failed = await Promise.race([new Promise((r) => h.on("error", (e) => r(e.code))), sleep(200).then(() => undefined)]);
  if (failed === "ENOENT") return { installed: false };
  const alive = () => end === undefined;
  const deathOf = () => end ?? "alive";
  let sock;
  for (let i = 0; i < 50 && alive() && sock === undefined; i++) {
    sock = await new Promise((resolve) => {
      const c = createConnection({ port, host: "127.0.0.1" }, () => resolve(c));
      c.on("error", () => resolve(undefined));
    });
    if (sock === undefined) await sleep(100);
  }
  if (sock === undefined) {
    try {
      process.kill(-h.pid, "SIGKILL");
    } catch {}
    return { installed: true, started: false, problem: `${host} did not listen (${end ?? "no socket"}): ${stderr.trim().split("\n").pop() ?? ""}` };
  }
  let buffer = "";
  let closed = false;
  sock.on("data", (d) => (buffer += d.toString()));
  sock.on("close", () => (closed = true));
  sock.on("error", () => (closed = true));
  const ask = async (line) => {
    buffer = "";
    sock.write(`${line}\0`);
    const until = Date.now() + STEP_MS;
    while (Date.now() < until && !closed && alive()) {
      const m = /resp (-?\d+)/.exec(buffer);
      if (m !== null) return { resp: Number(m[1]) };
      await sleep(20);
    }
    await sleep(150); // a host that dies on the command closes the socket a moment before it is reaped
    return { died: end ?? (closed ? "closed" : undefined) };
  };
  const obs = { installed: true, started: true };
  // the host is asked to end (SIGTERM, so it closes its JACK clients) and killed only when it does not in time: a client
  // killed in the middle of a cycle can leave a JACK server waiting on it
  const finish = async () => {
    sock.destroy();
    await endGroup(h.pid, alive);
    return obs;
  };
  const crashed = (step) => {
    const sig = end ?? "closed";
    obs.died = { step, signal: sig };
  };

  // the cycles: the first add is the load check, its ports the instantiation check
  let done = 0;
  for (let i = 0; i < CYCLES; i++) {
    const base = ports() ?? [];
    const a = await ask(`add ${spec} ${INSTANCE}`);
    if (i === 0) obs.load = a.resp !== undefined ? { ok: a.resp >= 0, resp: a.resp } : { ok: false, ...(a.died ? { died: a.died } : { detail: "no answer in time" }) };
    if (a.resp === undefined || a.resp < 0) {
      obs.cycles = { done, of: CYCLES, failedAt: "add", ...(a.died ? { died: a.died } : {}) };
      if (!alive() || closed) crashed(i === 0 ? "load" : `cycle ${String(i + 1)}`);
      return await finish();
    }
    const got = await awaitPorts(base, undefined, alive);
    if (i === 0) obs.ports = portCounts(got);
    const r = await ask(`remove ${INSTANCE}`);
    if (r.resp === undefined || r.resp < 0) {
      obs.cycles = { done, of: CYCLES, failedAt: "remove", ...(r.died ? { died: r.died } : {}) };
      if (!alive() || closed) crashed(`cycle ${String(i + 1)}`);
      return await finish();
    }
    done++;
  }
  obs.cycles = { done, of: CYCLES };

  // the run
  const base = ports() ?? [];
  const a = await ask(`add ${spec} ${INSTANCE}`);
  if (a.resp === undefined || a.resp < 0) {
    if (!alive() || closed) crashed("run");
    obs.soak = { seconds: 0, alive: false, died: a.died ?? `resp ${String(a.resp)}` };
    return await finish();
  }
  const plugin = await awaitPorts(base, undefined, alive);
  Object.assign(obs, await run(plugin, h.pid, () => alive() && !closed, deathOf));
  if (!alive()) crashed("soak");
  else await ask(`remove ${INSTANCE}`);
  return await finish();
}

// ------------------------------------------------------------------ jalv: one process per plugin

async function jalvHost() {
  if (spawnSync("jalv", ["-V"], { stdio: "ignore" }).error?.code === "ENOENT") return { installed: false };
  if (ports() === undefined) return { installed: true, started: false, problem: "no JACK server answers" };
  const obs = { installed: true, started: true };
  const start = (k) => {
    const name = `cmp${String(process.pid)}_${String(k)}`;
    const p = spawn("jalv", ["-i", "-x", "-n", name, spec], { stdio: ["ignore", "ignore", "pipe"], detached: true, env: hostEnv() });
    const st = { p, name, end: undefined, stderr: "" };
    p.stderr.on("data", (d) => (st.stderr = (st.stderr + d.toString()).slice(-4000)));
    p.on("exit", (code, signal) => (st.end = signal ?? `exit ${String(code)}`));
    return st;
  };
  const stop = async (st) => {
    try {
      process.kill(-st.p.pid, "SIGTERM");
    } catch {}
    const until = Date.now() + STEP_MS;
    while (st.end === undefined && Date.now() < until) await sleep(20);
    if (st.end === undefined) {
      try {
        process.kill(-st.p.pid, "SIGKILL");
      } catch {}
      return "hung";
    }
    // ended by the SIGTERM it was sent, or exited cleanly on it
    return st.end === "SIGTERM" || st.end === "exit 0" ? "ok" : st.end;
  };
  const crashSignal = (end) => end !== undefined && /^SIG/.test(end) && end !== "SIGTERM" && end !== "SIGKILL";

  let done = 0;
  for (let i = 0; i < CYCLES; i++) {
    const base = ports() ?? [];
    const st = start(i);
    const got = await awaitPorts(base, st.name, () => st.end === undefined);
    if (i === 0) {
      obs.load = got.length > 0 ? { ok: true } : { ok: false, ...(st.end ? { died: st.end } : {}), detail: st.stderr.trim().split("\n").filter(Boolean).pop() ?? "no client on the graph in time" };
      obs.ports = portCounts(got);
    }
    if (got.length === 0) {
      obs.cycles = { done, of: CYCLES, failedAt: "start", ...(st.end ? { died: st.end } : {}) };
      if (crashSignal(st.end)) obs.died = { step: i === 0 ? "load" : `cycle ${String(i + 1)}`, signal: st.end };
      await stop(st);
      return obs;
    }
    const how = await stop(st);
    if (how !== "ok") {
      obs.cycles = { done, of: CYCLES, failedAt: "stop", died: how };
      if (crashSignal(how)) obs.died = { step: `cycle ${String(i + 1)}`, signal: how };
      return obs;
    }
    done++;
  }
  obs.cycles = { done, of: CYCLES };
  const base = ports() ?? [];
  const st = start(CYCLES);
  const plugin = await awaitPorts(base, st.name, () => st.end === undefined);
  if (plugin.length === 0) {
    obs.soak = { seconds: 0, alive: false, died: st.end ?? "no client" };
    if (crashSignal(st.end)) obs.died = { step: "run", signal: st.end };
    await stop(st);
    return obs;
  }
  Object.assign(obs, await run(plugin, st.p.pid, () => st.end === undefined, () => st.end ?? "alive"));
  if (st.end !== undefined && crashSignal(st.end)) obs.died = { step: "soak", signal: st.end };
  await stop(st);
  return obs;
}

rmSync(RT_DIR, { recursive: true, force: true });
mkdirSync(RT_DIR, { recursive: true });
let result;
try {
  if (JACK_COMPARE === undefined) result = { installed: true, started: false, problem: "jack_compare is not installed (make -C native, or the plugin-qualify package)" };
  else result = host === "jalv" ? await jalvHost() : await protocolHost();
} catch (e) {
  result = { installed: true, started: false, problem: `the driver failed: ${e.message}` };
}
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(0);
