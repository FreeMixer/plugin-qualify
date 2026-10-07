// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The format's contract with everyone who will ever read it.
 *
 * Three properties are defended here and nothing else belongs in this file:
 *
 * 1. **Round trip.** What is written is what is read — including the maximal document, so a
 *    field cannot be quietly dropped by the reader and go unnoticed until a consumer needs it.
 * 2. **Version detection.** A future major is REFUSED (a reader that half-understands a
 *    document is worse than one that declines it); a future minor is read and flagged.
 * 3. **Unknown stays unknown.** An absent field survives as absent, a malformed figure is
 *    dropped rather than defaulted, and the count of what was dropped is reported.
 */
import { describe, expect, it } from "vitest";

import {
  buildMeasurementDocument,
  MEASUREMENT_FORMAT_ID,
  MEASUREMENT_FORMAT_MAJOR,
  MEASUREMENT_FORMAT_VERSION,
  parseFormatVersion,
  readMeasurementDocument,
  serialiseMeasurementDocument,
} from "./format.js";
import { fixtureDocument, fixturePlugin, fixtureRun, fixtureUnmeasurable } from "./fixtures.js";
import { UNMEASURED_TERMS, unmeasuredKind } from "./vocabulary.js";

describe("format version", () => {
  it("parses a two-part version and nothing else", () => {
    expect(parseFormatVersion("1.0")).toEqual({ major: 1, minor: 0 });
    expect(parseFormatVersion("12.34")).toEqual({ major: 12, minor: 34 });
    expect(parseFormatVersion("1")).toBeUndefined();
    expect(parseFormatVersion("1.0.0")).toBeUndefined();
    expect(parseFormatVersion("v1.0")).toBeUndefined();
    expect(parseFormatVersion(1.0)).toBeUndefined();
    expect(parseFormatVersion("")).toBeUndefined();
  });

  it("stamps its own version on every document it builds", () => {
    const document = buildMeasurementDocument(fixtureRun(), []);
    expect(document.format).toBe(MEASUREMENT_FORMAT_ID);
    expect(document.formatVersion).toBe(MEASUREMENT_FORMAT_VERSION);
  });
});

describe("round trip", () => {
  it("survives JSON serialisation with every optional field populated", () => {
    const original = fixtureDocument();
    const parsed: unknown = JSON.parse(serialiseMeasurementDocument(original));
    const result = readMeasurementDocument(parsed);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document).toEqual(original);
    expect(result.droppedPlugins).toBe(0);
    expect(result.forwardMinor).toBeUndefined();
  });

  it("keeps an unmeasurable plugin's reason and gives it no figures", () => {
    const original = fixtureDocument([fixtureUnmeasurable("urn:x42:phasewheel")]);
    const result = readMeasurementDocument(JSON.parse(serialiseMeasurementDocument(original)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plugin = result.document.plugins[0];
    expect(plugin?.latency?.perRate).toEqual({});
    expect(plugin?.latency?.unmeasuredReason).toBe("no-audio-out");
    expect(plugin?.cost?.perRate).toEqual({});
  });

  it("sorts plugins by URI so two runs on one host produce a diffable file", () => {
    const document = buildMeasurementDocument(fixtureRun(), [
      fixturePlugin("urn:z"),
      fixturePlugin("urn:a"),
      fixturePlugin("urn:m"),
    ]);
    expect(document.plugins.map((p) => p.uri)).toEqual(["urn:a", "urn:m", "urn:z"]);
  });

  it("ends the serialised form with a newline", () => {
    expect(serialiseMeasurementDocument(fixtureDocument()).endsWith("}\n")).toBe(true);
  });
});

describe("reading an untrusted document", () => {
  it("refuses anything that is not an object", () => {
    for (const value of [null, 42, "text", [], undefined]) {
      const result = readMeasurementDocument(value);
      expect(result.ok).toBe(false);
    }
  });

  it("refuses a document that is not ours", () => {
    const result = readMeasurementDocument({ format: "some-other-thing", formatVersion: "1.0" });
    expect(result).toMatchObject({ ok: false, problem: "wrong-format", found: "some-other-thing" });
  });

  it("refuses an unparseable version rather than assuming ours", () => {
    const document = { ...fixtureDocument(), formatVersion: "1" };
    expect(readMeasurementDocument(document)).toMatchObject({ ok: false, problem: "bad-version" });
  });

  it("REFUSES a future major — a half-understood document is worse than none", () => {
    const document = { ...fixtureDocument(), formatVersion: `${MEASUREMENT_FORMAT_MAJOR + 1}.0` };
    const result = readMeasurementDocument(document);
    expect(result).toMatchObject({ ok: false, problem: "future-major" });
  });

  it("reads a future MINOR and says it did", () => {
    const document = {
      ...fixtureDocument(),
      formatVersion: `${MEASUREMENT_FORMAT_MAJOR}.99`,
      plugins: [{ ...fixturePlugin("urn:a"), somethingNewer: { nested: true } }],
    };
    const result = readMeasurementDocument(document);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.forwardMinor).toBe(true);
    expect(result.document.plugins).toHaveLength(1);
    // The unknown field is dropped, never round-tripped: a consumer must not be able to
    // start depending on a field this build does not understand.
    expect(Object.keys(result.document.plugins[0] ?? {})).not.toContain("somethingNewer");
  });

  it("refuses a document with no run — provenance is not optional", () => {
    const { run: _run, ...rest } = fixtureDocument();
    expect(readMeasurementDocument(rest)).toMatchObject({ ok: false, problem: "missing-run" });
  });

  it("refuses a run whose host omits the privilege facts", () => {
    const document = fixtureDocument();
    const { realtimePriority: _rt, ...host } = document.run.host;
    const broken = { ...document, run: { ...document.run, host } };
    expect(readMeasurementDocument(broken)).toMatchObject({ ok: false, problem: "missing-run" });
  });

  it("drops malformed plugin entries and reports how many", () => {
    const document = {
      ...fixtureDocument(),
      plugins: [fixturePlugin("urn:good"), { uri: "urn:no-topology" }, null, 7],
    };
    const result = readMeasurementDocument(document);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.plugins.map((p) => p.uri)).toEqual(["urn:good"]);
    expect(result.droppedPlugins).toBe(3);
  });

  it("drops a rate key that is not a rate", () => {
    const document = {
      ...fixtureDocument(),
      plugins: [
        {
          ...fixturePlugin("urn:a"),
          latency: { perRate: { "48000": { frames: 64, ms: 1.33 }, default: { frames: 1, ms: 1 } } },
        },
      ],
    };
    const result = readMeasurementDocument(document);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.document.plugins[0]?.latency?.perRate ?? {})).toEqual(["48000"]);
  });

  it("drops a reading missing a required figure rather than defaulting it to zero", () => {
    const document = {
      ...fixtureDocument(),
      plugins: [
        {
          ...fixturePlugin("urn:a"),
          cost: { perRate: { "48000": { nsPerSampleMedian: 5, blocks: 512, blockFrames: 512 } } },
        },
      ],
    };
    const result = readMeasurementDocument(document);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.plugins[0]?.cost?.perRate).toEqual({});
  });

  it("normalises rate order so two documents compare equal", () => {
    const document = { ...fixtureDocument(), run: { ...fixtureRun(), rates: [96000, 44100, 48000] } };
    const result = readMeasurementDocument(document);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.run.rates).toEqual([44100, 48000, 96000]);
  });
});

