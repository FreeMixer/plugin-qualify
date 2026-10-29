// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * A `.clap` that declares several plugin ids: the sync keeps one record and one pin per id, each with the file's path,
 * and its summary counts every id. The scanner and the probe runner are stand-ins (shell scripts) so the test needs
 * no native build: the scan lists two ids, the runner answers with the probe output of the id it was asked for.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { parsePinLine } from "./pins-file.js";
import { parseSyncArgs, resolveSyncSettings, runSync } from "./qualify-sync.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "qualify-sync-multi-id-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PROBE = readFileSync(join(PKG, "fixtures", "probe-output", "success-msi.json"), "utf8");

const plugin = (id: string) => ({
  id, name: id, vendor: "v", version: "1", description: "d", url: "u", features: ["audio-effect"],
  params: [], audio_ports: { inputs: [], outputs: [] }, note_ports: { inputs: 0, outputs: 0 }, latency: 0,
});

function stands(ids: readonly string[]): { env: Record<string, string>; clap: string; out: string; flags: string[] } {
  const root = mkdtempSync(join(scratch, "m-"));
  const clap = join(root, "clap");
  const out = join(root, "out");
  mkdirSync(clap);
  mkdirSync(join(root, "lv2"));
  writeFileSync(join(clap, "multi.clap"), "bytes of a bundle with several plugins");
  writeFileSync(join(root, "scan.json"), JSON.stringify({ scanner: "clap-qualify", version: "0.1.0", files: [{ path: join(clap, "multi.clap"), plugins: ids.map(plugin) }] }));
  writeFileSync(join(root, "probe.json"), PROBE);
  const script = (name: string, body: string): string => {
    const p = join(root, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const scanner = script("clap-qualify", `cat ${JSON.stringify(join(root, "scan.json"))}`);
  const interposer = join(root, "rt_interpose.so");
  writeFileSync(interposer, "");
  // plugin-hostd-probe run ... --out FILE <file> <id>: the fixture's probe output, for that file and that id
  const runner = script(
    "probe-runner",
    `while [ "$1" != "--out" ]; do shift; done; o="$2"; shift 2; while [ "\${1#--}" != "$1" ]; do shift 2; done; f="$1"; id="$2"
sed -e "s|\\"id\\": \\"org.example.plate\\"|\\"id\\": \\"$id\\"|" -e "s|/usr/lib64/clap/example-plate.clap|$f|" ${JSON.stringify(join(root, "probe.json"))} > "$o"`,
  );
  return {
    env: { ...process.env, OMX_CLAP_QUALIFY: scanner, OMX_RT_INTERPOSE: interposer, OMX_PROBE_RUNNER: runner } as Record<string, string>,
    clap,
    out,
    flags: [
      "--config", "/dev/null", "--clap-path", clap, "--lv2-path", join(root, "lv2"), "--lv2-extra", "",
      "--pin-file", join(out, "qualified.pins"), "--qualification-dir", join(out, "qualification"),
      "--descriptor-dir", join(out, "descriptors"), "--state-file", join(out, "state.json"),
      "--budget-s", "4", "--hostd-port", "0", "--hostd-feedback-port", "0", "--settle-s", "0", "--no-distributed",
    ],
  };
}

describe("a .clap that declares two plugin ids", () => {
  it("yields two records and two pins, each with the file's path, and the summary counts both", async () => {
    const ids = ["studio.kx.distrho.MVerb", "studio.kx.distrho.3BandEQ"];
    const m = stands(ids);
    const args = parseSyncArgs(m.flags);
    if (!args.ok) throw new Error(args.error);
    const r = resolveSyncSettings(new Map(), args.args, m.env, "/home/u");
    if (!r.ok) throw new Error(r.error);
    const lines: string[] = [];
    const summary = await runSync(r.settings, { env: m.env, log: (l) => lines.push(l) });
    const said = lines.join("\n");
    const file = join(m.clap, "multi.clap");
    const pins = readFileSync(join(m.out, "qualified.pins"), "utf8").split("\n").map((l) => parsePinLine(l)).filter((p) => p !== undefined);
    expect(pins.map((p) => p!.uri).sort(), said).toEqual(ids.map((id) => `clap:${file}#${id}`).sort());
    const records = readdirSync(join(m.out, "qualification")).filter((f) => f.endsWith(".qualification.json")).sort();
    expect(records.map((f) => f.split("@")[0])).toEqual([...ids].sort());
    expect(summary?.qualified, said).toBe(2);
    // the next run finds both recorded as they are
    const again = await runSync(r.settings, { env: m.env, log: () => {} });
    expect([again?.skipped, again?.qualified]).toEqual([2, 0]);
  });

  it("a bundle with one id keeps the key it always had, clap:<path>#<id>", async () => {
    const m = stands(["org.example.one"]);
    const args = parseSyncArgs(m.flags);
    if (!args.ok) throw new Error(args.error);
    const r = resolveSyncSettings(new Map(), args.args, m.env, "/home/u");
    if (!r.ok) throw new Error(r.error);
    const summary = await runSync(r.settings, { env: m.env, log: () => {} });
    const pins = readFileSync(join(m.out, "qualified.pins"), "utf8").split("\n").map((l) => parsePinLine(l)).filter((p) => p !== undefined);
    expect(pins.map((p) => p!.uri)).toEqual([`clap:${join(m.clap, "multi.clap")}#org.example.one`]);
    expect(summary?.qualified).toBe(1);
    expect(readdirSync(join(m.out, "qualification")).filter((f) => f.endsWith(".qualification.json"))[0]).toMatch(/^org\.example\.one@/);
  });
});
