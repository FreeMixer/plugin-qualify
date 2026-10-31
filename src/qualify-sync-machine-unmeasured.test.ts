// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * A PLUGIN LEFT UNMEASURED BY THE MACHINE IS MEASURED AGAIN, AND A RUN THE MACHINE FAILED ENDS FAILED (#192 items 1, 2).
 *
 * The 2026-10-28 run wrote 998 unmeasured records for one reason of the machine, exited 0, and the next run skipped
 * every one because its files were unchanged. A plugin unmeasured by the machine (an EACCES, EPERM or ENOSPC, or a
 * measurement that wrote no document) is retried; a permanent reason of the plugin is not. A run where every plugin
 * it measured is unmeasured for one such reason says the reason once and ends failed.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { machineReason, parseSyncArgs, resolveSyncSettings, runSync, SYNC_CODE } from "./qualify-sync.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "qualify-sync-machine-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PROBE = readFileSync(join(PKG, "fixtures", "probe-output", "success-msi.json"), "utf8");

const plugin = (id: string) => ({
  id, name: id, vendor: "v", version: "1", description: "d", url: "u", features: ["audio-effect"],
  params: [], audio_ports: { inputs: [], outputs: [] }, note_ports: { inputs: 0, outputs: 0 }, latency: 0,
});

function stands(ids: readonly string[]): { env: Record<string, string>; clap: string; out: string; flags: string[]; deny: string } {
  const root = mkdtempSync(join(scratch, "m-"));
  const clap = join(root, "clap");
  const out = join(root, "out");
  mkdirSync(clap);
  mkdirSync(join(root, "lv2"));
  writeFileSync(join(clap, "multi.clap"), "bytes of a bundle with several plugins");
  // a file beside the .clap that the daemon's stand-in names for its pins, which no probe output lists
  writeFileSync(join(clap, "multi.clap.resources"), "resources the daemon names");
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
    `if [ -e ${JSON.stringify(join(root, "deny"))} ]; then echo "cannot open /dev/shm/probe: EACCES" >&2; exit 2; fi
while [ "$1" != "--out" ]; do shift; done; o="$2"; shift 2; while [ "\${1#--}" != "$1" ]; do shift 2; done; f="$1"; id="$2"
sed -e "s|\\"id\\": \\"org.example.plate\\"|\\"id\\": \\"$id\\"|" -e "s|/usr/lib64/clap/example-plate.clap|$f|" ${JSON.stringify(join(root, "probe.json"))} > "$o"`,
  );
  // plugin-hostd --pin-files clap:<path>#<id>: the file and its directory, as the daemon's CLAP collector names them
  const hostd = script("plugin-hostd", `while [ "$1" != "--pin-files" ]; do shift; done; u="$2"; p="\${u#clap:}"; p="\${p%#*}"; echo "root $(dirname "$p")"; echo "file $(basename "$p")"; echo "file multi.clap.resources"`);
  return {
    env: { ...process.env, OMX_CLAP_QUALIFY: scanner, OMX_RT_INTERPOSE: interposer, OMX_PROBE_RUNNER: runner, PLUGIN_HOSTD: hostd } as Record<string, string>,
    clap,
    out,
    deny: join(root, "deny"),
    flags: [
      "--config", "/dev/null", "--clap-path", clap, "--lv2-path", join(root, "lv2"), "--lv2-extra", "",
      "--pin-file", join(out, "qualified.pins"), "--qualification-dir", join(out, "qualification"),
      "--descriptor-dir", join(out, "descriptors"), "--state-file", join(out, "state.json"),
      "--budget-s", "4", "--hostd-port", "0", "--hostd-feedback-port", "0", "--settle-s", "0", "--no-distributed",
    ],
  };
}

describe("a plugin the machine left unmeasured (#192)", () => {
  it("a run where every plugin is unmeasured by one machine reason says it once and carries it to the end", async () => {
    const m = stands(["a.one", "a.two"]);
    writeFileSync(m.deny, "");
    const args = parseSyncArgs(m.flags);
    if (!args.ok) throw new Error(args.error);
    const r = resolveSyncSettings(new Map(), args.args, m.env, "/home/u");
    if (!r.ok) throw new Error(r.error);
    const lines: string[] = [];
    const summary = await runSync(r.settings, { env: m.env, log: (l) => lines.push(l) });
    expect(summary).toMatchObject({ unmeasured: 2, qualified: 0, machineFailure: "EACCES" });
    expect(lines.filter((l) => /: unmeasured \(/.test(l))).toHaveLength(1);
    expect(lines).toContain("2 plugins unmeasured by the machine (EACCES); the first is listed above");
  });

  it("the next run measures them again although their files are unchanged", async () => {
    const m = stands(["b.one", "b.two"]);
    writeFileSync(m.deny, "");
    const args = parseSyncArgs(m.flags);
    if (!args.ok) throw new Error(args.error);
    const r = resolveSyncSettings(new Map(), args.args, m.env, "/home/u");
    if (!r.ok) throw new Error(r.error);
    await runSync(r.settings, { env: m.env, log: () => {} });
    rmSync(m.deny);
    const again = await runSync(r.settings, { env: m.env, log: () => {} });
    expect(again).toMatchObject({ skipped: 0, qualified: 2 });
    expect(again?.machineFailure).toBeUndefined();
    const third = await runSync(r.settings, { env: m.env, log: () => {} });
    expect(third).toMatchObject({ skipped: 2, qualified: 0 });
  });

  it("only the machine's reasons count: an errno, or a measurement that wrote no document", () => {
    const u = (code: string, detail?: string) => ({ outcome: "unmeasured" as const, code, ...(detail === undefined ? {} : { detail }) });
    expect(machineReason(u(SYNC_CODE.notMeasured, "probe exited 2 measuring x, and wrote no document: open: ENOSPC"))).toBe("ENOSPC");
    expect(machineReason(u(SYNC_CODE.notMeasured, "probe exited 2 measuring x, and wrote no document"))).toBe("the measurement wrote no document");
    expect(machineReason(u(SYNC_CODE.notMeasured, "probe: no such plugin x"))).toBeUndefined();
    expect(machineReason(u("probe.limit.not-implemented"))).toBeUndefined();
    expect(machineReason({ outcome: "qualified" })).toBeUndefined();
  });
});
