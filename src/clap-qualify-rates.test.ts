// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
//
// Each rate is judged in an instance of its own, as a host at a fixed rate makes one: a plugin that aborts when one
// instance is activated again at another rate (LSP's CLAP builds, docs/notes/lsp-reactivation-at-another-rate.md) is
// measured at every rate and does not crash the prober.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BUILD = join(dirname(fileURLToPath(import.meta.url)), "..", "native", "build");
const QUALIFY = join(BUILD, "clap-qualify");
const PINNED = join(BUILD, "fixtures-faulty", "rate-pinned.clap");
const BUILT = existsSync(QUALIFY) && existsSync(PINNED);

describe("clap-qualify judges each rate in an instance of its own", () => {
  it("a plugin that aborts when activated again at another rate is measured at both rates", { timeout: 120_000 }, (ctx) => {
    if (!BUILT) ctx.skip("no native/build: make -C native deps all");
    const r = spawnSync(QUALIFY, ["--rates", "48000,96000", "--block", "256", "--blocks", "8", PINNED], { encoding: "utf8" });
    expect(r.signal, r.stderr).toBeNull();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('"48000"');
    expect(r.stdout).toContain('"96000"');
  });
});
