// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The descriptor writer runs once per plugin with the budget to itself: one that hangs is recorded on its own plugin
 * (`descriptorProblem`) and the others keep their descriptors and their records. The scanner, the probe runner and
 * `python3` are stand-ins (shell scripts), so the test needs no native build.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { parseSyncArgs, resolveSyncSettings, runSync, type SyncState } from "./qualify-sync.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "qualify-sync-descriptor-timeout-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PROBE = readFileSync(join(PKG, "fixtures", "probe-output", "success-msi.json"), "utf8");

const plugin = (id: string) => ({
  id, name: id, vendor: "v", version: "1", description: "d", url: "u", features: ["audio-effect"],
  params: [], audio_ports: { inputs: [], outputs: [] }, note_ports: { inputs: 0, outputs: 0 }, latency: 0,
});

describe("the descriptor writer's time", () => {
  it("is each plugin's own: the one that hangs it is recorded, the other is not", async () => {
    const root = mkdtempSync(join(scratch, "t-"));
    const clap = join(root, "clap");
    const out = join(root, "out");
    const bin = join(root, "bin");
    mkdirSync(clap);
    mkdirSync(bin);
    mkdirSync(join(root, "lv2"));
    writeFileSync(join(clap, "two.clap"), "bytes of a bundle with two plugins");
    writeFileSync(join(root, "scan.json"), JSON.stringify({ scanner: "clap-qualify", version: "0.1.0", files: [{ path: join(clap, "two.clap"), plugins: ["org.example.Slow", "org.example.Quick"].map(plugin) }] }));
    writeFileSync(join(root, "probe.json"), PROBE);
    const script = (dir: string, name: string, body: string): string => {
      const p = join(dir, name);
      writeFileSync(p, `#!/bin/sh\n${body}\n`);
      chmodSync(p, 0o755);
      return p;
    };
    const scanner = script(root, "clap-qualify", `cat ${JSON.stringify(join(root, "scan.json"))}`);
    // the descriptor writer: it hangs on the document that holds the slow plugin, and is done at once on any other
    script(bin, "python3", `if cat | grep -q org.example.Slow; then exec sleep 30; fi`);
    const interposer = join(root, "rt_interpose.so");
    writeFileSync(interposer, "");
    const runner = script(
      root,
      "probe-runner",
      `while [ "$1" != "--out" ]; do shift; done; o="$2"; shift 2; while [ "\${1#--}" != "$1" ]; do shift 2; done; f="$1"; id="$2"
sed -e "s|\\"id\\": \\"org.example.plate\\"|\\"id\\": \\"$id\\"|" -e "s|/usr/lib64/clap/example-plate.clap|$f|" ${JSON.stringify(join(root, "probe.json"))} > "$o"`,
    );
    // plugin-hostd --pin-files clap:<path>#<id>: the file and its directory, as the daemon's CLAP collector names them
    const hostd = script(root, "plugin-hostd", `while [ "$1" != "--pin-files" ]; do shift; done; u="$2"; p="\${u#clap:}"; p="\${p%#*}"; echo "root $(dirname "$p")"; echo "file $(basename "$p")"`);
    const env = { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, OMX_CLAP_QUALIFY: scanner, OMX_RT_INTERPOSE: interposer, OMX_PROBE_RUNNER: runner, PLUGIN_HOSTD: hostd } as Record<string, string>;
    const args = parseSyncArgs([
      "--config", "/dev/null", "--clap-path", clap, "--lv2-path", join(root, "lv2"), "--lv2-extra", "",
      "--pin-file", join(out, "qualified.pins"), "--qualification-dir", join(out, "qualification"),
      "--descriptor-dir", join(out, "descriptors"), "--state-file", join(out, "state.json"),
      "--budget-s", "1", "--hostd-port", "0", "--hostd-feedback-port", "0", "--settle-s", "0", "--no-distributed",
    ]);
    if (!args.ok) throw new Error(args.error);
    const r = resolveSyncSettings(new Map(), args.args, env, "/home/u");
    if (!r.ok) throw new Error(r.error);
    const lines: string[] = [];
    await runSync(r.settings, { env, log: (l) => lines.push(l) });
    const state = JSON.parse(readFileSync(join(out, "state.json"), "utf8")) as SyncState;
    const plugins = Object.values(state.entries).flatMap((e) => e.plugins);
    const slow = plugins.find((p) => p.uri.endsWith("#org.example.Slow"));
    const quick = plugins.find((p) => p.uri.endsWith("#org.example.Quick"));
    expect(slow?.descriptorProblem, lines.join("\n")).toMatch(/ETIMEDOUT/);
    expect(quick?.descriptorProblem).toBeUndefined();
    expect(quick?.outcome).toBe("qualified");
  }, 30000);
});
