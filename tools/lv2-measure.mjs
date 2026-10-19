#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * `lv2-measure` — measure the LV2 plugins on THIS machine and write a versioned
 * measurement document.
 *
 * Standalone by construction: it needs `python3` with the `lilv` bindings, the two probers
 * next to this file (`scan.py`, `benchmark.py`), and an LV2 world to look at; the hosting
 * dimensions need the package's native measurer and interposer (`lv2_measure`,
 * `rt_interpose.so`), each its setting (`OMX_LV2_MEASURE`, `OMX_RT_INTERPOSE`), else
 * `native/build` (`make -C native`), else where the package installs it. It does not
 * need the OpenMixer engine, its server, PipeWire, JACK, an audio interface, or root. Nothing
 * it writes is openmixer-shaped — the output is the interchange format described in
 * `src/measurement/format.ts`, which any LV2 host can read.
 *
 * This file is deliberately thin. Every decision — argument parsing, the pass order, the
 * progress heuristic, the assembly of the document — lives in `src/measurement/cli.ts` and
 * is unit-tested there without probing anything. What is left here is spawning processes and
 * moving bytes, which is the part that cannot be tested without 958 real plugins.
 *
 * ## Usage
 *
 * ```sh
 * pnpm build                       # this shell reads the compiled dist/
 * node tools/lv2-measure.mjs --rates 48000,96000 --out measurements.json --run
 * node tools/lv2-measure.mjs --rates 48000 --dimensions latency --dry-run
 * node tools/lv2-measure.mjs --rates 48000 --dimensions stability,rtSafety,features --plugins <uri> --run
 * ```
 *
 * `--run` (or `LV2_MEASURE_RUN=1`) is required to probe: the passes instantiate and execute
 * every plugin on the machine, which is CPU-heavy and occasionally fatal to the probe worker.
 * `--dry-run` prints the plan and touches nothing.
 *
 * ## Machine-readable progress
 *
 * With `--progress-json`, one JSON object per line is written to stderr, each prefixed
 * `@progress `. A supervising process (the OpenMixer console's Setup screen) parses those and
 * ignores everything else, so the human log stays readable.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { constants, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  advanceProgress,
  assembleDocument,
  buildPipeline,
  collectHostFacts,
  HOSTING_PASS_DIMENSIONS,
  hostingLine,
  INITIAL_PROGRESS,
  parseMeasureArgs,
  parseProbeProgress,
  serialiseMeasurementDocument,
  TOOL_NAME,
  TOOL_VERSION,
  urisFromScan,
} from "../dist/measurement/index.js";
import { LV2_HOSTING_TIMEOUT_S, LV2_MEASURE_TOOL_NAME, RT_INTERPOSE_NAME } from "../dist/qualify-declarations.js";
import { halfPopulatedRefusal, locateNativeTools } from "../dist/tool-paths.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const HELP = `${TOOL_NAME} ${TOOL_VERSION} — measure LV2 plugin latency and CPU cost on this machine.

  --rates 48000,96000     REQUIRED. Sample rates to measure at. There is no default:
                          a figure without a stated rate is not a measurement.
  --dimensions latency,cost
                          What to measure (default: latency,cost); also any of
                          stability,rtSafety,features, the hosting pass (the native lv2_measure
                          under the interposer, one process per plugin).
  --plugins URI,URI       The hosting pass measures only these, and needs no scan.
  --out PATH              Where the document goes (default: stdout).
  --scan PATH             Reuse an existing prober scan instead of scanning.
  --work-dir PATH         Where intermediates go (default: alongside --out, or a temp dir).
  --tool-dir PATH         Where scan.py / benchmark.py live (default: next to this file).
  --python BIN            Python interpreter (default: $PYTHON or python3).
  --sweep                 Also sweep latency-bearing controls (finds parameter-dependent latency).
  --cost-cpu N            Pin the cost pass to core N.
  --probe-notes N         The notes an instrument holds down while its cost is timed (1 to 128);
                          without it an instrument's cost is unmeasured (voices-unknown).
  --label TEXT            A note recorded with the run.
  --run                   Required to probe. Instantiates and runs every plugin.
  --dry-run               Print the plan and probe nothing.
  --progress-json         Emit machine-readable progress on stderr, one '@progress {...}' per line.
  --help                  This text.

The hosting pass's host features are omx-clap-core's LV2 feature provider; each of its options is
a flag, passed to every run of lv2_measure and named in each plugin's record (featureOptions):

  --features LIST         Kinds offered: map,unmap,options,bounded,worker,default-state,log
                          (default: all but default-state; empty: none).
  --strict                Refuse a plugin requiring a feature not offered, naming it (refusedFeature).
  --no-strict             Hand it to its own instantiate without it (default).
  --block-declares LIST   Buf-size declarations when bounded is offered: bounded,fixed,pow2
                          (default: bounded; empty: none).
  --block-min N           bufsz:minBlockLength (default: 1; 0: the run's block).
  --block-max N           bufsz:maxBlockLength (default: 0, the run's block).
  --block-nominal N       bufsz:nominalBlockLength (default: 0, the maximum).
  --log MODE              log:log lines: silent, route (to stderr) or capture (into the record)
                          (default: silent).
  --log-capture-bytes N   The capture buffer, its NUL included (default: 4096).
`;

function fail(message, code = 2) {
  process.stderr.write(`${TOOL_NAME}: ${message}\n`);
  process.exit(code);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * The native measurer and its interposer, located together (`locateNativeTools`): absent, or half there
 * in the one place they come from, the run is refused naming where it looked.
 */
function hostingTools() {
  const { tools, halfPopulated } = locateNativeTools([LV2_MEASURE_TOOL_NAME, RT_INTERPOSE_NAME], process.env, existsSync);
  if (halfPopulated !== undefined) fail(`no measurer and interposer pair: ${halfPopulatedRefusal(halfPopulated)}`);
  const [tool, interposer] = tools.map((found) => {
    if (found.path === undefined) {
      fail(`no ${found.name} at ${found.looked.join(", ")}: install the plugin-qualify package, build it with make -C native, or set ${found.setting}`);
    }
    return found.path;
  });
  return { tool, interposer };
}

/** The hosting pass: the measurer once per plugin, each in its own process, its lines written as JSONL. */
function runHosting(step, uris, onProgress) {
  const lines = [];
  onProgress(step, { kind: "phase", plugins: uris.length, rate: Number(step.args[0]) });
  for (const uri of uris) {
    const r = spawnSync(step.command, [uri, ...step.args], {
      encoding: "utf8",
      env: { ...process.env, ...step.env },
      stdio: ["ignore", "pipe", "inherit"],
      timeout: LV2_HOSTING_TIMEOUT_S * 1000,
      maxBuffer: 16 << 20,
    });
    if (r.error !== undefined && r.error.code !== "ETIMEDOUT") throw new Error(`hosting: cannot run ${step.command}: ${r.error.message}`);
    const line = hostingLine(uri, {
      status: r.status,
      ...(r.signal ? { signalNumber: constants.signals[r.signal] } : {}),
      ...(r.error?.code === "ETIMEDOUT" ? { timedOut: true } : {}),
      stdout: r.stdout ?? "",
    });
    process.stderr.write(`  ${uri}: exit ${line.exit}\n`);
    onProgress(step, { kind: "plugin" });
    lines.push(line);
  }
  writeFileSync(step.produces, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  return lines;
}

/** Run one pipeline step, forwarding its stderr and counting the plugins it reports. */
function runStep(step, onProgress) {
  return new Promise((settle, reject) => {
    const child = spawn(step.command, [...step.args], { stdio: ["ignore", "inherit", "pipe"] });
    let pending = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        process.stderr.write(`${line}\n`);
        const progress = parseProbeProgress(line);
        if (progress !== undefined) onProgress(step, progress);
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (pending.length > 0) process.stderr.write(`${pending}\n`);
      if (code === 0) settle();
      else reject(new Error(`${step.id} exited ${code}`));
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  const progressJson = argv.includes("--progress-json");
  const parsed = parseMeasureArgs(
    argv.filter((a) => a !== "--progress-json"),
    process.env,
    { toolDir: HERE, workDir: join(process.cwd(), ".lv2-measure") },
  );
  if (!parsed.ok) fail(`${parsed.error}\n\n${HELP}`);
  const options = parsed.options;

  const hosting = options.dimensions.some((d) => HOSTING_PASS_DIMENSIONS.includes(d));
  const pipeline = buildPipeline(options, hosting ? hostingTools() : undefined);

  if (options.dryRun) {
    process.stderr.write(
      `${TOOL_NAME} would measure ${options.dimensions.join(" + ")} at ${options.rates.join(", ")} Hz\n`,
    );
    for (const step of pipeline.steps) {
      const env = Object.entries(step.env ?? {}).map(([k, v]) => `${k}=${v} `).join("");
      const each = step.perPlugin ? `<each of ${options.plugins?.join(", ") ?? "the scan's plugins"}> ` : "";
      process.stderr.write(`  ${step.id}: ${env}${step.command} ${each}${step.args.join(" ")}\n`);
    }
    return;
  }
  if (!options.run) {
    fail("refusing to probe without --run (or LV2_MEASURE_RUN=1): this instantiates and runs every LV2 plugin on this machine");
  }

  mkdirSync(options.workDir, { recursive: true });
  // Only the FIRST step's input can be checked up front — every later step reads what the
  // one before it wrote, and a missing intermediate is a failed step, reported as one.
  if (options.scanPath !== undefined && !existsSync(options.scanPath)) {
    fail(`--scan: no such file: ${options.scanPath}`);
  }

  // Progress is advisory: the phase banner supplies the denominator, the indented result
  // lines supply the numerator. A prober whose log we cannot parse simply stalls the bar.
  let phase = INITIAL_PROGRESS;
  const emit = (event) => {
    if (progressJson) process.stderr.write(`@progress ${JSON.stringify(event)}\n`);
  };
  const onProgress = (step, progress) => {
    const next = advanceProgress(phase, progress);
    if (next === phase) return; // clamped: the phase's own summary lines are not plugins
    phase = next;
    emit({ step: step.id, dimension: step.dimension ?? null, ...phase });
  };

  const startedAt = Date.now();
  const measuredAt = new Date().toISOString();
  emit({ step: "start", steps: pipeline.steps.map((s) => s.id) });
  let hostingLines;
  for (const step of pipeline.steps) {
    process.stderr.write(`== ${step.id}\n`);
    if (step.perPlugin) {
      const uris = options.plugins ?? urisFromScan(readJson(pipeline.hostingScan));
      hostingLines = runHosting(step, uris, onProgress);
    } else {
      await runStep(step, onProgress);
    }
  }
  const elapsedSeconds = (Date.now() - startedAt) / 1000;

  const document = assembleDocument({
    options,
    ...(pipeline.finalCatalog === undefined ? {} : { catalog: readJson(pipeline.finalCatalog) }),
    ...(hostingLines === undefined ? {} : { hosting: hostingLines }),
    costProvenance:
      pipeline.costProvenance !== undefined && existsSync(pipeline.costProvenance)
        ? readJson(pipeline.costProvenance)
        : undefined,
    host: collectHostFacts({
      // Both false and recorded as such: this tool deliberately requires no privileges, so
      // claiming otherwise would make its figures look better conditioned than they are.
      realtimePriority: false,
      memoryLocked: false,
      ...(options.costCpu === undefined ? {} : { pinnedCpu: options.costCpu }),
    }),
    runId: `${hostname()}-${measuredAt}`,
    measuredAt,
    elapsedSeconds,
  });

  const serialised = serialiseMeasurementDocument(document);
  if (options.outPath === undefined) process.stdout.write(serialised);
  else writeFileSync(resolve(options.outPath), serialised);

  const hostingFigure = (block) => block !== undefined && block.unmeasuredReason === undefined;
  const measured = document.plugins.filter(
    (p) =>
      Object.keys(p.latency?.perRate ?? {}).length > 0 ||
      Object.keys(p.cost?.perRate ?? {}).length > 0 ||
      hostingFigure(p.stability) ||
      hostingFigure(p.rtSafety) ||
      hostingFigure(p.features),
  ).length;
  process.stderr.write(
    `${TOOL_NAME}: ${document.plugins.length} plugin(s), ${measured} with at least one figure, ` +
      `${elapsedSeconds.toFixed(1)} s -> ${options.outPath ?? "stdout"}\n`,
  );
  emit({ step: "done", plugins: document.plugins.length, measured, elapsedSeconds });
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err), 1));
