// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * What the sync leaves of a plugin that is gone (#168): its pin, qualification record, probe copy and descriptor are
 * removed, a running plugin-hostd is told with pin_clear, and what belongs to a plugin still there (or to no plugin
 * of the sync's) stays. Runs the real run over a machine with no plugin to qualify: nothing here needs the probe runner.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, cpSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  SYNC_STATE_SCHEMA,
  digestFiles,
  discoverSyncItems,
  parseSyncArgs,
  pruneStale,
  recordStem,
  removedPinUris,
  resolveSyncSettings,
  runSync,
  type FileDigest,
  type SyncState,
} from "./qualify-sync.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "qualify-prune-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const GONE = "urn:test:gone";
const KEPT = "urn:plugin-qualify:fixture:lv2-rt-safe";
const stem = (uri: string, sha: string): string => `${uri.replace(/[^A-Za-z0-9._-]/g, "_")}@1.0-${sha.repeat(12)}`;
const PIN_GONE = `pin_set ${GONE} gain.so=${"b".repeat(64)} omx-layout/1:${"c".repeat(64)} verdict=in-process`;

/** Listens as plugin-hostd does: the feedback port drained, the command port answering resp 0 to each NUL-ended line. */
async function fakeDaemon(): Promise<{ port: number; feedbackPort: number; lines: string[]; close: () => void }> {
  const lines: string[] = [];
  const feedback: Server = createServer((s) => s.on("data", () => {}).on("error", () => {}));
  const command: Server = createServer((s) => {
    let buf = "";
    s.setEncoding("utf8").on("error", () => {});
    s.on("data", (d: string) => {
      buf += d;
      for (let n = buf.indexOf("\0"); n >= 0; n = buf.indexOf("\0")) {
        lines.push(buf.slice(0, n));
        buf = buf.slice(n + 1);
        s.write("resp 0\0");
      }
    });
  });
  await Promise.all([feedback, command].map((srv) => new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok))));
  const portOf = (srv: Server): number => (srv.address() as { port: number }).port;
  return { port: portOf(command), feedbackPort: portOf(feedback), lines, close: () => { feedback.close(); command.close(); } };
}

/** A machine whose state remembers a plugin that is gone (GONE) and one that is still installed (KEPT). */
function machine(extraLv2Dir?: string) {
  const root = mkdtempSync(join(scratch, "m-"));
  const lv2 = join(root, "lv2");
  const bundle = join(lv2, "rt-safe.lv2");
  cpSync(join(PKG, "native", "fixtures", "rt-safe.lv2"), bundle, { recursive: true });
  writeFileSync(join(bundle, "gain.so"), "binary");
  const q = join(root, "qualification");
  const d = join(root, "descriptors");
  mkdirSync(q);
  mkdirSync(d);
  const files: Record<string, string> = {};
  for (const [uri, sha] of [[GONE, "b"], [KEPT, "a"]] as const) {
    const s = stem(uri, sha);
    for (const f of [join(q, `${s}.default.qualification.json`), join(q, `${s}.default.probe.json`), join(d, `${s}.json`)]) writeFileSync(f, "{}");
    files[uri] = s;
  }
  writeFileSync(join(q, "by-hand.default.qualification.json"), "{}"); // a record the CLI wrote, never the sync's
  const item = discoverSyncItems({ lv2Dirs: [lv2], clapDirs: [] }).items[0]!;
  const entry = (uri: string, root_: string, fileList: readonly FileDigest[], sha: string) => ({
    format: "lv2" as const, root: root_, files: fileList, qualifiedAt: "2026-10-28T00:00:00.000Z", seconds: 0,
    plugins: [{ uri, outcome: "qualified" as const, record: join(q, `${stem(uri, sha)}.default.qualification.json`) }],
  });
  const state: SyncState = {
    schema: SYNC_STATE_SCHEMA,
    entries: { [`lv2:${GONE}`]: entry(GONE, join(root, "gone.lv2"), [], "b"), [item.key]: entry(KEPT, item.root, digestFiles(item.root, item.files)!, "a") },
  };
  writeFileSync(join(root, "state.json"), JSON.stringify(state));
  writeFileSync(join(root, "qualified.pins"), `# written by plugin-qualify-sync\n${PIN_GONE}\n`);
  const run = async (ports: { port: number; feedbackPort: number }, lv2Dirs: string) => {
    const args = parseSyncArgs(["--lv2-path", lv2Dirs, "--lv2-extra", "", "--clap-path", join(root, "no-clap"), "--clap-extra", "", "--pin-file", join(root, "qualified.pins"),
      "--qualification-dir", q, "--descriptor-dir", d, "--state-file", join(root, "state.json"), "--hostd-port", String(ports.port), "--hostd-feedback-port", String(ports.feedbackPort)]);
    if (!args.ok) throw new Error(args.error);
    const r = resolveSyncSettings(new Map(), args.args, {}, root);
    if (!r.ok) throw new Error(r.error);
    const log: string[] = [];
    const summary = await runSync(r.settings, { log: (l) => log.push(l), env: { ...process.env } });
    return { summary, log };
  };
  return { root, lv2, q, d, files, run };
}

