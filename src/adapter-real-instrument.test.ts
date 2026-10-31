// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The adapter pass on a real instrument: mda Piano from the distribution under omx-clap-host's LV2 adapter, on a private
 * JACK server, played by `tools/mod-host-admit.mjs` and read at its JACK ports by jack_peak. The tool's other tests use a
 * stand-in, which proves what is done with a level and never that a note reaches an instrument. On CI a missing tool is a
 * failure; elsewhere the test skips.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ADAPTER_HOST, SPAWNED_ADMISSIONS, classifyProtocolRun } from "./host-admission.js";
import { startPrivateJack } from "./qualify-adapter-pass.js";
import { ADMIT_STATE_DIR_ENV, JACK_PEAK_TOOL_NAME } from "./qualify-declarations.js";
import { nativeToolCandidates } from "./tool-paths.js";

const PIANO = "http://drobilla.net/plugins/mda/Piano";
const LV2_DIRS = ["/usr/lib/x86_64-linux-gnu/lv2", "/usr/lib/lv2", "/usr/lib64/lv2"];
const CELL = { rate: 48000, quantum: 128 };
/** Well above the noise of a silent output and well below a piano: -60 dBFS. */
const SOUNDING_PEAK = 1e-3;

const installed = (tool: string): boolean => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;
const peakTool = nativeToolCandidates(JACK_PEAK_TOOL_NAME).find((p) => existsSync(p));
const ready = peakTool !== undefined && installed("jackd") && installed(ADAPTER_HOST) && LV2_DIRS.some((d) => existsSync(join(d, "mda.lv2")));

describe("the adapter pass on a real instrument", () => {
  it("mda Piano is admitted and sounds under its held note", (ctx) => {
    if (!ready) {
      if (process.env["CI"] !== undefined) throw new Error("jackd, omx-clap-host, jack_peak or mda-lv2 is missing: CI installs them");
      ctx.skip("needs jackd, omx-clap-host, native/build and mda-lv2");
    }
    const server = startPrivateJack(CELL);
    if (server === undefined) throw new Error("no private JACK server came up");
    const state = mkdtempSync(join(tmpdir(), "adapter-real-instrument-"));
    try {
      const run = SPAWNED_ADMISSIONS.adapter!(PIANO, { ...process.env, JACK_DEFAULT_SERVER: server.name, LV2_PATH: LV2_DIRS.join(":"), OMX_JACK_PEAK: peakTool, [ADMIT_STATE_DIR_ENV]: state, HOME: state });
      const what = JSON.stringify(run);
      expect(run.sound?.peak, what).toBeGreaterThan(SOUNDING_PEAK);
      expect(classifyProtocolRun(ADAPTER_HOST, run), what).toMatchObject({ measured: true, admitted: true });
    } finally {
      server.stop();
      rmSync(state, { recursive: true, force: true });
    }
  });
});