describe("the unmeasured vocabulary", () => {
  it("has no duplicate codes", () => {
    const codes = UNMEASURED_TERMS.map((t) => t.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("treats an unknown reason as a probe failure, never as a plugin property", () => {
    // The conservative direction: an unrecognised word must not be allowed to claim the
    // plugin has nothing to measure, because that claim deletes other people's figures.
    expect(unmeasuredKind("something-nobody-has-defined")).toBe("probe-failed");
    expect(unmeasuredKind(undefined)).toBe("not-attempted");
    expect(unmeasuredKind("no-audio-in")).toBe("nothing-to-measure");
    expect(unmeasuredKind("probe-crashed")).toBe("probe-failed");
  });
});

describe("v1.2 — verdicts per host profile (§3b)", () => {
  const profile = {
    id: "jalv",
    lv2Features: ["http://lv2plug.in/ns/ext/urid#map"],
    clapExtensions: null,
    instruments: true,
    cost: { coreFractionCeiling: 0.25, rate: 48000, quantum: 256 },
    latency: "uncompensated" as const,
    isolation: "per-process" as const,
  };

  it("a verdict naming a host the document does not declare is dropped and counted, never read", () => {
    const doc = buildMeasurementDocument(fixtureRun(), [fixturePlugin("urn:a")], {
      hostProfiles: [profile],
      verdicts: [
        { uri: "urn:a", host: "jalv", rating: "unknown", qualified: false, deciding: "hosting.stability.unsoaked" },
        { uri: "urn:a", host: "mod-host", rating: "suitable", qualified: true },
      ],
    });
    const r = readMeasurementDocument(JSON.parse(serialiseMeasurementDocument(doc)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.document.verdicts).toEqual([doc.verdicts![0]]);
    expect(r.droppedVerdicts).toBe(1);
  });

  it("a verdict whose qualified disagrees with its rating is malformed", () => {
    const doc = buildMeasurementDocument(fixtureRun(), [], {
      hostProfiles: [profile],
      verdicts: [{ uri: "urn:a", host: "jalv", rating: "unknown", qualified: true }],
    });
    const r = readMeasurementDocument(JSON.parse(serialiseMeasurementDocument(doc)));
    expect(r.ok && r.document.verdicts).toEqual([]);
  });

  it("a document with no verdicts has neither field — the v1.1 shape, stamped 1.2", () => {
    const doc = buildMeasurementDocument(fixtureRun(), []);
    expect("verdicts" in doc).toBe(false);
    expect("hostProfiles" in doc).toBe(false);
    expect(doc.formatVersion).toBe("1.2");
  });
});
