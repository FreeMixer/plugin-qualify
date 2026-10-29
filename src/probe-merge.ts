// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The runs of one plugin and one offer, made one probe output (#193). The grid takes several runs of the probe runner
 * (one per quantum for a CLAP plugin, one per cell for an LV2 one); the judge and the record read one document. The
 * merge is a translation, never a judgment:
 *
 * - the grid is every run's points, and, for a run that did not end `probe.ok`, a point at each of its cells that holds
 *   none, carrying the run's outcome (and, for `probe.oom`, the bound it ran under), so no cell is silently absent;
 * - the steps are every run's, in order; the run's time is the sum, and it is complete when every run was;
 * - the run's outcome is the first that was not `probe.ok` among the runs that did not outgrow the bound; a run that
 *   outgrew it leaves its cells `probe.oom` and the rest are still judged; when every run did, it is `probe.oom`;
 * - `run.parts` names each run: its id, its outcome, its rates and quantum, its time.
 *
 * One run that ended well and needs nothing added is kept as the runner wrote it, byte for byte.
 */
import { outOfMemory, PROBE_OOM, type MemoryBound } from "./memory-bound.js";
import { cellKey, type RunnerInvocation } from "./measurement-grid.js";
import { PROBE_OK, readProbeOutput, type ProbeOutput } from "./probe-output.js";

/** One run of the runner, as it was read. */
export interface ProbeRunPart {
  readonly bytes: Buffer;
  readonly output: ProbeOutput;
  readonly invocation: RunnerInvocation;
}

export class ProbeMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeMergeError";
  }
}

type Json = Record<string, unknown>;

export function mergeProbeRuns(parts: readonly ProbeRunPart[], bound: MemoryBound | undefined): { bytes: Buffer; output: ProbeOutput } {
  if (parts.length === 0) throw new ProbeMergeError("no run to merge");
  const outcomes = parts.map((p) => (outOfMemory(p.output, bound) ? PROBE_OOM : p.output.run.outcome));
  const first = parts[0]!;
  for (const p of parts.slice(1)) {
    if (p.output.plugin.id !== first.output.plugin.id || p.output.binary.sha256 !== first.output.binary.sha256 || p.output.offer.id !== first.output.offer.id) {
      throw new ProbeMergeError(
        `the runs of ${first.output.plugin.id} measured different things (${p.output.plugin.id}, ${p.output.binary.sha256.slice(0, 12)}, offer ${p.output.offer.id}): the plugin's files changed between them`,
      );
    }
  }
  const missingCell = (p: ProbeRunPart): boolean => p.invocation.cells.some((c) => !p.output.grid.some((g) => g.rate === c.rate && g.quantum === c.quantum));
  if (parts.length === 1 && outcomes[0] === first.output.run.outcome && (outcomes[0] === PROBE_OK || !missingCell(first))) {
    return { bytes: first.bytes, output: first.output };
  }

  const docs = parts.map((p) => JSON.parse(p.bytes.toString("utf8")) as Json);
  const merged = structuredClone(docs[0]!);
  const grid: Json[] = [];
  const seen = new Set<string>();
  const steps: unknown[] = [];
  parts.forEach((p, i) => {
    for (const point of (docs[i]!["grid"] as Json[] | undefined) ?? []) {
      const key = cellKey({ rate: point["rate"] as number, quantum: point["quantum"] as number });
      if (seen.has(key)) continue;
      seen.add(key);
      grid.push(point);
    }
    if (outcomes[i] !== PROBE_OK) {
      for (const c of p.invocation.cells) {
        if (seen.has(cellKey(c))) continue;
        seen.add(cellKey(c));
        grid.push({ rate: c.rate, quantum: c.quantum, outcome: outcomes[i], ...(outcomes[i] === PROBE_OOM && bound !== undefined ? { memoryLimit: { bytes: bound.bytes, mechanism: bound.mechanism } } : {}) });
      }
    }
    steps.push(...((docs[i]!["steps"] as unknown[] | undefined) ?? []));
  });
  const judged = outcomes.filter((o) => o !== PROBE_OOM);
  const run = merged["run"] as Json;
  merged["run"] = {
    ...run,
    elapsedMs: parts.reduce((sum, p) => sum + p.output.run.elapsedMs, 0),
    complete: parts.every((p, i) => p.output.run.complete && outcomes[i] === PROBE_OK),
    outcome: judged.length === 0 ? PROBE_OOM : (judged.find((o) => o !== PROBE_OK) ?? PROBE_OK),
    parts: parts.map((p, i) => ({ id: p.output.run.id, outcome: outcomes[i], rates: p.invocation.rates, quantum: p.invocation.quantum, elapsedMs: p.output.run.elapsedMs })),
  };
  merged["steps"] = steps;
  merged["grid"] = grid;
  const bytes = Buffer.from(`${JSON.stringify(merged, null, 2)}\n`);
  const read = readProbeOutput(bytes.toString("utf8"));
  if (!read.ok) throw new ProbeMergeError(`the merged runs of ${first.output.plugin.id} do not read as a probe output (${read.code}): ${read.problem}`);
  return { bytes, output: read.output };
}
