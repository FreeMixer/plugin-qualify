// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
// `plugin-qualify compare` and `plugin-qualify compare summary`: the processes and the files. Every decision is in
// src/compare.ts; this module finds the hosts and their versions, starts the private JACK server, runs
// tools/compare-host.mjs for each plugin and host, and writes the records and the summary.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMPARISON_RECORD_SUFFIX,
  COMPARISON_SUMMARY_FILE,
  HOST_TRAITS,
  comparisonFileName,
  comparisonRecordOf,
  comparisonRecordProblems,
  compareHelpText,
  discoverAllTargets,
  clapLoader,
  hostRowOf,
  lv2Loader,
  missingReferences,
  notApplicableRow,
  parseCompareArgs,
  parseSummaryArgs,
  presenceFromRecords,
  resolveTargets,
  sameConditions,
  summarise,
  summaryHelpText,
  summaryTable,
  writeFileWhole,
} from "../dist/index.js";

const DRIVER = fileURLToPath(new URL("./compare-host.mjs", import.meta.url));
const log = (line) => process.stderr.write(`plugin-qualify compare: ${line}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", timeout: 10000 });

/** The installed package that owns a program, as "name version", from rpm or dpkg; else the program's own --version. */
function versionOf(program, path) {
  // a host built outside a package (Zynthian's mod-host in /usr/local/bin) is named by the one who runs the comparison
  const named = process.env[`OMX_COMPARE_VERSION_${program.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
  if (named) return `${program} ${named}`;
  const rpm = sh("rpm", ["-qf", "--qf", "%{NAME} %{VERSION}-%{RELEASE}", path]);
  if (rpm.status === 0 && rpm.stdout.trim()) return rpm.stdout.trim();
  const dpkg = sh("dpkg-query", ["-S", path]);
  if (dpkg.status === 0) {
    const pkg = dpkg.stdout.split(":")[0].trim();
    const v = sh("dpkg-query", ["-W", "-f", "${Version}", pkg]);
    if (v.status === 0 && v.stdout.trim()) return `${pkg} ${v.stdout.trim()}`;
  }
  const own = sh(program, ["-V"]);
  const line = `${own.stdout ?? ""}${own.stderr ?? ""}`.split("\n").find((l) => /\d+\.\d+/.test(l));
  return line ? `${program} ${line.match(/\d+(\.\d+)+\S*/)[0]} (self-reported)` : null;
}

function presence(hosts) {
  return hosts.map((host) => {
    const program = HOST_TRAITS[host].program;
    const w = sh("sh", ["-c", `command -v "$1"`, "sh", program]);
    const path = w.status === 0 ? w.stdout.trim() : "";
    if (!path) return { host, installed: false, version: null, reason: `${program} is not installed (not on PATH)` };
    return { host, installed: true, version: versionOf(program, path) };
  });
}

/** The private JACK server: dummy driver, the run's rate and quantum, a name of its own. */
let jackSerial = 0;
async function startJack(rate, quantum) {
  const name = `cmp${String(process.pid)}_${String(jackSerial++)}`;
  const env = { ...process.env, JACK_NO_START_SERVER: "1" };
  const p = spawn("jackd", ["-n", name, "-d", "dummy", "-r", String(rate), "-p", String(quantum)], { stdio: ["ignore", "ignore", "pipe"], detached: true, env });
  let err = "";
  p.stderr.on("data", (d) => (err = (err + d.toString()).slice(-2000)));
  let failed;
  p.on("error", (e) => (failed = e.code));
  p.on("exit", (c, s) => (failed = failed ?? s ?? `exit ${String(c)}`));
  const probe = locateCompareTool();
  for (let i = 0; i < 100 && failed === undefined; i++) {
    const r = spawnSync(probe, ["ports"], { env: { ...env, JACK_DEFAULT_SERVER: name }, stdio: "ignore", timeout: 5000 });
    if (r.status === 0) {
      return {
        name,
        proc: p,
        alive: () => failed === undefined && answers(name),
        stop: () => {
          try {
            process.kill(-p.pid, "SIGKILL");
          } catch {}
        },
      };
    }
    await sleep(100);
  }
  try {
    process.kill(-p.pid, "SIGKILL");
  } catch {}
  throw new Error(`the private JACK server did not start (${failed ?? "no answer"}): ${err.trim().split("\n").pop() ?? ""}`);
}

/** The server lists its ports within five seconds: a server that does not is not one to measure on. */
function answers(name) {
  const r = spawnSync(locateCompareTool(), ["ports"], { env: { ...process.env, JACK_DEFAULT_SERVER: name, JACK_NO_START_SERVER: "1" }, stdio: "ignore", timeout: 5000, killSignal: "SIGKILL" });
  return r.status === 0;
}

function locateCompareTool() {
  const dirs = [fileURLToPath(new URL("../native/build/", import.meta.url)), "/usr/libexec/plugin-qualify/", "/usr/lib/plugin-qualify/"];
  return process.env.OMX_JACK_COMPARE || dirs.map((d) => `${d}jack_compare`).find((p) => existsSync(p)) || "jack_compare";
}

/** The real-time priority a process here may take: what the JACK server and the hosts were granted. */
function realtimeGrant() {
  try {
    const line = readFileSync("/proc/self/limits", "utf8").split("\n").find((l) => l.startsWith("Max realtime priority"));
    const soft = line?.split(/\s{2,}/)[1]?.trim();
    return soft === "0" || soft === undefined ? "none (RLIMIT_RTPRIO 0: SCHED_OTHER)" : `rtprio ${soft}`;
  } catch {
    return "unknown";
  }
}

/** The LV2 plugins lilv calls instruments: their stimulus is notes. */
function lv2Instruments(uris) {
  if (uris.length === 0) return new Set();
  const py = [
    "import json,sys",
    `sys.path.insert(0, ${JSON.stringify(fileURLToPath(new URL(".", import.meta.url)))})`,
    "from lilv_load import load_lilv",
    "lilv=load_lilv()",
    "w=lilv.World();w.load_all()",
    "want=set(json.load(sys.stdin));out=[]",
    "for p in w.get_all_plugins():",
    "  u=str(p.get_uri())",
    "  if u in want and str(p.get_class().get_uri()).endswith('#InstrumentPlugin'): out.append(u)",
    "print(json.dumps(out))",
  ].join("\n");
  const r = spawnSync("python3", ["-c", py], { input: JSON.stringify(uris), encoding: "utf8", timeout: 120000 });
  if (r.status !== 0) {
    log(`the LV2 classes could not be read (${(r.stderr || "").trim().split("\n").pop()}): instruments are found by their ports`);
    return new Set();
  }
  return new Set(JSON.parse(r.stdout));
}

const addSpec = (t) => (t.format === "clap" ? `clap:${t.binaryPath}#${t.uri}` : t.uri);

function readRecords(dir) {
  const out = [];
  for (const f of existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(COMPARISON_RECORD_SUFFIX)).sort() : []) {
    const rec = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const problems = comparisonRecordProblems(rec);
    if (problems.length) throw new Error(`${join(dir, f)}: ${problems.join("; ")}`);
    out.push(rec);
  }
  return out;
}

