// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * A plugin's memory against a host's budget: the arithmetic, the verdict's reasons, the soak's growth rule, and the
 * two Pi profiles. A missing figure never reads as fitting, and a number not measured on that kind of host is said to be so.
 */
import { describe, expect, it } from "vitest";

import { HOSTING_CODE } from "./hosting-codes.js";
import { OMX_CLAP_HOST_PROFILE, OPENMIXER_CONSOLE_PROFILE, PI_4GB_PROFILE, PI_8GB_PROFILE, readHostProfile, type HostProfile } from "./host-profiles.js";
import { DEFAULT_HOSTING_POLICY, hostingMemoryReasons, soakFindings, stabilityReasons } from "./hosting-suitability.js";
import { firstInstanceKb, memoryWithinBudget, perInstanceKb } from "./memory-budget.js";
import { HOST_BUDGETS } from "./qualify-declarations.js";
import { judgeProbeOutput } from "./probe-judge.js";
import { fixtureJson } from "./probe-output-fixtures.js";
import { readProbeOutput } from "./probe-output.js";
import type { MemoryFootprint, SoakReading } from "./measurement/format.js";

const MIB = 1024;
const GIB = 1024 * MIB;
const BUDGET = { perInstanceKb: 100 * MIB, perConsoleKb: 1 * GIB };
const fx = (kb: number, second = kb): MemoryFootprint => ({ afterInstantiateKb: kb / 2, afterActivateKb: kb, atRestKb: kb, secondInstanceKb: second });

describe("what a footprint comes to", () => {
  it("the first instance is the most it held at any step; one more is the second's own part and the voices", () => {
    const f = { afterInstantiateKb: 10, afterActivateKb: 500, atRestKb: 200, notesHeldKb: 800, secondInstanceKb: 30 };
    expect(firstInstanceKb(f)).toBe(800);
    expect(perInstanceKb(f)).toBe(30 + (800 - 200));
  });

  it("with no second instance measured, nothing separates what is shared: the whole figure", () => {
    expect(perInstanceKb({ afterActivateKb: 500 })).toBe(500);
  });
});

describe("memoryWithinBudget", () => {
  it("a missing figure is unmeasured, never a fit", () => {
    expect(memoryWithinBudget(undefined, BUDGET).outcome).toBe("unmeasured");
    expect(memoryWithinBudget({}, BUDGET).outcome).toBe("unmeasured");
    expect(memoryWithinBudget({ unmeasuredReason: "probe-crashed" }, BUDGET)).toEqual({ outcome: "unmeasured", unmeasuredReason: "probe-crashed" });
  });

  it("a figure beside a reason is not a fit either, and one already above stays above", () => {
    expect(memoryWithinBudget({ ...fx(MIB), unmeasuredReason: "voices-unknown" }, BUDGET).outcome).toBe("unmeasured");
    expect(memoryWithinBudget({ ...fx(200 * MIB), unmeasuredReason: "voices-unknown" }, BUDGET).outcome).toBe("above");
  });

  it("one instance past its share is above; a large library shared between instances is judged once, against the console", () => {
    expect(memoryWithinBudget(fx(200 * MIB), BUDGET)).toMatchObject({ outcome: "above", figure: "perInstance", kb: 200 * MIB, ceilingKb: 100 * MIB });
    expect(memoryWithinBudget(fx(500 * MIB, MIB), BUDGET)).toMatchObject({ outcome: "within", perInstanceKb: MIB, firstInstanceKb: 500 * MIB });
    expect(memoryWithinBudget(fx(2 * GIB, MIB), BUDGET)).toMatchObject({ outcome: "above", figure: "firstInstance", ceilingKb: GIB });
  });
});

