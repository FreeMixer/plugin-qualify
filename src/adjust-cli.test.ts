// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  adjustRecords,
  adjustTable,
  adjustedPinEntries,
  historyKeyOf,
  parseAdjustArgs,
  readRecords,
  type RecordFile,
} from "./adjust-cli.js";
import { HISTORY_HEADER } from "./history-file.js";
import { OMX_CLAP_HOST_PROFILE, OPENMIXER_CONSOLE_PROFILE } from "./host-profiles.js";
import { judgeProbeOutput } from "./probe-judge.js";
import { readProbeOutput } from "./probe-output.js";
import { fixtureText } from "./probe-output-fixtures.js";
import { parsePinLine, pinsFile } from "./pins-file.js";
import { rewriteRecord, writeQualification, type QualificationRecord } from "./qualification-record.js";

const scratch = mkdtempSync(join(tmpdir(), "adjust-cli-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const URI = "clap:/usr/lib64/clap/example-plate.clap#org.example.plate";
const DIGEST = "356902794a4eec2122989e072271ef995968131145db918d9a3084ce582f244b";
const CLASS = "aarch64/4/2400";
const OTHER_CLASS = "x86_64/16/4200";
const NOW = 1_800_000_000;
const HOST = OMX_CLAP_HOST_PROFILE.id;

/** The measured record of the fixture plugin: suitable on omx-clap-host (an in-process pin verdict). */
function measured(): QualificationRecord {
  const text = fixtureText("success-msi");
  const r = readProbeOutput(text);
  if (!r.ok) throw new Error(r.problem);
  const dir = mkdtempSync(join(scratch, "rec-"));
  return writeQualification(dir, Buffer.from(text), judgeProbeOutput(r.output, [OMX_CLAP_HOST_PROFILE, OPENMIXER_CONSOLE_PROFILE])).record;
}

/** The same record with the omx-clap-host verdict replaced by hand: a conditional one, a refused one, ... */
function withVerdict(rating: string, reasons: { code: string; rating: string }[]): QualificationRecord {
  const r = measured();
  return {
    ...r,
    verdicts: r.verdicts.map((v) =>
      v.host === HOST
        ? { ...v, rating, qualified: rating === "suitable", reasons: reasons.map((x) => ({ dimension: "cost", params: {}, ...x })) as never }
        : v,
    ),
  };
}

const line = (keys: string, cls = CLASS, uri = URI, digest = DIGEST): string => `history ${uri} ${digest} ${cls} ${keys}`;
const file = (...lines: string[]): string => [HISTORY_HEADER, ...lines, ""].join("\n");
const adjust = (record: QualificationRecord, text: string, extra: { hostClass?: string } = {}) =>
  adjustRecords([{ path: "r.qualification.json", record }], text, { profiles: [OMX_CLAP_HOST_PROFILE], file: "history", now: NOW, ...extra });

function blockOf(record: QualificationRecord, text: string, cls = CLASS) {
  const r = adjust(record, text);
  if (!r.ok) throw new Error(r.problem);
  const block = r.records[0]!.record.history?.find((b) => b.hostClass === cls);
  if (block === undefined) throw new Error(`no block for ${cls}`);
  return block;
}

const STEADY = "windows_solo=400 cpu_p95_solo=1.00";
const SPIKY = [{ code: "hosting.cost.spiky-tail", rating: "conditional" }];

describe("the key of a record in the history", () => {
  it("is hostd's uri of the plugin and the digest of the first file of its pin", () => {
    expect(historyKeyOf(measured())).toEqual({ uri: URI, digest: DIGEST });
  });

  it("takes the first file by path, as the pin lists them", () => {
    const r = measured();
    const files = [
      { path: "z.so", sha256: "2".repeat(64) },
      { path: "a.so", sha256: "1".repeat(64) },
    ];
    expect(historyKeyOf({ ...r, binary: { ...r.binary, files } })?.digest).toBe("1".repeat(64));
    expect(historyKeyOf({ ...r, binary: { ...r.binary, files: [...files].reverse() } })?.digest).toBe("1".repeat(64));
  });

  it("is an LV2 plugin's own URI, and nothing for a record with no whole pin", () => {
    const r = measured();
    expect(historyKeyOf({ ...r, plugin: { format: "lv2", id: "urn:example:eq" } })?.uri).toBe("urn:example:eq");
    expect(historyKeyOf({ ...r, binary: { ...r.binary, files: [] } })).toBeUndefined();
    const { layout: _layout, ...noLayout } = r.binary;
    expect(historyKeyOf({ ...r, binary: noLayout })).toBeUndefined();
  });
});

describe("the second verdict beside the measured one", () => {
  it("demotes the in-process verdict after a crash and leaves the measured verdicts as they were", () => {
    const record = measured();
    const r = adjust(record, file(line("windows_solo=100 crashes_solo=1 last_crash=1799990000")));
    expect(r.ok).toBe(true);
    const out = r.ok ? r.records[0]!.record : undefined;
    expect(out?.verdicts).toEqual(record.verdicts);
    expect(out?.tiers).toEqual(record.tiers);
    expect(out?.history).toEqual([
      {
        hostClass: CLASS,
        file: "history",
        at: "2027-01-15T08:00:00.000Z",
        key: { uri: URI, digest: DIGEST },
        found: true,
        windows: { solo: 100, grouped: 0 },
        summary: { crashed: true, raisesXruns: false },
        verdicts: [{ host: HOST, measured: "in-process", adjusted: "isolated", move: "demote", reason: "history.crashed" }],
      },
    ]);
  });

  it("promotes a conditional verdict decided by a cost reason when the plugin ran steady alone", () => {
    const b = blockOf(withVerdict("conditional", SPIKY), file(line(STEADY)));
    expect(b.verdicts).toEqual([{ host: HOST, measured: "isolated", adjusted: "in-process", move: "promote", reason: "history.steady" }]);
    expect(b.windows).toEqual({ solo: 400, grouped: 0 });
  });

  it("refuses a plugin that crashed alone three times in thirty days", () => {
    const b = blockOf(withVerdict("conditional", SPIKY), file(line("windows_solo=50 crashes_solo=3 last_crash=1799000000")));
    expect(b.verdicts[0]).toMatchObject({ measured: "isolated", adjusted: "refused", move: "demote", reason: "history.crashed-alone" });
  });

  it("does not lift a real-time-safety verdict, a feature verdict or an unknown one, whatever the history", () => {
    const rt = blockOf(withVerdict("conditional", [{ code: "hosting.rt-safety.violations-in-run", rating: "conditional" }]), file(line(STEADY)));
    expect(rt.verdicts[0]).toMatchObject({ measured: "isolated", adjusted: "isolated", move: "none", reason: "history.not-liftable", blockedBy: ["hosting.rt-safety.violations-in-run"] });
    const feat = blockOf(withVerdict("conditional", [{ code: "hosting.features.missing", rating: "conditional" }]), file(line(STEADY)));
    expect(feat.verdicts[0]).toMatchObject({ adjusted: "isolated", reason: "history.not-liftable", blockedBy: ["hosting.features.missing"] });
    const unknown = blockOf(withVerdict("unknown", [{ code: "hosting.cost.unmeasured-at-rate-and-quantum", rating: "unknown" }]), file(line(STEADY)));
    expect(unknown.verdicts[0]).toMatchObject({ measured: null, adjusted: null, move: "none", reason: "history.not-liftable", blockedBy: ["unknown"] });
  });

  it("does not promote a refused verdict", () => {
    const b = blockOf(withVerdict("unsuitable", [{ code: "hosting.cost.above-ceiling", rating: "unsuitable" }]), file(line(STEADY)));
    expect(b.verdicts[0]).toMatchObject({ measured: "refused", adjusted: "refused", move: "none", reason: "history.not-liftable", blockedBy: ["refused"] });
  });

  it("keeps the measured verdict, with history.no-record, when the history has no line of this binary", () => {
    const b = blockOf(measured(), file(line("windows_solo=9", CLASS, URI, "f".repeat(64)), line("windows_solo=9", CLASS, "urn:other")), CLASS);
    expect(b).toMatchObject({ found: false, verdicts: [{ host: HOST, measured: "in-process", adjusted: "in-process", move: "none", reason: "history.no-record" }] });
    expect(b.windows).toBeUndefined();
  });

  it("gives a run that did not finish no pin verdict, whatever rating its row carries", () => {
    const r = measured();
    const row = { ...r.verdicts.find((v) => v.host === HOST)!, measured: false, rating: "suitable" };
    const b = blockOf({ ...r, verdicts: r.verdicts.map((v) => (v.host === HOST ? row : v)) }, file(line(STEADY)));
    expect(b.verdicts[0]).toMatchObject({ measured: null, adjusted: null, move: "none" });
  });

  it("keeps a key it does not know in the block", () => {
    const b = blockOf(measured(), file(line("windows_solo=9 future_key=7")));
    expect(b.unknownKeys).toEqual({ future_key: "7" });
  });

  it("writes one block per host class of the history, each judged by its own line, sorted by class", () => {
    const text = file(line("windows_solo=100 crashes_solo=1 last_crash=1799990000"), line("windows_solo=100", OTHER_CLASS));
    const r = adjust(measured(), text);
    expect(r.ok && r.hostClasses).toEqual([CLASS, OTHER_CLASS]);
    const history = r.ok ? r.records[0]!.record.history! : [];
    expect(history.map((b) => [b.hostClass, b.verdicts[0]!.adjusted])).toEqual([
      [CLASS, "isolated"],
      [OTHER_CLASS, "in-process"],
    ]);
  });

  it("reads only the class it is told, and keeps the block of a class it was not told", () => {
    const text = file(line("windows_solo=100 crashes_solo=1 last_crash=1799990000"), line("windows_solo=100", OTHER_CLASS));
    const first = adjust(measured(), text);
    if (!first.ok) throw new Error(first.problem);
    const second = adjust(first.records[0]!.record, text, { hostClass: OTHER_CLASS });
    expect(second.ok && second.hostClasses).toEqual([OTHER_CLASS]);
    expect(second.ok && second.records[0]!.record.history!.map((b) => b.hostClass)).toEqual([CLASS, OTHER_CLASS]);
    expect(second.ok && second.records[0]!.record.history![0]).toEqual(first.records[0]!.record.history![0]);
  });

  it("reads again to the same record: the block is replaced, not added to", () => {
    const text = file(line("windows_solo=100 crashes_solo=1 last_crash=1799990000"));
    const once = adjust(measured(), text);
    if (!once.ok) throw new Error(once.problem);
    const twice = adjust(once.records[0]!.record, text);
    expect(twice.ok && twice.records[0]!.record).toEqual(once.records[0]!.record);
  });

  it("refuses a history of a version it does not know, and one with no record to read a class from", () => {
    const v2 = adjust(measured(), "# plugin-hostd history/2\n");
    expect(!v2.ok && v2.problem).toMatch(/a version this reader does not know/);
    const empty = adjust(measured(), file());
    expect(!empty.ok && empty.problem).toMatch(/no host class/);
    expect(adjust(measured(), file(), { hostClass: CLASS }).ok).toBe(true);
  });

  it("reports the lines it did not read", () => {
    const r = adjust(measured(), file(line("windows_solo=-1"), line("windows_solo=3")));
    expect(r.ok && r.ignored).toHaveLength(1);
    expect(r.ok && r.ignored[0]!.line).toBe(2);
  });
});

describe("--pins with --history", () => {
  const record = (): QualificationRecord => measured();
  const text = file(line("windows_solo=100 crashes_solo=1 last_crash=1799990000"));

  it("writes the ADJUSTED verdict, where the measured one would have been in-process", () => {
    const measuredLine = pinsFile([{ uri: URI, integrity: { files: record().binary.files, layout: record().binary.layout! }, verdict: "in-process" }]).text;
    expect(measuredLine).toContain("verdict=in-process");
    const r = adjust(record(), text);
    if (!r.ok) throw new Error(r.problem);
    const pins = pinsFile(adjustedPinEntries(r.records, CLASS, HOST));
    expect(pins.written).toEqual([URI]);
    const pin = pins.text.split("\n").find((l) => l.startsWith("pin_set "))!;
    expect(pin).toBe(`pin_set ${URI} example-plate.clap=${DIGEST} omx-layout/1:0a3e01399262321514e05af0575ebb0b207a35567ac262a060fde655ee069805 verdict=isolated`);
    expect(parsePinLine(pin)).toMatchObject({ uri: URI, verdict: "isolated" });
  });

  it("writes a promoted verdict, a refused one, and no verdict word for an unknown one", () => {
    const pin = (rec: QualificationRecord, hist: string): string => {
      const r = adjust(rec, hist);
      if (!r.ok) throw new Error(r.problem);
      return pinsFile(adjustedPinEntries(r.records, CLASS, HOST)).text.split("\n").find((l) => l.startsWith("pin_set "))!;
    };
    expect(pin(withVerdict("conditional", SPIKY), file(line(STEADY)))).toMatch(/ verdict=in-process$/);
    expect(pin(withVerdict("conditional", SPIKY), file(line("crashes_solo=3 last_crash=1799990000")))).toMatch(/ verdict=refused$/);
    expect(pin(withVerdict("unknown", []), file(line(STEADY)))).toMatch(/ omx-layout\/1:[0-9a-f]{64}$/);
  });

  it("has no line for a record with no whole pin", () => {
    const r0 = record();
    const noPin: QualificationRecord = { ...r0, binary: { ...r0.binary, files: [] } };
    const r = adjust(noPin, text);
    if (!r.ok) throw new Error(r.problem);
    expect(adjustedPinEntries(r.records, CLASS, HOST)).toEqual([]);
  });
});

describe("parseAdjustArgs", () => {
  it("reads the history, the directory, the class, the pins, the clock, the profiles (once each) and the format", () => {
    expect(parseAdjustArgs(["--history", "h", "--qualification-dir", "q", "--host-class", CLASS, "--pins", "p", "--now", "5", "--host-profile", "omx-clap-host,jalv", "--host-profile", "jalv", "--format", "json"])).toEqual({
      ok: true,
      args: { history: "h", hostProfiles: ["omx-clap-host", "jalv"], qualificationDir: "q", hostClass: CLASS, pins: "p", now: 5, format: "json", help: false },
    });
    const d = parseAdjustArgs(["--history", "h"]);
    expect(d.ok && d.args).toMatchObject({ hostProfiles: ["openmixer-console"], format: "text" });
  });

  it("refuses a missing history, an unknown option, a missing value, a bad clock, a bad format and a positional", () => {
    expect(parseAdjustArgs([])).toEqual({ ok: false, error: "name the history file with --history" });
    expect(parseAdjustArgs(["--history", "h", "--nope"])).toEqual({ ok: false, error: "unknown option --nope" });
    expect(parseAdjustArgs(["--history"])).toEqual({ ok: false, error: "--history needs a value" });
    expect(parseAdjustArgs(["--history", "--pins"])).toEqual({ ok: false, error: "--history needs a value" });
    expect(parseAdjustArgs(["--history", "h", "--now", "-3"]).ok).toBe(false);
    expect(parseAdjustArgs(["--history", "h", "--now", "soon"]).ok).toBe(false);
    expect(parseAdjustArgs(["--history", "h", "--format", "xml"]).ok).toBe(false);
    expect(parseAdjustArgs(["--history", "h", "a.json"]).ok).toBe(false);
    expect(parseAdjustArgs(["--help"]).ok).toBe(true);
  });
});

describe("readRecords and the table", () => {
  it("reads the records of a directory, names a file that is not one, and prints a row per plugin, host and class", () => {
    const dir = mkdtempSync(join(scratch, "rr-"));
    rewriteRecord(join(dir, "a.qualification.json"), measured());
    writeFileSync(join(dir, "b.qualification.json"), "{}");
    writeFileSync(join(dir, "c.qualification.json"), "not json");
    writeFileSync(join(dir, "d.probe.json"), "{}");
    const r = readRecords(dir);
    expect(r.records.map((x: RecordFile) => x.path.replace(`${dir}/`, ""))).toEqual(["a.qualification.json"]);
    expect(r.failures.map((f) => f.file.replace(`${dir}/`, ""))).toEqual(["b.qualification.json", "c.qualification.json"]);
    expect(readRecords(join(dir, "none")).failures).toHaveLength(1);
    const a = adjust(measured(), file(line("windows_solo=9")));
    if (!a.ok) throw new Error(a.problem);
    expect(adjustTable(a.records)).toBe(
      ["plugin             host           host class      measured    adjusted    reason",
       `org.example.plate  omx-clap-host  ${CLASS}  in-process  in-process  history.no-change`, ""].join("\n"),
    );
  });
});