describe("recordStem", () => {
  it("is the id, version and binary hash a record, its probe copy, its unmeasured form and its descriptor share", () => {
    expect(recordStem("org.x.id@1.2.3-0123456789ab.default.qualification.json")).toBe("org.x.id@1.2.3-0123456789ab");
    expect(recordStem("/q/org.x.id@1.2.3-0123456789ab.extras.probe.json")).toBe("org.x.id@1.2.3-0123456789ab");
    expect(recordStem("a@unversioned-0123456789ab.unmeasured.json")).toBe("a@unversioned-0123456789ab");
    expect(recordStem("by-hand.json")).toBeUndefined();
  });
});

describe("removedPinUris", () => {
  it("names the uris the first pin file pins and the second does not", () => {
    const pin = (uri: string) => `pin_set ${uri} a=1 s:2 verdict=in-process`;
    expect(removedPinUris(`# c\n${pin("u1")}\n${pin("u2")}\n`, `# c\n${pin("u2")}\n`)).toEqual(["u1"]);
    expect(removedPinUris("", `${pin("u1")}\n`)).toEqual([]);
  });
});

describe("a run over a machine whose plugin was uninstalled", () => {
  it("removes its pin, record, probe copy and descriptor, keeps what is still there, and tells plugin-hostd with pin_clear", async () => {
    const m = machine();
    const daemon = await fakeDaemon();
    try {
      const r = await m.run(daemon, m.lv2);
      expect(r.summary).toMatchObject({ qualified: 0, skipped: 1 });
      expect(readdirSync(m.q).sort()).toEqual([`${m.files[KEPT]}.default.probe.json`, `${m.files[KEPT]}.default.qualification.json`, "by-hand.default.qualification.json"].sort());
      expect(readdirSync(m.d)).toEqual([`${m.files[KEPT]}.json`]);
      expect(readFileSync(join(m.root, "qualified.pins"), "utf8")).not.toContain(GONE);
      expect(daemon.lines).toEqual([`pin_clear ${GONE}`]);
    } finally {
      daemon.close();
    }
  });

  it("removes nothing when a bundle could not be read: a half-written one is no uninstall", async () => {
    const m = machine();
    mkdirSync(join(m.lv2, "broken.lv2", "manifest.ttl"), { recursive: true }); // a bundle whose manifest cannot be read
    const before = [readdirSync(m.q).length, readdirSync(m.d).length];
    const r = await m.run({ port: 0, feedbackPort: 0 }, m.lv2);
    expect(r.log.join("\n")).toContain("no record or descriptor is removed this run");
    expect([readdirSync(m.q).length, readdirSync(m.d).length]).toEqual(before);
    expect(existsSync(join(m.d, `${m.files[GONE]}.json`))).toBe(true);
  });
});

describe("pruneStale", () => {
  it("keeps a record another plugin of the state still names, and removes the ones of a binary that changed", () => {
    const m = machine();
    const entry = (record: string) => ({ format: "lv2" as const, root: "/r", files: [], qualifiedAt: "", seconds: 0, plugins: [{ uri: "u", outcome: "qualified" as const, record }] });
    const q = (s: string) => join(m.q, `${s}.default.qualification.json`);
    const before: SyncState = { schema: SYNC_STATE_SCHEMA, entries: { a: entry(q(m.files[GONE]!)), b: entry(q(m.files[GONE]!)) } };
    // two copies of one binary share a record: one copy removed, the other still names it
    expect(pruneStale({ qualificationDir: m.q, descriptorDir: m.d }, before, { schema: SYNC_STATE_SCHEMA, entries: { a: before.entries["a"]! } })).toEqual([]);
    // the binary changed (a new stem): the old stem's files go
    const upgraded: SyncState = { schema: SYNC_STATE_SCHEMA, entries: { a: entry(q(stem(GONE, "d"))), b: entry(q(stem(GONE, "d"))) } };
    expect(pruneStale({ qualificationDir: m.q, descriptorDir: m.d }, before, upgraded).map((f) => f.replace(m.root, "")).sort()).toEqual([`/descriptors/${m.files[GONE]}.json`, `/qualification/${m.files[GONE]}.default.probe.json`, `/qualification/${m.files[GONE]}.default.qualification.json`].sort());
  });
});
