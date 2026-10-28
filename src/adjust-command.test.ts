// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { readRecords } from "./adjust-cli.js";
import { HISTORY_HEADER } from "./history-file.js";
import { OMX_CLAP_HOST_PROFILE } from "./host-profiles.js";
import { fixtureText } from "./probe-output-fixtures.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "adjust-command-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const CLASS = "aarch64/4/2400";
const OTHER_CLASS = "x86_64/16/4200";
const NOW = 1_800_000_000;
const HOST = OMX_CLAP_HOST_PROFILE.id;
const URI = "clap:/usr/lib64/clap/example-plate.clap#org.example.plate";
const DIGEST = "356902794a4eec2122989e072271ef995968131145db918d9a3084ce582f244b";
const line = (keys: string, cls = CLASS): string => `history ${URI} ${DIGEST} ${cls} ${keys}`;
const file = (...lines: string[]): string => [HISTORY_HEADER, ...lines, ""].join("\n");

describe("the command", () => {
  const bin = join(PKG, "bin", "plugin-qualify.mjs");
  const run = (args: string[]) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });

  it("rewrites the records with the block, prints the table and writes the adjusted pins", (ctx) => {
    if (!readdirSync(PKG).includes("dist")) ctx.skip("dist is not built");
    const dir = join(scratch, "cmd");
    const probe = join(scratch, "cmd.probe.json");
    writeFileSync(probe, fixtureText("success-msi"));
    expect(run(["judge", "--host-profile", HOST, "--qualification-dir", dir, probe]).status).toBe(0);
    const hist = join(scratch, "cmd.history");
    writeFileSync(hist, file(line("windows_solo=100 crashes_solo=1 last_crash=1799990000")));
    const pins = join(scratch, "cmd.pins");
    const r = run(["adjust", "--history", hist, "--qualification-dir", dir, "--host-profile", HOST, "--pins", pins, "--now", String(NOW)]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/org\.example\.plate\s+omx-clap-host\s+aarch64\/4\/2400\s+in-process\s+isolated\s+history\.crashed/);
    expect(readFileSync(pins, "utf8")).toMatch(/ verdict=isolated\n/);
    const rec = readRecords(dir);
    expect(rec.failures).toEqual([]);
    expect(rec.records[0]!.record.history![0]!.verdicts[0]!.adjusted).toBe("isolated");
    // the measured verdict is still what judge wrote
    expect(rec.records[0]!.record.verdicts.find((v) => v.host === HOST)).toMatchObject({ rating: "suitable", hosting: "isolated" });
    // two classes and --pins is refused by name, and the pins file is not touched
    writeFileSync(hist, file(line("windows_solo=1"), line("windows_solo=1", OTHER_CLASS)));
    const before = readFileSync(pins, "utf8");
    const two = run(["adjust", "--history", hist, "--qualification-dir", dir, "--host-profile", HOST, "--pins", pins]);
    expect(two.status).toBe(2);
    expect(two.stderr).toContain("holds 2 host classes");
    expect(readFileSync(pins, "utf8")).toBe(before);
    expect(run(["adjust", "--history", hist, "--qualification-dir", dir, "--host-profile", HOST, "--host-class", CLASS, "--pins", pins]).status).toBe(0);
  });

  it("exits 2 for a history it cannot read, a directory with no record and a history of an unknown version", (ctx) => {
    if (!readdirSync(PKG).includes("dist")) ctx.skip("dist is not built");
    const empty = mkdtempSync(join(scratch, "empty-"));
    expect(run(["adjust", "--history", join(scratch, "nowhere"), "--qualification-dir", empty]).status).toBe(2);
    const hist = join(scratch, "v2.history");
    writeFileSync(hist, "# plugin-hostd history/2\n");
    const r = run(["adjust", "--history", hist, "--qualification-dir", empty]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("no qualification record");
  });
});