describe("the verdict's reasons", () => {
  const desk: HostProfile = OPENMIXER_CONSOLE_PROFILE;
  const at = (f: MemoryFootprint, p: HostProfile) => ({ perRateQuantum: Object.fromEntries((p.cost.memory?.cells ?? [p.cost]).map((c) => [`${String(c.rate)}/${String(c.quantum)}`, f])) });

  it("a host with no budget declared reads nothing", () => {
    expect(hostingMemoryReasons(undefined, OMX_CLAP_HOST_PROFILE)).toEqual([]);
  });

  it("a measured budget that holds is suitable, and says within-ceiling", () => {
    expect(hostingMemoryReasons(at(fx(MIB), desk), desk)).toMatchObject([{ dimension: "memory", rating: "suitable", code: HOSTING_CODE.memoryWithinCeiling }]);
  });

  it("no figure at the host's cell is unknown, whatever another cell holds", () => {
    expect(hostingMemoryReasons({ perRateQuantum: { "48000/128": fx(MIB) } }, desk)).toMatchObject([{ rating: "unknown", code: HOSTING_CODE.memoryUnmeasured, params: { rate: desk.cost.rate, quantum: desk.cost.quantum } }]);
  });

  it("every cell a Pi runs is read: one missing is unknown, one above is above, each naming its cell", () => {
    const [low, high] = PI_8GB_PROFILE.cost.memory!.cells!;
    const key = (c: { rate: number; quantum: number }) => `${String(c.rate)}/${String(c.quantum)}`;
    expect(hostingMemoryReasons({ perRateQuantum: { [key(low!)]: fx(MIB) } }, PI_8GB_PROFILE)).toMatchObject([{ rating: "unknown", params: { quantum: high!.quantum } }]);
    expect(hostingMemoryReasons({ perRateQuantum: { [key(low!)]: fx(MIB), [key(high!)]: fx(2 * GIB) } }, PI_8GB_PROFILE)).toMatchObject([
      { rating: "unsuitable", code: HOSTING_CODE.memoryAboveCeiling, params: { quantum: high!.quantum } },
    ]);
  });

  it("under a provisional budget a plugin that fits is conditional, with a code of its own: it never says it fits", () => {
    const r = hostingMemoryReasons(at(fx(MIB), PI_4GB_PROFILE), PI_4GB_PROFILE);
    expect(r).toMatchObject([{ rating: "conditional", code: HOSTING_CODE.memoryWithinProvisionalCeiling, params: { provisional: "yes" } }]);
    expect(r[0]!.code).not.toBe(HOSTING_CODE.memoryWithinCeiling);
  });

  it("above a provisional ceiling is unsuitable and says the ceiling is provisional", () => {
    expect(hostingMemoryReasons(at(fx(GIB), PI_4GB_PROFILE), PI_4GB_PROFILE)).toMatchObject([{ rating: "unsuitable", code: HOSTING_CODE.memoryAboveCeiling, params: { provisional: "yes" } }]);
  });
});

describe("a verdict is the host's: the same plugin on the desk and on a Pi", () => {
  /** A probe output holding this footprint at every cell any of these hosts runs. */
  function output(f: MemoryFootprint | undefined, profiles: readonly HostProfile[]) {
    const d = fixtureJson("success-msi");
    const point = d.grid[0];
    delete point.cost.samples;
    // an LV2 plugin: its verdict reads the counts, with no list of CLAP extensions to match
    d.plugin = { format: "lv2", id: "urn:plugin-qualify:test:memory", version: "1" };
    const cells = [...new Map(profiles.flatMap((p) => p.cost.memory?.cells ?? [p.cost]).map((c) => [`${String(c.rate)}/${String(c.quantum)}`, c])).values()];
    d.grid = cells.map((c) => ({ ...structuredClone(point), rate: c.rate, quantum: c.quantum, ...(f === undefined ? {} : { memory: f }) }));
    const r = readProbeOutput(JSON.stringify(d));
    if (!r.ok) throw new Error(r.problem);
    return r.output;
  }
  const hosts = [OPENMIXER_CONSOLE_PROFILE, PI_4GB_PROFILE, PI_8GB_PROFILE];
  const verdicts = (f: MemoryFootprint | undefined) =>
    Object.fromEntries(judgeProbeOutput(output(f, hosts), hosts).hosts.map((h) => [h.verdict.host, { rating: h.verdict.rating, deciding: h.verdict.deciding }]));

  it("1 GiB an instance fits the desk and neither Pi", () => {
    const v = verdicts(fx(GIB));
    expect(v["openmixer-console"]!.rating).toBe("suitable");
    expect(v["openmixer-pi-4gb"]).toEqual({ rating: "unsuitable", deciding: HOSTING_CODE.memoryAboveCeiling });
    expect(v["openmixer-pi-8gb"]).toEqual({ rating: "unsuitable", deciding: HOSTING_CODE.memoryAboveCeiling });
  });

  it("512 MiB an instance is above a 4 GB Pi's share and under an 8 GB Pi's, which says so and does not say it fits", () => {
    const v = verdicts(fx(512 * MIB));
    expect(v["openmixer-pi-4gb"]!.rating).toBe("unsuitable");
    expect(v["openmixer-pi-8gb"]).toEqual({ rating: "conditional", deciding: HOSTING_CODE.memoryWithinProvisionalCeiling });
  });

  it("a run that took no footprint is unknown on every host with a budget", () => {
    const v = verdicts(undefined);
    for (const host of hosts) expect(v[host.id]).toEqual({ rating: "unknown", deciding: HOSTING_CODE.memoryUnmeasured });
  });
});

