// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * `plugin-qualify-records-package`, end to end: a device's qualification directory in, a Debian package out, its
 * members, control and file list read back from the archive itself (and by dpkg-deb where the machine has it). The
 * package's tree, unpacked, is then the distributed layer of a sync, which takes the plugin from it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { DISTRIBUTED_LAYER_SINCE } from "./distributed-records.js";
import { FIXTURE_CLAP_ID, writeFakeClap, writeFixtureRecord } from "./distributed-records.support.js";
import { parseSyncArgs, resolveSyncSettings, runSync } from "./qualify-sync.js";
import { readDeb } from "./records-package.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = join(PKG, "bin", "plugin-qualify-records-package.mjs");
const scratch = mkdtempSync(join(tmpdir(), "records-package-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const run = (args: readonly string[]) => spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });
const dpkgDeb = spawnSync("sh", ["-c", "command -v dpkg-deb"], { encoding: "utf8" }).status === 0;

/** A device's qualification directory: a record with its probe output, one whose probe output is gone, one unmeasured. */
function deviceState(): { state: string; clap: string; kept: string[]; lost: string } {
  const root = join(scratch, "device");
  const clap = join(root, "clap", "plate.clap");
  writeFakeClap(clap);
  const other = join(root, "clap", "other.clap");
  writeFakeClap(other, "other bytes\n");
  const state = join(root, "qualification");
  const good = writeFixtureRecord(state, clap);
  // a second binary under the same id would share the name: the other record goes in a directory of its own first
  const lostDir = join(root, "lost");
  const lost = writeFixtureRecord(lostDir, other);
  writeFileSync(join(state, basename(lost.recordPath)), readFileSync(lost.recordPath));
  writeFileSync(join(state, "Gone-0123456789ab.unmeasured.json"), `${JSON.stringify({ schema: "plugin-qualify.unmeasured-record/1" })}\n`);
  return { state, clap, kept: [basename(good.recordPath), basename(good.probePath)], lost: basename(lost.recordPath) };
}

describe("plugin-qualify-records-package", () => {
  const device = deviceState();
  const out = join(scratch, "out");
  const given = join(scratch, "given.json");
  writeFileSync(given, JSON.stringify({ image: "a test image", packages: { "plugin-qualify": "0.16.1" }, sources: { ui: "0123abc" } }));
  const r = run([device.state, "--host-class", "test-class", "--set", "test-set", "--provenance", given, "--version", "2026.10.29", "--out", out]);
  const deb = join(out, "omx-qualification-test-class-test-set_2026.10.29_all.deb");
  const dir = "./usr/share/omx/qualification/test-class/test-set";

  it("builds the package of the records, named for the class, the set and the version", () => {
    expect(r.stderr).toContain(`${device.lost}: its probe output`);
    expect(r.stderr).toContain("Gone-0123456789ab.unmeasured.json: unmeasured, never applies");
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n").at(-1)).toBe(`${deb}: 1 records, 3 files`);
    expect(existsSync(deb)).toBe(true);
  });

  it("is a Debian archive with its control and exactly the records, their probe outputs and the provenance", () => {
    const d = readDeb(deb);
    expect(d.members).toEqual(["debian-binary", "control.tar.xz", "data.tar.xz"]);
    expect(d.debianBinary).toBe("2.0\n");
    expect(d.control["Package"]).toBe("omx-qualification-test-class-test-set");
    expect(d.control["Version"]).toBe("2026.10.29");
    expect(d.control["Architecture"]).toBe("all");
    expect(d.control["Depends"]).toBe(`plugin-qualify (>= ${DISTRIBUTED_LAYER_SINCE}~)`);
    expect(d.files).toEqual([...device.kept, "provenance.json"].map((f) => `${dir}/${f}`).sort());
    expect(d.controlFiles).toEqual(["./control", "./md5sums"]);
    if (dpkgDeb) {
      const listed = spawnSync("dpkg-deb", ["-c", deb], { encoding: "utf8" }).stdout.split("\n").filter((l) => l.startsWith("-")).map((l) => l.split(/\s+/).at(-1));
      expect(listed.sort()).toEqual(d.files);
      expect(spawnSync("dpkg-deb", ["-f", deb, "Package"], { encoding: "utf8" }).stdout.trim()).toBe("omx-qualification-test-class-test-set");
    }
  });

  it("carries the provenance it was given with the set, the class, the package and the date added", () => {
    const tree = join(scratch, "unpacked");
    readDeb(deb, tree);
    const p = JSON.parse(readFileSync(join(tree, dir, "provenance.json"), "utf8"));
    expect(p).toEqual({
      image: "a test image",
      packages: { "plugin-qualify": "0.16.1" },
      sources: { ui: "0123abc" },
      schema: "plugin-qualify.distributed-provenance/1",
      set: "test-set",
      hostClass: "test-class",
      package: { name: "omx-qualification-test-class-test-set", version: "2026.10.29" },
      date: p.date,
    });
    expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const f of device.kept) expect(readFileSync(join(tree, dir, f))).toEqual(readFileSync(join(device.state, f)));
  });

  it("unpacked, is a distributed layer the sync takes the plugin from", async () => {
    const tree = join(scratch, "installed");
    readDeb(deb, tree);
    const m = join(scratch, "fresh");
    mkdirSync(join(m, "lv2"), { recursive: true });
    const args = parseSyncArgs([
      "--clap-path", dirname(device.clap), "--lv2-path", join(m, "lv2"), "--lv2-extra", "",
      "--qualification-dir", join(m, "q"), "--descriptor-dir", join(m, "d"), "--state-file", join(m, "s.json"), "--pin-file", join(m, "p.pins"),
      "--hostd-port", "0", "--budget-s", "5", "--host-class", "test-class", "--distributed-dir", join(tree, "usr", "share", "omx", "qualification"),
    ]);
    if (!args.ok) throw new Error(args.error);
    const s = resolveSyncSettings(new Map(), args.args, {}, m);
    if (!s.ok) throw new Error(s.error);
    // other.clap has no record in the package and is measured; plate.clap is taken from it
    unlinkSync(join(dirname(device.clap), "other.clap"));
    const lines: string[] = [];
    const summary = await runSync(s.settings, { env: {}, log: (l) => lines.push(l) });
    expect(lines).toContain(`distributed: clap:${device.clap}#${FIXTURE_CLAP_ID}: applied (test-set)`);
    expect(summary?.distributed).toBe(1);
  });

  it("refuses a name a Debian package cannot carry, and a run without its provenance", () => {
    expect(run([device.state, "--host-class", "Test_Class", "--set", "s", "--provenance", given, "--out", out]).status).toBe(2);
    expect(run([device.state, "--host-class", "c", "--set", "s", "--out", out]).status).toBe(2);
    expect(run([join(scratch, "nothing"), "--host-class", "c", "--set", "s", "--provenance", given, "--out", out]).status).toBe(2);
  });
});