function writeSummary(dir, records, present, meta, format) {
  const summary = summarise(records, present, meta);
  if (dir !== undefined) {
    writeFileWhole(join(dir, COMPARISON_SUMMARY_FILE), `${JSON.stringify(summary, null, 2)}\n`);
    log(`summary ${join(dir, COMPARISON_SUMMARY_FILE)}`);
  }
  process.stdout.write(format === "json" ? `${JSON.stringify(summary, null, 2)}\n` : summaryTable(summary));
  return summary;
}

export async function compareSummaryMain(argv) {
  const parsed = parseSummaryArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`plugin-qualify compare summary: ${parsed.error}\n\n${summaryHelpText()}`);
    return 2;
  }
  if (parsed.args.help) {
    process.stdout.write(summaryHelpText());
    return 0;
  }
  const records = readRecords(parsed.args.dir);
  if (records.length === 0) {
    log(`no ${COMPARISON_RECORD_SUFFIX} in ${parsed.args.dir}`);
    return 2;
  }
  const present = presenceFromRecords(records);
  const missing = missingReferences(present);
  if (parsed.args.publish && missing.length) {
    for (const m of missing) log(`not publishable: ${m.host}: ${m.reason}`);
    return 1;
  }
  writeSummary(parsed.args.dir, records, present, { hostClass: parsed.args.hostClass, set: parsed.args.set, publish: parsed.args.publish }, "text");
  return 0;
}