describe("the Pi profiles state what a Pi runs and what is not measured", () => {
  it("48000/128 and 48000/256, zynthian-sys's settings: a Pi profile is judged at both, and cost is read at the first", () => {
    for (const p of [PI_4GB_PROFILE, PI_8GB_PROFILE]) {
      expect(p.cost.memory!.cells).toEqual([{ rate: 48000, quantum: 128 }, { rate: 48000, quantum: 256 }]);
      expect({ rate: p.cost.rate, quantum: p.cost.quantum }).toEqual(p.cost.memory!.cells![0]);
    }
  });

  it("their ceilings are provisional, the desk's is not, and a host without a budget has none", () => {
    expect(PI_4GB_PROFILE.cost.memory!.provisional).toBe(true);
    expect(PI_8GB_PROFILE.cost.memory!.provisional).toBe(true);
    expect(OPENMIXER_CONSOLE_PROFILE.cost.memory!.provisional).toBeUndefined();
    expect(OMX_CLAP_HOST_PROFILE.cost.memory).toBeUndefined();
  });

  it("a board's share grows with its RAM, and the profile document round-trips the budget", () => {
    expect(HOST_BUDGETS["openmixer-pi-8gb"].memory.perInstanceKb).toBeGreaterThan(HOST_BUDGETS["openmixer-pi-4gb"].memory.perInstanceKb);
    const read = readHostProfile(JSON.parse(JSON.stringify(PI_4GB_PROFILE)));
    expect(read).toMatchObject({ ok: true, profile: { cost: { memory: PI_4GB_PROFILE.cost.memory } } });
    const broken = JSON.parse(JSON.stringify(PI_4GB_PROFILE));
    broken.cost.memory.perInstanceKb = 0;
    expect(readHostProfile(broken)).toMatchObject({ ok: false });
  });
});

describe("the soak's growth rule", () => {
  const RATE = 48000;
  const soak = (over: Record<string, number>): SoakReading => ({
    sweptParams: true,
    perRate: {
      [String(RATE)]: { instantiated: true, seconds: 600, windows: 600, nonFiniteWindows: 0, silentWindows: 0, firstRmsDbfs: -20, lastRmsDbfs: -20, rssStartKb: 1000, rssMaxKb: 1000, rssGrowthKb: 0, rssAfterWarmupKb: 1000, warmupSeconds: 2, rssMidKb: 1000, midSeconds: 301, ...over },
    },
  });
  const failed = (s: SoakReading) => soakFindings(s, DEFAULT_HOSTING_POLICY)!.failed;

  it("10 MB/min, provisional, is the ceiling that ships", () => {
    expect(DEFAULT_HOSTING_POLICY.memoryGrowthKbPerMinCeiling).toBe(10 * MIB);
    expect(DEFAULT_HOSTING_POLICY.memoryGrowthCeilingProvisional).toBe(true);
  });

  it("flat is not a leak; growth still climbing past the ceiling is, measured from the second half", () => {
    expect(failed(soak({}))).toEqual([]);
    const climbing = 11 * MIB * (299 / 60); // 11 MB/min over the second half
    expect(failed(soak({ rssMidKb: 1000, rssMaxKb: 1000 + climbing })).map((f) => f.kind)).toEqual(["leaks"]);
    expect(failed(soak({ rssMidKb: 1000, rssMaxKb: 1000 + 9 * MIB * (299 / 60) }))).toEqual([]);
  });

  it("a large load that finished before the second half is not a leak: it is what warm-up and the footprint read", () => {
    expect(failed(soak({ rssAfterWarmupKb: 1000, rssMidKb: 500 * MIB, rssMaxKb: 500 * MIB }))).toEqual([]);
  });

  it("a soak that never reached the readings says nothing about growth, and is no leak", () => {
    expect(failed({ sweptParams: true, perRate: { [String(RATE)]: { instantiated: true, seconds: 1, windows: 1, nonFiniteWindows: 0, silentWindows: 0, firstRmsDbfs: -20, lastRmsDbfs: -20 } } })).toEqual([]);
  });

  it("through the existing code: the failure at the judged rate is the plugin's verdict there, naming the figure and that the ceiling is provisional", () => {
    const r = stabilityReasons(
      { lifecycle: { cycles: 1000, instantiated: 1000, failed: 0 }, threads: { before: 1, afterFirstInstantiate: 1, afterAllFreed: 1, leaked: 0 }, crashes: [], soak: soak({ rssMaxKb: 1000 + 20 * MIB * (299 / 60) }) } as never,
      DEFAULT_HOSTING_POLICY,
      undefined,
      true,
      RATE,
    );
    expect(r.find((x) => x.code === HOSTING_CODE.stabilitySoakFailedAtRate)).toMatchObject({
      rating: "unsuitable",
      params: { failure: "leaks", rate: RATE, ceilingKbPerMin: 10 * MIB, provisional: "yes", growthKbPerMin: expect.any(Number) },
    });
  });
});
