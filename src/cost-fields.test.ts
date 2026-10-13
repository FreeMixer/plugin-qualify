// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The cost gate must never pass by absence. When the interchange document says
 * `nsPerSamplePercentile` and the classifier reads `nsPerSampleP95` / `coreFractionP95`,
 * `undefined > ceiling` is false, and every plugin passes the cost dimension.
 */
import { describe, it, expect } from "vitest";
import {
  COST_FIELDS,
  classifierCostFromDocument,
  coreFraction,
  costFieldsMissing,
} from "./cost-fields.js";
import { DEFAULT_HOSTING_POLICY, HOSTING_CODE, hostingCostReasons } from "./hosting-suitability.js";
import type { CostAtRate } from "./measurement/format.js";

const RATE = 96_000;
const policy = DEFAULT_HOSTING_POLICY;
const costOf = (perRate: Record<string, unknown>) => ({ cpuCost: { perRate } }) as never;

describe("the cost gate refuses a reading it cannot judge", () => {
  it("a document-named reading (nsPerSamplePercentile only) is unknown, never suitable", () => {
    const reading = { nsPerSampleMedian: 5400, nsPerSamplePercentile: 9000, blocks: 100, blockFrames: 128 };
    const r = hostingCostReasons(costOf({ [String(RATE)]: reading }), { rate: RATE }, policy);
    expect(r.map((x) => x.rating)).toEqual(["unknown"]);
    expect(r[0]!.code).toBe(HOSTING_CODE.costFieldsMissing);
  });

  it.each(["nsPerSampleMedian", "nsPerSampleP95", "coreFractionP95"])("a reading without %s is refused", (field) => {
    const full: Record<string, number> = { nsPerSampleMedian: 10, nsPerSampleP95: 12, coreFractionP95: 0.002 };
    delete full[field];
    const r = hostingCostReasons(costOf({ [String(RATE)]: full }), { rate: RATE }, policy);
    expect(r[0]!.code).toBe(HOSTING_CODE.costFieldsMissing);
    expect(r[0]!.rating).toBe("unknown");
  });

  it("a non-finite figure is refused like an absent one", () => {
    const bad = { nsPerSampleMedian: 10, nsPerSampleP95: Number.NaN, coreFractionP95: 0.002 };
    const r = hostingCostReasons(costOf({ [String(RATE)]: bad }), { rate: RATE }, policy);
    expect(r[0]!.code).toBe(HOSTING_CODE.costFieldsMissing);
  });

  it("the reasons name the missing fields", () => {
    const r = hostingCostReasons(costOf({ [String(RATE)]: { nsPerSampleMedian: 10 } }), { rate: RATE }, policy);
    expect(JSON.stringify(r[0])).toContain("coreFractionP95");
    expect(JSON.stringify(r[0])).toContain("nsPerSampleP95");
  });

  it("a complete reading is still judged on its value", () => {
    const ok = { nsPerSampleMedian: 10, nsPerSampleP95: 12, coreFractionP95: 0.002 };
    expect(hostingCostReasons(costOf({ [String(RATE)]: ok }), { rate: RATE }, policy)[0]!.rating).toBe("suitable");
    const hot = { ...ok, coreFractionP95: 0.9 };
    expect(hostingCostReasons(costOf({ [String(RATE)]: hot }), { rate: RATE }, policy)[0]!.rating).toBe("unsuitable");
  });
});

describe("one declaration joins the document's names to the classifier's", () => {
  const doc: CostAtRate = { nsPerSampleMedian: 5400, nsPerSamplePercentile: 6000, blocks: 100, blockFrames: 128 };

  it("COST_FIELDS names the document's percentile and the classifier's two figures", () => {
    expect(COST_FIELDS.document.percentile).toBe("nsPerSamplePercentile");
    expect(COST_FIELDS.classifier.percentile).toBe("nsPerSampleP95");
    expect(COST_FIELDS.classifier.coreFraction).toBe("coreFractionP95");
  });

  it("a converted document reading carries every field the gate needs and judges unsuitable when heavy", () => {
    // 6000 ns/sample at 192 kHz is 1.152 of a core: the Hex Chain amp's real cost class.
    const c = classifierCostFromDocument(doc, 192_000)!;
    expect(costFieldsMissing(c)).toEqual([]);
    expect(c.nsPerSampleP95).toBe(6000);
    expect(c.coreFractionP95).toBeCloseTo(1.152, 9);
    const r = hostingCostReasons(costOf({ "192000": c }), { rate: 192_000 }, policy);
    expect(r[0]!.code).toBe(HOSTING_CODE.costAboveCeiling);
  });

  it("an unusable rate or figure yields no reading, not a cheap one", () => {
    expect(classifierCostFromDocument(doc, 0)).toBeUndefined();
    expect(classifierCostFromDocument({ ...doc, nsPerSamplePercentile: Number.NaN }, 48_000)).toBeUndefined();
    expect(coreFraction(1, -1)).toBeUndefined();
  });
});