export async function compareMain(argv) {
  if (argv[0] === "summary") return compareSummaryMain(argv.slice(1));
  const parsed = parseCompareArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`plugin-qualify compare: ${parsed.error}\n\n${compareHelpText()}`);
    return 2;
  }
  const a = parsed.args;
  if (a.help) {
    process.stdout.write(compareHelpText());
    return 0;
  }
  const present = presence(a.hosts);
  for (const p of present) log(p.installed ? `host ${p.host}: ${p.version ?? "version unknown"}` : `host ${p.host}: skipped, ${p.reason}`);
  const missing = missingReferences(present);
  if (a.publish && missing.length) {
    // a publishable comparison is against both references: refused before anything runs, each missing one named
    for (const m of missing) log(`--publish refused: ${m.host}: ${m.reason}`);
    log(`install them (see the README, "Compare with mod-host and jalv"), or run without --publish for a local look`);
    return 1;
  }
  let targets;
  if (a.all) targets = discoverAllTargets();
  else {
    // an LV2 URI with a path in it (http://...) is a URI here, not a missing file: lv2Loader takes only the path-free ones
    const isUri = (x) => /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(x) && !existsSync(x) && !x.endsWith(".clap") && !x.endsWith(".lv2");
    const r = resolveTargets(a.targets.filter((x) => !isUri(x)), [clapLoader(), lv2Loader]);
    if (!r.ok) {
      log(`no plugin found for: ${r.refused.join(", ")}`);
      return 2;
    }
    targets = [...a.targets.filter(isUri).map((uri) => ({ format: "lv2", uri })), ...r.plugins];
  }
  if (a.limit > 0) targets = targets.slice(0, a.limit);
  if (targets.length === 0) {
    log("no plugin to compare");
    return 2;
  }
  log(`${String(targets.length)} plugins, ${String(present.filter((p) => p.installed).length)} hosts, ${String(a.rate)}/${String(a.quantum)}`);
  const instruments = lv2Instruments(targets.filter((t) => t.format === "lv2").map((t) => t.uri));
  let jack;
  const startOwn = async () => (a.server === undefined ? startJack(a.rate, a.quantum) : { name: a.server, alive: () => answers(a.server), stop: () => {} });
  try {
    jack = await startOwn();
  } catch (e) {
    log(e.message);
    return 2;
  }
  const jackVersion = (() => {
    const r = sh("jackd", ["--version"]);
    return (`${r.stdout ?? ""}`.match(/jackdmp version (\S+)/) ?? [])[1] ?? "unknown";
  })();
  const conditions = { rate: a.rate, quantum: a.quantum, cycles: a.cycles, soakS: a.soakS, windowMs: a.windowMs, timeoutMs: a.timeoutMs, jack: `jackd ${jackVersion} ${a.server === undefined ? "dummy driver, private server" : `server ${a.server}`}`, realtime: realtimeGrant() };
  if (a.out !== undefined) mkdirSync(a.out, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "plugin-qualify-compare-"));
  // a host step at most timeoutMs, cycles add and remove each, the run, two windows and the soak; then a margin
  const budget = a.timeoutMs * (2 * a.cycles + 8) + a.soakS * 1000 + 2 * a.windowMs + 15000;
  const records = [];
  try {
    for (const [i, t] of targets.entries()) {
      const file = a.out === undefined ? undefined : join(a.out, comparisonFileName(t.format, t.uri));
      if (file !== undefined && !a.force && existsSync(file)) {
        try {
          const old = JSON.parse(readFileSync(file, "utf8"));
          if (comparisonRecordProblems(old).length === 0 && sameConditions(old.conditions, conditions)) {
            log(`[${String(i + 1)}/${String(targets.length)}] ${t.uri}: compared already under these conditions, kept`);
            records.push(old);
            continue;
          }
        } catch {
          // an unreadable record is measured again
        }
      }
      const stimulus = t.format === "lv2" ? (instruments.has(t.uri) ? "notes" : "tone") : "tone";
      const rows = [];
      for (const p of present) {
        if (!p.installed) {
          rows.push({ host: p.host, version: null, status: "skipped", reason: p.reason });
          continue;
        }
        if (!HOST_TRAITS[p.host].formats.includes(t.format)) {
          rows.push(notApplicableRow(p.host, p.version, t.format));
          continue;
        }
        // a server that stopped answering is started again, and the host's run on it is made again once: the
        // server's failure is not the host's
        let obs;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (!jack.alive()) {
            if (a.server !== undefined) {
              obs = { installed: true, started: false, problem: `the JACK server ${a.server} does not answer` };
              break;
            }
            log("the JACK server does not answer; starting a new one");
            jack.stop();
            jack = await startOwn();
          }
          const opts = { server: jack.name, cycles: a.cycles, soakS: a.soakS, windowMs: a.windowMs, timeoutMs: a.timeoutMs, stimulus, workdir: join(work, p.host) };
          const r = spawnSync(process.execPath, [DRIVER, p.host, addSpec(t), JSON.stringify(opts)], { encoding: "utf8", timeout: budget, killSignal: "SIGKILL" });
          try {
            obs = JSON.parse(r.stdout.trim().split("\n").pop() ?? "");
          } catch {
            obs = { installed: true, started: false, problem: r.error?.code === "ETIMEDOUT" ? `the comparison of this plugin went past its budget of ${String(Math.round(budget / 1000))} s` : `the driver gave no result: ${(r.stderr ?? "").trim().split("\n").pop() ?? ""}` };
          }
          if (jack.alive()) break;
          log(`${t.uri} ${p.host}: the JACK server stopped answering during the run${attempt === 0 ? "; once more on a new server" : ""}`);
          if (attempt === 1) obs = { installed: true, started: false, problem: "the JACK server stopped answering during this host's run, twice" };
        }
        const row = hostRowOf(p.host, p.version, obs, conditions);
        rows.push(row);
        const c = row.checks;
        log(
          `[${String(i + 1)}/${String(targets.length)}] ${t.uri} ${p.host}: ${row.status === "ran" ? `${row.runsClean ? "clean" : "not clean"}; load ${c.loads.result}, output ${c.output.result}, cycles ${c.cycles.result}, soak ${c.soak.result}, rt ${c.rtSafe.result}${row.crash ? `, crashed at ${row.crash.step} (${row.crash.signal})` : ""}` : `${row.status}: ${row.reason}`}`,
        );
      }
      const rec = comparisonRecordOf({ format: t.format, id: t.uri, ...(t.binary ? { binary: t.binary } : {}) }, stimulus, conditions, new Date().toISOString(), rows);
      records.push(rec);
      if (file !== undefined) writeFileWhole(file, `${JSON.stringify(rec, null, 2)}\n`);
    }
  } finally {
    jack.stop();
    rmSync(work, { recursive: true, force: true });
  }
  log(`machine: ${String(cpus().length)} CPUs, ${cpus()[0]?.model ?? "unknown CPU"}; real time ${conditions.realtime}`);
  const all = a.out === undefined ? records : readRecords(a.out);
  writeSummary(a.out, all, present, { hostClass: a.hostClass, set: a.set, publish: a.publish }, a.format);
  return 0;
}
