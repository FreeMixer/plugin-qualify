#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * `lv2-measure` — measure the LV2 plugins on THIS machine and write a versioned
 * measurement document (issue #343).
 *
 * Standalone by construction: it needs `python3` with the `lilv` bindings, the two probers
 * next to this file (`scan.py`, `benchmark.py`), and an LV2 world to look at. It does not
 * need openmixer's engine, its server, PipeWire, JACK, an audio interface, or root. Nothing
 * it writes is openmixer-shaped — the output is the interchange format documented in
 * `docs/design/lv2-measurement-interchange.md`, which any LV2 host can read.
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
 * ```
 *
 * `--run` (or `LV2_MEASURE_RUN=1`) is required to probe: the passes instantiate and execute
 * every plugin on the machine, which is CPU-heavy and occasionally fatal to the probe worker.
 * `--dry-run` prints the plan and touches nothing.
 *
 * ## Machine-readable progress
 *
 * With `--progress-json`, one JSON object per line is written to stderr, each prefixed
 * `@progress `. A supervising process (openmixer's Setup screen, issue #342) parses those and
 * ignores everything else, so the human log stays readable.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  advanceProgress,
  assembleDocument,
  buildPipeline,
  collectHostFacts,
  INITIAL_PROGRESS,
  parseMeasureArgs,
  parseProbeProgress,
  serialiseMeasurementDocument,
  TOOL_NAME,
  TOOL_VERSION,
} from "../dist/measurement/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const HELP = `${TOOL_NAME} ${TOOL_VERSION} — measure LV2 plugin latency and CPU cost on this machine.

  --rates 48000,96000     REQUIRED. Sample rates to measure at. There is no default:
                          a figure without a stated rate is not a measurement.
  --dimensions latency,cost
                          What to measure (default: both).
  --out PATH              Where the document goes (default: stdout).
  --scan PATH             Reuse an existing prober scan instead of scanning.
  --work-dir PATH         Where intermediates go (default: alongside --out, or a temp dir).
  --tool-dir PATH         Where scan.py / benchmark.py live (default: next to this file).
  --python BIN            Python interpreter (default: $PYTHON or python3).
  --sweep                 Also sweep latency-bearing controls (finds parameter-dependent latency).
  --cost-cpu N            Pin the cost pass to core N.
  --label TEXT            A note recorded with the run.
  --run                   Required to probe. Instantiates and runs every plugin.
  --dry-run               Print the plan and probe nothing.
  --progress-json         Emit machine-readable progress on stderr, one '@progress {...}' per line.
  --help                  This text.
`;

function fail(message, code = 2) {
  process.stderr.write(`${TOOL_NAME}: ${message}\n`);
  process.exit(code);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
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

  const pipeline = buildPipeline(options);

  if (options.dryRun) {
    process.stderr.write(
      `${TOOL_NAME} would measure ${options.dimensions.join(" + ")} at ${options.rates.join(", ")} Hz\n`,
    );
    for (const step of pipeline.steps) {
      process.stderr.write(`  ${step.id}: ${step.command} ${step.args.join(" ")}\n`);
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
  for (const step of pipeline.steps) {
    process.stderr.write(`== ${step.id}\n`);
    await runStep(step, onProgress);
  }
  const elapsedSeconds = (Date.now() - startedAt) / 1000;

  const document = assembleDocument({
    options,
    catalog: readJson(pipeline.finalCatalog),
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

  const measured = document.plugins.filter(
    (p) => Object.keys(p.latency?.perRate ?? {}).length > 0 || Object.keys(p.cost?.perRate ?? {}).length > 0,
  ).length;
  process.stderr.write(
    `${TOOL_NAME}: ${document.plugins.length} plugin(s), ${measured} with at least one figure, ` +
      `${elapsedSeconds.toFixed(1)} s -> ${options.outPath ?? "stdout"}\n`,
  );
  emit({ step: "done", plugins: document.plugins.length, measured, elapsedSeconds });
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err), 1));
