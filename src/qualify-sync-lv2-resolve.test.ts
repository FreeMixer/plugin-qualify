// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * AN LV2 PLUGIN IS THE ONE LILV LOADS, AND ITS RECORD IS KEYED BY ITS URI AND ITS BINARY (#199, option 1).
 *
 * An LV2 complement writes a replacing bundle (omx-complement-<bundle>.lv2) with lv2:microVersion one above and the
 * installed binary named by an absolute IRI and linked in. lilv, and every host built on it, loads the complement; the
 * sync took the first bundle a directory listing found, so the first complement write requalified the plugin and
 * pruned its records, and two hosts loaded two bundles of one plugin. The sync now asks lilv which bundle it takes,
 * over the whole search path, and a plugin whose binary is the same bytes keeps its record under the new bundle.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  LILV_RESOLVE, SYNC_STATE_SCHEMA, digestFiles, discoverSyncItems, parseSyncArgs, resolveSyncSettings, runSync, sameBinaryElsewhere,
  type Lv2Resolve, type SyncState,
} from "./qualify-sync.js";

const scratch = mkdtempSync(join(tmpdir(), "qualify-sync-lv2-resolve-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const URI = "urn:t:fx";

/** An installed bundle (micro 4) in a/ and its complement (micro 5, the installed binary by absolute IRI, linked in) in b/. */
function machine() {
  const root = mkdtempSync(join(scratch, "m-"));
  const a = join(root, "a"), b = join(root, "b");
  const installed = join(a, "fx.lv2"), complement = join(b, "omx-complement-fx.lv2");
  mkdirSync(installed, { recursive: true });
  mkdirSync(complement, { recursive: true });
  writeFileSync(join(installed, "fx.so"), "the binary's bytes");
  const manifest = (binary: string) =>
    `@prefix lv2: <http://lv2plug.in/ns/lv2core#> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n<${URI}> a lv2:Plugin ; lv2:binary <${binary}> ; rdfs:seeAlso <fx.ttl> .\n`;
  const ttl = (micro: number) =>
    `@prefix lv2: <http://lv2plug.in/ns/lv2core#> .\n<${URI}> a lv2:Plugin ; lv2:minorVersion 1 ; lv2:microVersion ${String(micro)} ;\n  lv2:port [ a lv2:InputPort, lv2:ControlPort ; lv2:index 0 ; lv2:symbol "g" ; lv2:name "G" ] .\n`;
  writeFileSync(join(installed, "manifest.ttl"), manifest("fx.so"));
  writeFileSync(join(installed, "fx.ttl"), ttl(4));
  writeFileSync(join(complement, "manifest.ttl"), manifest(`file://${join(installed, "fx.so")}`));
  writeFileSync(join(complement, "fx.ttl"), ttl(5));
  symlinkSync(join(installed, "fx.so"), join(complement, "fx.so"));
  return { root, a, b, installed, complement };
}

const takesComplement = (m: ReturnType<typeof machine>): Lv2Resolve => () => [{ uri: URI, bundle: m.complement, binary: join(m.installed, "fx.so") }];

describe("the LV2 bundle the sync keys a plugin by is the one lilv loads (#199)", () => {
  it("with lilv's answer the complement is the plugin, its linked binary tracked; without it, the first bundle found", () => {
    const m = machine();
    const lilv = discoverSyncItems({ lv2Dirs: [m.a, m.b], clapDirs: [] }, takesComplement(m));
    expect(lilv.items).toEqual([expect.objectContaining({ key: `lv2:${URI}`, root: m.complement, binary: join(m.installed, "fx.so"), files: ["manifest.ttl", "fx.ttl", "fx.so"] })]);
    expect(discoverSyncItems({ lv2Dirs: [m.a, m.b], clapDirs: [] }).items[0]).toMatchObject({ root: m.installed });
  });

  it("a lilv that cannot answer is a note and the first bundle is taken; it is not a directory that cannot be read", () => {
    const m = machine();
    const r = discoverSyncItems({ lv2Dirs: [m.a, m.b], clapDirs: [] }, () => ({ problem: "no lilv" }));
    expect(r.problems).toEqual([]);
    expect(r.notes).toEqual(["lilv could not resolve the LV2 plugins (no lilv); each is keyed by the first bundle found"]);
    expect(r.items[0]).toMatchObject({ root: m.installed });
  });

  it("the same binary under another bundle keeps the record with the new bundle; other bytes do not", () => {
    const m = machine();
    const [old] = discoverSyncItems({ lv2Dirs: [m.a], clapDirs: [] }).items;
    const entry = { format: "lv2" as const, root: old!.root, files: digestFiles(old!.root, old!.files)!, qualifiedAt: "2026-10-30T00:00:00.000Z", seconds: 1, plugins: [{ uri: URI, outcome: "qualified" as const }] };
    const [now] = discoverSyncItems({ lv2Dirs: [m.a, m.b], clapDirs: [] }, takesComplement(m)).items;
    expect(sameBinaryElsewhere(now!, entry)).toMatchObject({ root: m.complement, plugins: entry.plugins });
    writeFileSync(join(m.installed, "fx.so"), "other bytes");
    expect(sameBinaryElsewhere(now!, entry)).toBeUndefined();
  });

  it("a run over a qualified plugin whose complement appeared measures nothing and moves the record to the complement", async () => {
    const m = machine();
    const [old] = discoverSyncItems({ lv2Dirs: [m.a], clapDirs: [] }).items;
    const state: SyncState = {
      schema: SYNC_STATE_SCHEMA,
      entries: { [`lv2:${URI}`]: { format: "lv2", root: old!.root, files: digestFiles(old!.root, old!.files)!, qualifiedAt: "2026-10-30T00:00:00.000Z", seconds: 1, plugins: [{ uri: URI, outcome: "qualified" }] } },
    };
    writeFileSync(join(m.root, "state.json"), JSON.stringify(state));
    const args = parseSyncArgs(["--lv2-path", `${m.a}:${m.b}`, "--lv2-extra", "", "--clap-path", join(m.root, "no-clap"), "--clap-extra", "",
      "--pin-file", join(m.root, "qualified.pins"), "--qualification-dir", join(m.root, "q"), "--descriptor-dir", join(m.root, "d"),
      "--state-file", join(m.root, "state.json"), "--hostd-port", "0", "--hostd-feedback-port", "0", "--settle-s", "0", "--no-distributed"]);
    if (!args.ok) throw new Error(args.error);
    const r = resolveSyncSettings(new Map(), args.args, {}, m.root);
    if (!r.ok) throw new Error(r.error);
    const lines: string[] = [];
    const summary = await runSync(r.settings, { env: {}, lv2Resolve: takesComplement(m), log: (l) => lines.push(l) });
    expect(summary).toMatchObject({ qualified: 0, unmeasured: 0, skipped: 1 });
    expect(lines.some((l) => l.startsWith(`lv2:${URI}: loaded from ${m.complement} now`))).toBe(true);
    const after = JSON.parse(readFileSync(join(m.root, "state.json"), "utf8")) as SyncState;
    expect(after.entries[`lv2:${URI}`]).toMatchObject({ root: m.complement, plugins: [{ uri: URI, outcome: "qualified" }] });
  });
});

const lilvPython = spawnSync("python3", ["-c", "import lilv"]).status === 0;

describe.skipIf(!lilvPython)("lilv itself, through tools/lv2_resolve.py", () => {
  it("takes the complement (micro 5 over 4) whichever directory comes first, and names the installed binary", () => {
    const m = machine();
    for (const dirs of [[m.a, m.b], [m.b, m.a]]) {
      const r = LILV_RESOLVE(dirs);
      expect(r).toEqual([{ uri: URI, bundle: m.complement, binary: join(m.installed, "fx.so") }]);
    }
  });
});
