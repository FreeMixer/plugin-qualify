// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * **The LV2 plugin measurement interchange format, and the tool that produces it.**
 *
 * This directory is written to leave. Issue #343's proposal is that measured LV2 plugin
 * characteristics — per-rate latency with its scaling law, per-rate CPU cost, topology, and
 * above all the PROVENANCE without which none of it is comparable — should be publishable
 * in a shape any LV2 host can read, rather than re-derived by each project from a prober it
 * wrote itself. openmixer is the format's first consumer, which is what keeps it honest; it
 * is not meant to be the only one.
 *
 * ## What is in here, and what is deliberately not
 *
 * | module | role |
 * |---|---|
 * | `format.ts` | the schema: types, version strategy, cast-free readers, builders |
 * | `vocabulary.ts` | the controlled vocabularies — why a figure is absent, how latency scales |
 * | `provenance.ts` | the run record: machine facts read rather than assumed |
 * | `probe-json.ts` | `benchmark.py`'s working JSON → the format |
 * | `sweep-jsonl.ts` | the hosting sweep's JSONL (`lv2-measure.c`) → the three hosting dimensions |
 * | `merge.ts` | shipped defaults with local measurements over them, each figure knowing its source |
 * | `plan.ts` | which rates to measure, and how long it might take |
 * | `cli.ts` | `lv2-measure`'s decisions, with the subprocess spawning left to `tools/lv2-measure.mjs` |
 *
 * Nothing in this directory imports anything outside it — not the catalog's descriptor
 * types, not its suitability rules, not `@freemixer/core`. Extraction is a directory copy
 * plus `tools/{scan,benchmark}.py` and `tools/lv2-measure.mjs`. The openmixer-facing
 * adapters — turning a merged view back into catalog descriptors — live one level up in
 * `../measurement-catalog.ts`, on purpose.
 */

export * from "./format.js";
export * from "./vocabulary.js";
export * from "./provenance.js";
export * from "./probe-json.js";
export * from "./merge.js";
export * from "./plan.js";
export * from "./cli.js";
export * from "./sweep-jsonl.js";
