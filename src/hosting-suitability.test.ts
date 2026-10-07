// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The named oracle for increment 1 of the LV2 hosting-path spec: one assertion per cell of
 * the §3 verdict table, BY VALUE.
 *
 * The property that matters most is not that a good plugin passes — it is that everything
 * else fails closed. A hosting verdict decides whether a plugin runs on the thread the whole
 * desk's audio runs on, so absence of evidence must never read as evidence of safety. Most of
 * this file is therefore about what does NOT earn `in-process`.
 */
import { describe, it, expect } from "vitest";
import type { QualifiedPlugin as PluginDescriptor } from "./hosting-suitability.js";
import {
  CLAP_FEATURE_AUDIO_EFFECT,
  DEFAULT_HOSTING_POLICY,
  HOSTING_CODE,
  OMX_INPROCESS_FEATURES,
  assertHostingOverride,
  attributeCrash,
  classifyPluginHosting,
  contributedHostingRating,
  isClapPlugin,
  isClapUri,
  realisedHosting,
  rtSafetyMeasured,
  soakFindings,
  type HostingClassifyOptions,
  type PluginClapMeasurement,
  type PluginLv2Features,
  type PluginRtSafetyMeasurement,
  type PluginStabilityMeasurement,
} from "./hosting-suitability.js";
import type { SoakAtRate, SoakReading } from "./measurement/format.js";
import { JALV_PROFILE, MOD_HOST_PROFILE, OPENMIXER_CONSOLE_PROFILE } from "./host-profiles.js";
import { HOST_BUDGETS } from "./qualify-declarations.js";

/** The console's per-instance ceiling, read from the declaration it lives in. */
const DEFAULT_HOSTING_POLICY_CEILING = HOST_BUDGETS["openmixer-console"].coreFractionCeiling;

/** The desk's rate since the operator's 2026-09-14 ruling. The classifier is rate-agnostic —
 *  it reads the figure at the rate it is GIVEN — so this is the fixture's own parameter and
 *  never a rate any code knows; what it must be is the rate the console actually runs. */
const RATE = 96_000;

/** A descriptor that passes every dimension the descriptor itself owns. */
function descriptor(over: Partial<PluginDescriptor> = {}): PluginDescriptor {
  return {
    uri: "urn:test:pad",
    name: "Test Pad",
    lv2Class: "http://lv2plug.in/ns/lv2core#UtilityPlugin",
    audioInputs: 1,
    audioOutputs: 1,
    hasMidiIn: false,
    params: [],
    latency: { measuredFrames: 0, measuredMs: 0, sampleRate: RATE },
    cpuCost: {
      perRate: {
        [String(RATE)]: {
          nsPerSampleMedian: 10,
          nsPerSampleP95: 12,
          coreFractionMedian: 0.001,
          coreFractionP95: 0.002,
          blocks: 512,
          warmupBlocks: 64,
          blockFrames: 512,
        },
      },
    },
    ...over,
  } as PluginDescriptor;
}

/** The three measured blocks, each overridable whole or in part. */
interface Blocks {
  readonly stability?: Partial<PluginStabilityMeasurement>;
  readonly rtSafety?: Partial<PluginRtSafetyMeasurement>;
  readonly lv2Features?: Partial<PluginLv2Features>;
}

/** One clean soak rate: three hours, alive, finite, never silent, settled where it opened. */
const CLEAN_SOAK_RATE: SoakAtRate = {
  instantiated: true,
  seconds: DEFAULT_HOSTING_POLICY.soakSeconds,
  windows: 10_000,
  nonFiniteWindows: 0,
  silentWindows: 0,
  firstRmsDbfs: -30,
  lastRmsDbfs: -30,
  rssGrowthKb: 0,
};

/** A soak clean at all four rates, controls swept — what the sweep wrote for a plugin that held. */
function cleanSoak(perRate: Record<string, SoakAtRate> = {}): SoakReading {
  return {
    sweptParams: true,
    perRate: {
      "44100": CLEAN_SOAK_RATE,
      "48000": CLEAN_SOAK_RATE,
      "96000": CLEAN_SOAK_RATE,
      "192000": CLEAN_SOAK_RATE,
      ...perRate,
    },
  };
}

/** Measurements that clear every dimension the catalog must grow — RAW, as the sweep lands them. */
function cleanMeasurements(over: Blocks = {}): Required<Pick<PluginDescriptor, "stability" | "rtSafety" | "lv2Features">> {
  return {
    stability: {
      lifecycle: { cycles: DEFAULT_HOSTING_POLICY.cycleFloor, instantiated: DEFAULT_HOSTING_POLICY.cycleFloor, failed: 0 },
      threads: { before: 1, afterFirstInstantiate: 1, afterAllFreed: 1, leaked: 0 },
      crashes: [],
      soak: cleanSoak(),
      linksGuiToolkit: false,
      ...over.stability,
    },
    rtSafety: {
      rate: 192_000,
      blockFrames: 512,
      blocks: 512,
      interposer: true,
      swept: true,
      sweepApplicable: true,
      allocationsInRun: 0,
      syscallsInRun: 0,
      locksInRun: 0,
      ...over.rtSafety,
    },
    lv2Features: { required: [], optional: [], cvPorts: 0, ...over.lv2Features },
  };
}

/** A descriptor carrying `blocks` (clean by default) — the ONLY way a verdict is given evidence. */
function measured(over: Partial<PluginDescriptor> = {}, blocks: Blocks = {}): PluginDescriptor {
  return descriptor({ ...cleanMeasurements(blocks), ...over });
}

function classify(
  d: PluginDescriptor = measured(),
  o: Partial<HostingClassifyOptions> = {},
): ReturnType<typeof classifyPluginHosting> {
  return classifyPluginHosting(d, { rate: RATE, ...o });
}

describe("a fully measured, clean plugin earns the RT thread", () => {
  it("rates suitable and takes the in-process path", () => {
    const v = classify();
    expect(v.rating).toBe("suitable");
    expect(v.path).toBe("in-process");
    // Every dimension reported, passes included: a surface that shows only failures cannot
    // show an operator WHY something is trusted.
    expect(new Set(v.reasons.map((r) => r.dimension))).toEqual(
      new Set(["stability", "rtSafety", "features", "cost", "latency", "topology"]),
    );
  });
});

describe("absence is never a pass — every unmeasured dimension isolates", () => {
  it("no measurements at all reads unknown, not suitable", () => {
    const v = classifyPluginHosting(descriptor(), { rate: RATE });
    expect(v.rating).toBe("unknown");
    expect(v.path).toBe("isolated");
  });

  const holes: ReadonlyArray<readonly [string, Partial<PluginDescriptor>, string]> = [
    ["stability unmeasured", { rtSafety: cleanMeasurements().rtSafety, lv2Features: {} }, HOSTING_CODE.stabilityUnmeasured],
    ["rt-safety unmeasured", { stability: cleanMeasurements().stability, lv2Features: {} }, HOSTING_CODE.rtSafetyUnmeasured],
  ];
  for (const [label, blocks, code] of holes) {
    it(`${label} isolates and says so`, () => {
      const v = classifyPluginHosting(descriptor(blocks), { rate: RATE });
      expect(v.path).toBe("isolated");
      expect(v.reasons.map((r) => r.code)).toContain(code);
    });
  }

  it("a stability block with no lifecycle is unmeasured — a reason is not a reading", () => {
    const { lifecycle: _gone, ...noLifecycle } = cleanMeasurements().stability;
    const v = classify(descriptor({ ...cleanMeasurements(), stability: noLifecycle }));
    expect(v.rating).toBe("unknown");
    expect(v.reasons.map((r) => r.code)).toContain(HOSTING_CODE.stabilityUnmeasured);
  });

  it("rt-safety measured at REST rather than under a sweep is not measured", () => {
    const v = classify(measured({}, { rtSafety: { swept: false, sweepApplicable: true } }));
    expect(v.rating).toBe("unknown");
    expect(v.reasons.map((r) => r.code)).toContain(HOSTING_CODE.rtSafetyUnmeasured);
  });

  it("…unless the plugin has no control a sweep could move: its at-rest count is all there is", () => {
    const v = classify(measured({}, { rtSafety: { swept: false, sweepApplicable: false } }));
    expect(v.rating).toBe("suitable");
  });

  it("a zero from an interposer that was never loaded counts nothing", () => {
    const v = classify(measured({}, { rtSafety: { interposer: false } }));
    expect(v.rating).toBe("unknown");
    expect(rtSafetyMeasured(cleanMeasurements({ rtSafety: { interposer: false } }).rtSafety)).toBe(false);
  });

  it("no latency figure at all is unknown, never a pass — the fixture that hid this now has one", () => {
    const { latency: _omitted, ...bare } = measured();
    const v = classify(bare as PluginDescriptor);
    expect(v.rating).toBe("unknown");
    expect(v.reasons.map((r) => r.code)).toContain(HOSTING_CODE.latencyUnmeasured);
  });

  it("a latency the benchmark called unmeasurable is unknown", () => {
    const v = classify(measured({ latency: { unmeasurable: "no round trip" } } as Partial<PluginDescriptor>));
    expect(v.rating).toBe("unknown");
  });

  it("rt-safety that disagreed between repeats is not reproducible, so unknown", () => {
    const v = classify(measured({}, { rtSafety: { variable: true } }));
    expect(v.rating).toBe("unknown");
    expect(v.reasons.map((r) => r.code)).toContain(HOSTING_CODE.rtSafetyNotReproducible);
  });

  it("cost measured at another rate is no cost figure at THIS rate", () => {
    const v = classify(measured(), { rate: 48_000 });
    expect(v.rating).toBe("unknown");
    expect(v.reasons.map((r) => r.code)).toContain(HOSTING_CODE.costUnmeasured);
  });
});

describe("the disqualifiers", () => {
  it("one allocation inside run() is unsuitable, not a caution", () => {
    const v = classify(measured({}, { rtSafety: { allocationsInRun: 1 } }));
    expect(v.rating).toBe("unsuitable");
    expect(v.deciding?.code).toBe(HOSTING_CODE.rtSafetyViolations);
  });

  it("a crash attributed to the PLUGIN is unsuitable", () => {
    const v = classify(measured({}, { stability: { crashes: [{ topFrame: "lilv_instance_instantiate" }] } }));
    expect(v.rating).toBe("unsuitable");
  });

  it("a crash attributed to the HOST does not condemn the plugin", () => {
    // The pipewire-jack double free is ours, not the plugin's. Blaming the plugin for it
    // would have demoted every multi-port plugin on the rig.
    const v = classify(measured({}, { stability: { crashes: [{ topFrame: "pw_memmap_free", signal: "SIGSEGV" }] } }));
    expect(v.rating).toBe("suitable");
  });

  it("an unrecognised crash is unknown, never blame", () => {
    const v = classify(measured({}, { stability: { crashes: [{ topFrame: "some_frame_we_have_never_seen" }] } }));
    expect(v.rating).toBe("unknown");
    expect(v.rating).not.toBe("unsuitable");
  });

  it("cost above the per-instance ceiling is unsuitable", () => {
    const d = measured({
      cpuCost: {
        perRate: {
          [String(RATE)]: {
            nsPerSampleMedian: 10,
            nsPerSampleP95: 12,
            coreFractionP95: 0.09,
          },
        },
      },
    } as Partial<PluginDescriptor>);
    const v = classify(d);
    expect(v.rating).toBe("unsuitable");
    expect(v.deciding?.code).toBe(HOSTING_CODE.costAboveCeiling);
  });

  it("no audio input or output cannot be an insert on any host", () => {
    expect(classify(measured({ audioInputs: 0 })).rating).toBe("unsuitable");
    expect(classify(measured({ audioOutputs: 0 })).rating).toBe("unsuitable");
  });

  it("a required feature we do not provide is unsuitable", () => {
    const v = classify(measured({}, { lv2Features: { required: ["http://example.org/ns/needs#something"] } }));
    expect(v.rating).toBe("unsuitable");
    expect(v.deciding?.code).toBe(HOSTING_CODE.featuresMissing);
  });

  it("instance-access is refused as a host we will not become", () => {
    const v = classify(measured({}, { lv2Features: { required: ["http://lv2plug.in/ns/ext/instance-access"] } }));
    expect(v.reasons.map((r) => r.code)).toContain(HOSTING_CODE.featuresDisqualifying);
    expect(v.rating).toBe("unsuitable");
  });

  it("fixedBlockLength refuses while the quantum is not pinned, and is allowed once it is", () => {
    const need = { required: ["http://lv2plug.in/ns/ext/buf-size#fixedBlockLength"] };
    const unpinned = classify(measured({}, { lv2Features: need }));
    expect(unpinned.rating).toBe("unsuitable");
    const pinned = classify(measured({}, { lv2Features: need }), { quantum: 512 });
    expect(pinned.rating).toBe("suitable");
  });

  it("every feature we DO provide passes", () => {
    const v = classify(measured({}, { lv2Features: { required: [...OMX_INPROCESS_FEATURES] } }));
    expect(v.rating).toBe("suitable");
  });

  // host-backend-one-contract §3: ONE list, read live by the verdict and handed to the in-process
  // LV2 table at configure (mix_host_backend.test.c perturbs the same list on the C side).
  it("the verdict reads THE list: worker:schedule taken out of it turns a worker plugin unsuitable", () => {
    const worker = "http://lv2plug.in/ns/ext/worker#schedule";
    const need = {
      required: ["http://lv2plug.in/ns/ext/urid#map", worker, "http://lv2plug.in/ns/ext/options#options"],
    };
    expect(classify(measured({}, { lv2Features: need })).rating).toBe("suitable");
    const list = OMX_INPROCESS_FEATURES as string[];
    const at = list.indexOf(worker);
    expect(at).toBeGreaterThanOrEqual(0);
    list.splice(at, 1);
    try {
      const v = classify(measured({}, { lv2Features: need }));
      expect(v.rating).toBe("unsuitable");
      expect(v.reasons.find((r) => r.code === HOSTING_CODE.featuresMissing)?.params).toEqual({ features: worker });
    } finally {
      list.splice(at, 0, worker);
    }
    expect(classify(measured({}, { lv2Features: need })).rating).toBe("suitable");
  });
});

describe("the cautions cap at conditional and stay isolated", () => {
  const cautions: ReadonlyArray<readonly [string, Blocks, Partial<PluginDescriptor>, string]> = [
    [
      "a plugin that spawns a thread",
      { stability: { threads: { before: 1, afterFirstInstantiate: 2 } } },
      {},
      HOSTING_CODE.stabilitySpawnsThreads,
    ],
    ["a plugin linking a GUI toolkit", { stability: { linksGuiToolkit: true } }, {}, HOSTING_CODE.stabilityLinksGuiToolkit],
    ["a MIDI input fed an empty sequence", {}, { hasMidiIn: true }, HOSTING_CODE.featuresMidiIn],
    ["a topology beyond the strip's legs", {}, { audioInputs: 3, audioOutputs: 2 }, HOSTING_CODE.topologyExtraInputs],
  ];
  for (const [label, m, d, code] of cautions) {
    it(`${label} is conditional, and conditional is isolated`, () => {
      const v = classify(measured(d, m));
      expect(v.rating).toBe("conditional");
      expect(v.path).toBe("isolated");
      expect(v.reasons.map((r) => r.code)).toContain(code);
    });
  }

  it("a spiky plugin stays isolated: in-process a spike is the whole desk's xrun", () => {
    const d = measured({
      cpuCost: {
        perRate: {
          [String(RATE)]: {
            nsPerSampleMedian: 10,
            nsPerSampleP95: 90,
            coreFractionP95: 0.004,
          },
        },
      },
    } as Partial<PluginDescriptor>);
    const v = classify(d);
    expect(v.rating).toBe("conditional");
    expect(v.reasons.map((r) => r.code)).toContain(HOSTING_CODE.costSpiky);
  });
});

describe("the floor comes from policy, never baked in", () => {
  it("the same plugin passes or fails as the floor moves", () => {
    const d = measured({}, { stability: { lifecycle: { cycles: 200, instantiated: 200, failed: 0 } } });
    const low = classify(d, { policy: { ...DEFAULT_HOSTING_POLICY, cycleFloor: 100 } });
    const high = classify(d, { policy: { ...DEFAULT_HOSTING_POLICY, cycleFloor: 1000 } });
    expect(low.rating).toBe("suitable");
    expect(high.rating).toBe("unknown");
    expect(high.reasons.map((r) => r.code)).toContain(HOSTING_CODE.stabilityBelowFloor);
  });

  it("the operator's ruling of 2026-09-05 is the default floor", () => {
    expect(DEFAULT_HOSTING_POLICY.cycleFloor).toBe(1000);
  });
});

describe("the poisons: a verdict that must not stand", () => {
  it("a sweep whose positive control did not fire derives unknown", () => {
    const v = classify(measured(), { sweepControlFired: false });
    expect(v.rating).toBe("unknown");
    expect(v.reasons.map((r) => r.code)).toContain(HOSTING_CODE.sweepControlDidNotFire);
  });

  it("figures from another host cannot carry a verdict across an upgrade", () => {
    const v = classify(measured({}, { stability: { runHost: "mod-host 0.10.6-3" } }), {
      consoleHost: "mod-host 0.10.6-4",
    });
    expect(v.rating).toBe("unknown");
    expect(v.reasons.map((r) => r.code)).toContain(HOSTING_CODE.hostProvenanceDiffers);
  });

  it("the same host leaves the verdict standing", () => {
    const v = classify(measured({}, { stability: { runHost: "mod-host 0.10.6-4" } }), {
      consoleHost: "mod-host 0.10.6-4",
    });
    expect(v.rating).toBe("suitable");
  });
});

describe("the override demotes and can never promote", () => {
  it("a curator can take a measured plugin off the RT thread", () => {
    const v = classify(measured(), { override: "isolated" });
    expect(v.path).toBe("isolated");
    expect(v.reasons.map((r) => r.code)).toContain(HOSTING_CODE.overrideIsolated);
  });

  it("the loader refuses in-process at the door, and says why", () => {
    expect(() => assertHostingOverride("in-process", "curation-overrides.json")).toThrow(
      /may only be "isolated"/,
    );
    // Sabotage control: the guard must accept the one legal value, or the test above would
    // pass on a function that refused everything.
    expect(assertHostingOverride("isolated", "x")).toBe("isolated");
    expect(assertHostingOverride(undefined, "x")).toBeUndefined();
  });

  it("refuses any other value too, not just the dangerous one", () => {
    expect(() => assertHostingOverride("suitable", "x")).toThrow();
    expect(() => assertHostingOverride(true, "x")).toThrow();
  });
});

describe("attribution defaults to unknown", () => {
  it("maps only what a named investigation recorded", () => {
    expect(attributeCrash({ topFrame: "pw_memmap_free", signal: "SIGSEGV" })).toBe("host");
    expect(attributeCrash({ topFrame: "effects_remove" })).toBe("host");
    expect(attributeCrash({ topFrame: "lilv_instance_instantiate" })).toBe("plugin");
    expect(attributeCrash({ topFrame: "unheard_of" })).toBe("unknown");
    expect(attributeCrash({})).toBe("unknown");
  });
});

describe("the descriptor carries its own measurements, and the verdict reads them", () => {
  it("a descriptor with the three measured blocks is judged by them alone", () => {
    const v = classifyPluginHosting(measured(), { rate: RATE });
    expect(v.rating).toBe("suitable");
    expect(v.path).toBe("in-process");
  });

  it("the same descriptor without them is unknown — the blocks are what changed the answer", () => {
    const v = classifyPluginHosting(descriptor(), { rate: RATE });
    expect(v.rating).toBe("unknown");
    expect(v.path).toBe("isolated");
  });

  it("there is no second seam: the options carry no measurements a caller could slip past the door", () => {
    // Sabotage-shaped: an options object that still tried the old `measurements` override is
    // ignored, so the verdict is the descriptor's and a report cannot agree with itself alone.
    const sneaked = { rate: RATE, measurements: cleanMeasurements() } as HostingClassifyOptions;
    expect(classifyPluginHosting(descriptor(), sneaked).rating).toBe("unknown");
  });
});

describe("a soak is judged at EVERY rate it ran, by the classifier alone (§3)", () => {
  const P = DEFAULT_HOSTING_POLICY;
  const voids: ReadonlyArray<readonly [string, SoakAtRate, string]> = [
    ["a rate that died", { died: true }, "died@192000"],
    ["a rate that never instantiated", { instantiated: false }, "died@192000"],
    ["a non-finite window", { ...CLEAN_SOAK_RATE, nonFiniteWindows: 1 }, "non-finite@192000"],
    ["settled 40 dB under its own best", { ...CLEAN_SOAK_RATE, lastRmsDbfs: -71 }, "dead@192000"],
    ["more than half its windows silent", { ...CLEAN_SOAK_RATE, silentWindows: 5_001 }, "mostly-silent@192000"],
    ["a startup blast above +6 dBFS", { ...CLEAN_SOAK_RATE, firstRmsDbfs: 20 }, "startup-blast@192000(20dBFS)"],
  ];
  for (const [label, rate192, failure] of voids) {
    it(`${label} voids the soak — unsoaked, unknown, never a crash`, () => {
      const soak = cleanSoak({ "192000": rate192 });
      expect(soakFindings(soak, P)?.failures).toEqual([failure]);
      const v = classify(measured({}, { stability: { soak } }));
      expect(v.rating).toBe("unknown");
      expect(v.deciding?.code).toBe(HOSTING_CODE.stabilityUnsoaked);
      expect(v.reasons.map((r) => r.code)).not.toContain(HOSTING_CODE.stabilityCrashUnattributed);
    });
  }

  it("dead is a RATIO against the plugin's own best, never an absolute: a quiet plugin holds", () => {
    const quiet = { ...CLEAN_SOAK_RATE, firstRmsDbfs: -80, lastRmsDbfs: -80 };
    const soak = cleanSoak({ "44100": quiet, "48000": quiet, "96000": quiet, "192000": quiet });
    expect(soakFindings(soak, P)?.failures).toEqual([]);
    expect(classify(measured({}, { stability: { soak } })).rating).toBe("suitable");
  });

  it("a rate settled ABOVE +6 dBFS is not the reference — or every sane rate would read dead", () => {
    const blasting = { ...CLEAN_SOAK_RATE, lastRmsDbfs: 150 };
    const soak = cleanSoak({ "192000": blasting });
    // The blasting rate itself is not "dead"; the three sane ones are not dead against it.
    expect(soakFindings(soak, P)?.failures).toEqual([]);
  });

  it("a handful of silent windows is a gate closing on a swept threshold, not a death", () => {
    const soak = cleanSoak({ "96000": { ...CLEAN_SOAK_RATE, silentWindows: 12 } });
    expect(soakFindings(soak, P)?.failures).toEqual([]);
  });

  it("the soak proves no more than its SHORTEST rate ran", () => {
    const soak = cleanSoak({ "48000": { ...CLEAN_SOAK_RATE, seconds: 600 } });
    expect(soakFindings(soak, P)?.seconds).toBe(600);
    expect(classify(measured({}, { stability: { soak } })).deciding?.code).toBe(HOSTING_CODE.stabilityUnsoaked);
  });

  it("a soak that did not sweep the controls is not a show", () => {
    const soak = { ...cleanSoak(), sweptParams: false };
    expect(classify(measured({}, { stability: { soak } })).deciding?.code).toBe(HOSTING_CODE.stabilityUnsoaked);
  });

  it("the dead threshold is policy's, so moving it moves the verdict", () => {
    const soak = cleanSoak({ "192000": { ...CLEAN_SOAK_RATE, lastRmsDbfs: -65 } });
    expect(soakFindings(soak, P)?.failures).toEqual([]);
    expect(soakFindings(soak, { ...P, soakDeadDropDb: 30 })?.failures).toEqual(["dead@192000"]);
  });

  it("CV ports disqualify, read off the count the sweep took", () => {
    const v = classify(measured({}, { lv2Features: { cvPorts: 2 } }));
    expect(v.rating).toBe("unsuitable");
    expect(v.deciding?.code).toBe(HOSTING_CODE.featuresCv);
  });
});

describe("what a plugin EARNED and where it RUNS are different facts", () => {
  const earned = () => classifyPluginHosting(measured(), { rate: RATE });
  const unearned = () => classifyPluginHosting(descriptor(), { rate: RATE });

  it("the switch off isolates everything, whatever it earned, and says the switch", () => {
    const v = realisedHosting(earned(), { inProcessEnabled: false, inProcessAvailable: true });
    expect(v).toEqual({ path: "isolated", rating: "suitable", reason: HOSTING_CODE.disabled });
  });

  it("a plugin that earned nothing keeps its OWN deciding reason, not the switch's", () => {
    const v = realisedHosting(unearned(), { inProcessEnabled: true, inProcessAvailable: true });
    expect(v.path).toBe("isolated");
    expect(v.rating).toBe("unknown");
    expect(v.reason).toBe(HOSTING_CODE.stabilityUnmeasured);
  });

  it("earned, switched on, and no body to run in reads no-realisation", () => {
    const v = realisedHosting(earned(), { inProcessEnabled: true, inProcessAvailable: false });
    expect(v).toEqual({
      path: "isolated",
      rating: "suitable",
      reason: HOSTING_CODE.noRealisation,
    });
  });

  it("earned, switched on, body present — and only then does a slot read in-process", () => {
    const v = realisedHosting(earned(), { inProcessEnabled: true, inProcessAvailable: true });
    expect(v).toEqual({
      path: "in-process",
      rating: "suitable",
      reason: HOSTING_CODE.realisedInProcess,
    });
  });

  it("no verdict at all (no rate observed) is unjudged, never a pass", () => {
    const v = realisedHosting(undefined, { inProcessEnabled: true, inProcessAvailable: true });
    expect(v).toEqual({ path: "isolated", rating: "unknown", reason: HOSTING_CODE.unjudged });
  });

  it("a LINKED plugin runs in-process with no verdict at all, where a body exists", () => {
    const v = realisedHosting(undefined, { inProcessEnabled: true, inProcessAvailable: true, linked: true });
    expect(v).toEqual({ path: "in-process", rating: "unknown", reason: HOSTING_CODE.linked });
  });

  it("a LINKED plugin still obeys the switch, and reads no-realisation with no body", () => {
    expect(realisedHosting(undefined, { inProcessEnabled: false, inProcessAvailable: true, linked: true })).toEqual({
      path: "isolated",
      rating: "unknown",
      reason: HOSTING_CODE.disabled,
    });
    expect(realisedHosting(undefined, { inProcessEnabled: true, inProcessAvailable: false, linked: true })).toEqual({
      path: "isolated",
      rating: "unknown",
      reason: HOSTING_CODE.noRealisation,
    });
  });
});

describe("an advisory reason may never disqualify", () => {
  it("caps at conditional even when it claims unsuitable", () => {
    expect(
      contributedHostingRating({
        dimension: "cost",
        kind: "advisory",
        rating: "unsuitable",
        code: HOSTING_CODE.costSpiky,
        params: {},
      }),
    ).toBe("conditional");
    expect(
      contributedHostingRating({
        dimension: "cost",
        kind: "objective",
        rating: "unsuitable",
        code: HOSTING_CODE.costAboveCeiling,
        params: {},
      }),
    ).toBe("unsuitable");
  });
});

/*
 * THE CLAP CELLS (2026-09-26-clap-hosting-path.md §3, §11.4): the SAME verdict over CLAP facts,
 * one assertion per cell BY VALUE — rating, code and params. The positive control comes first:
 * a descriptor carrying measurements that EARN in-process. Everything after it is what does
 * NOT, and the first of those is the one that matters most: a `.clap` nobody qualified reads
 * `unknown`, never `suitable` — fail closed is a verdict, not a dead wire.
 */
describe("the CLAP arm — the §3 verdict over CLAP facts", () => {
  const RATES = ["44100", "48000", "96000", "192000"] as const;
  /** A clean qualification: 2x2 main pair, audio effect, headless, no notes, latency honest at every rate. */
  function cleanClap(over: Partial<PluginClapMeasurement> = {}): PluginClapMeasurement {
    return {
      mainInputChannels: 2,
      mainOutputChannels: 2,
      sidechainInputs: 0,
      features: [CLAP_FEATURE_AUDIO_EFFECT, "stereo"],
      headlessOk: true,
      noteInputs: 0,
      latency: Object.fromEntries(RATES.map((r) => [r, { declaredFrames: 0, measuredFrames: 0 }])),
      threadViolations: 0,
      processErrors: 0,
      processCalls: 512,
      ...over,
    };
  }
  /** A CLAP descriptor: the declared format and the qualifier's block, the LV2-only facts absent.
   *  The key (`urn:clap:…`) and the binary path are the catalog's, not facts the verdict reads. */
  // `null` means NOT QUALIFIED — spelled apart from an omitted argument, because a default
  // parameter also answers an explicit `undefined` (the same trap plugin-offer-rows.test.ts names).
  function clapDescriptor(over: Partial<PluginDescriptor> = {}, clap: PluginClapMeasurement | null = cleanClap()): PluginDescriptor {
    const { lv2Features: _noLv2, ...clean } = cleanMeasurements();
    return descriptor({
      audioInputs: 2,
      audioOutputs: 2,
      format: "clap",
      ...clean,
      ...(clap ? { clap } : {}),
      ...over,
    });
  }
  const codeOf = (v: ReturnType<typeof classify>, dimension: string) =>
    v.reasons.filter((r) => r.dimension === dimension).map((r) => r.code);

  it("positive control: a qualified, clean CLAP earns in-process on every dimension", () => {
    const v = classify(clapDescriptor());
    expect(v.rating).toBe("suitable");
    expect(v.path).toBe("in-process");
    expect(new Set(v.reasons.map((r) => r.dimension))).toEqual(
      new Set(["stability", "rtSafety", "features", "cost", "latency", "topology"]),
    );
    expect(codeOf(v, "topology")).toEqual([HOSTING_CODE.topologyMatched]);
    expect(codeOf(v, "latency")).toEqual([HOSTING_CODE.latencyResolved]);
    expect(codeOf(v, "features")).toEqual([HOSTING_CODE.featuresProvided]);
    // The LV2 features arm is NOT consulted for a CLAP: no lv2Features block, no `scan-predates-field`.
    expect(v.reasons.map((r) => r.code)).not.toContain(HOSTING_CODE.featuresUnscanned);
  });

  it("the scan's hasMidiIn alone refuses a CLAP whose measurement says no note input, once", () => {
    const v = classify(clapDescriptor({ hasMidiIn: true }, cleanClap({ noteInputs: 0 })));
    expect(v.rating).toBe("unsuitable");
    expect(v.path).toBe("isolated");
    expect(v.deciding?.code).toBe(HOSTING_CODE.clapNoteInput);
    expect(v.reasons.filter((r) => r.code === HOSTING_CODE.clapNoteInput)).toHaveLength(1);
    const both = classify(clapDescriptor({ hasMidiIn: true }, cleanClap({ noteInputs: 1 })));
    expect(both.reasons.filter((r) => r.code === HOSTING_CODE.clapNoteInput), "the two facts mint one reason").toHaveLength(1);
  });

  it("a CLAP nobody qualified reads unknown with hosting.clap.unqualified — refused, never admitted", () => {
    const v = classify(clapDescriptor({}, null));
    expect(v.rating).toBe("unknown");
    expect(v.path).toBe("isolated");
    expect(v.deciding?.code).toBe(HOSTING_CODE.clapUnqualified);
    for (const d of ["topology", "features", "rtSafety"]) expect(codeOf(v, d)).toContain(HOSTING_CODE.clapUnqualified);
    expect(codeOf(v, "latency")).toEqual([HOSTING_CODE.latencyUnmeasured]);
  });

  const cells: ReadonlyArray<readonly [string, Partial<PluginClapMeasurement>, string, string, Record<string, unknown>]> = [
    ["no main input", { mainInputChannels: 0 }, "unsuitable", HOSTING_CODE.topologyNoAudioInput, {}],
    ["no main output", { mainOutputChannels: 0 }, "unsuitable", HOSTING_CODE.topologyNoAudioOutput, {}],
    ["wider than a strip", { mainInputChannels: 6, mainOutputChannels: 6 }, "unsuitable", HOSTING_CODE.topologyWiderThanStrip, { ins: 6, outs: 6 }],
    ["a sidechain input is fed silence", { sidechainInputs: 1 }, "conditional", HOSTING_CODE.topologyExtraInputs, { ins: 2, outs: 2, sidechains: 1 }],
    ["latency that lies at one rate", { latency: { ...cleanClap().latency, "96000": { declaredFrames: 64, measuredFrames: 71 } } }, "unsuitable", HOSTING_CODE.clapLatencyMismatch, { rate: 96000, declared: 64, measured: 71 }],
    ["not an audio effect", { features: ["instrument", "synthesizer"] }, "unsuitable", HOSTING_CODE.clapNotAudioEffect, { features: "instrument synthesizer" }],
    ["init or activate failed headless", { headlessOk: false }, "unsuitable", HOSTING_CODE.clapHeadlessFailed, {}],
    ["an instrument: a note input", { noteInputs: 1 }, "unsuitable", HOSTING_CODE.clapNoteInput, { noteInputs: 1 }],
    ["a thread-check violation", { threadViolations: 2 }, "unsuitable", HOSTING_CODE.clapThreadViolation, { violations: 2 }],
    ["a CLAP_PROCESS_ERROR under the sweep", { processErrors: 1 }, "unsuitable", HOSTING_CODE.clapProcessError, { errors: 1 }],
    ["a sweep that never called process()", { processCalls: 0 }, "unknown", HOSTING_CODE.clapUnqualified, {}],
  ];
  for (const [label, over, rating, code, params] of cells) {
    it(`${label} → ${rating} (${code}), by value`, () => {
      const v = classify(clapDescriptor({}, cleanClap(over)));
      expect(v.rating).toBe(rating);
      expect(v.path, "anything below suitable has no CLAP path").toBe("isolated");
      const hit = v.reasons.find((r) => r.code === code);
      expect(hit, `the verdict names ${code}`).toBeDefined();
      expect(hit?.rating).toBe(rating);
      expect(hit?.params).toEqual(params);
      expect(v.deciding?.code, "the deciding reason is the cell's own").toBe(code);
    });
  }

  it("the interposer's counts refuse a CLAP exactly as they refuse an LV2", () => {
    const v = classify(clapDescriptor({ rtSafety: { ...cleanMeasurements().rtSafety, allocationsInRun: 3 } }));
    expect(v.rating).toBe("unsuitable");
    expect(v.deciding?.code).toBe(HOSTING_CODE.rtSafetyViolations);
  });

  it("a curator override still only demotes a CLAP (the verdict's grammar is unchanged)", () => {
    const v = classify(clapDescriptor(), { override: "isolated" });
    expect(v.rating).toBe("unsuitable");
    expect(v.deciding?.code).toBe(HOSTING_CODE.overrideIsolated);
  });

  it("identity: the key grammar and the declared format", () => {
    expect(isClapUri("urn:clap:com.example.x")).toBe(true);
    expect(isClapUri("http://lsp-plug.in/plugins/lv2/comp_stereo")).toBe(false);
    expect(isClapPlugin("urn:clap:com.example.x", undefined), "a never-scanned urn:clap: key is a CLAP").toBe(true);
    expect(isClapPlugin("urn:x", { format: "clap" }), "the declared format wins over the key").toBe(true);
    expect(isClapPlugin("urn:clap:x", { format: "lv2" }), "a declared lv2 format is not re-derived from the key").toBe(false);
    expect(isClapPlugin("urn:openmixer:delay", undefined)).toBe(false);
  });

  it("realised: a suitable CLAP is still isolated while the switch is off or no body exists, and the reason says which", () => {
    const verdict = classify(clapDescriptor());
    expect(realisedHosting(verdict, { inProcessEnabled: false, inProcessAvailable: false }).reason).toBe(HOSTING_CODE.disabled);
    expect(realisedHosting(verdict, { inProcessEnabled: true, inProcessAvailable: false }).reason).toBe(HOSTING_CODE.noRealisation);
    expect(realisedHosting(verdict, { inProcessEnabled: true, inProcessAvailable: true }).path).toBe("in-process");
  });
});

/**
 * HOST PROFILES (`2026-09-25-plugin-qualify.md` §3a): the SAME measurements, judged against a
 * declared host. Each cell holds the plugin fixed and moves only the profile, so the difference
 * in the verdict is the profile's and nothing else's.
 */
describe("host profiles — the host is a declared input, the measurements are not", () => {
  const onJalv = (d: PluginDescriptor, o: Partial<HostingClassifyOptions> = {}) => classify(d, { profile: JALV_PROFILE, ...o });
  const onModHost = (d: PluginDescriptor, o: Partial<HostingClassifyOptions> = {}) => classify(d, { profile: MOD_HOST_PROFILE, ...o });
  const codes = (v: ReturnType<typeof classify>) => v.reasons.map((r) => r.code);

  it("openmixer-console named is exactly no profile named, whole verdict, across the oracle's cells", () => {
    const cells: PluginDescriptor[] = [
      measured(),
      descriptor(),
      measured({ audioInputs: 0, hasMidiIn: true }),
      measured({}, { lv2Features: { required: ["http://lv2plug.in/ns/ext/buf-size#fixedBlockLength"] } }),
      measured({}, { stability: { linksGuiToolkit: true } }),
    ];
    for (const d of cells) {
      for (const quantum of [undefined, 1024]) {
        const o = quantum === undefined ? {} : { quantum };
        expect(classify(d, { ...o, profile: OPENMIXER_CONSOLE_PROFILE })).toEqual(classify(d, o));
      }
    }
  });

  it("a synth (no audio input, MIDI in) is refused as a console insert and earns jalv and mod-host", () => {
    const synth = measured({ audioInputs: 0, audioOutputs: 2, hasMidiIn: true });
    expect(classify(synth).deciding?.code).toBe(HOSTING_CODE.topologyNoAudioInput);
    for (const v of [onJalv(synth), onModHost(synth)]) {
      expect(v.rating).toBe("suitable");
      expect(codes(v)).toContain(HOSTING_CODE.topologyInstrument);
      expect(codes(v)).not.toContain(HOSTING_CODE.featuresMidiIn);
    }
  });

  it("no audio input and no MIDI input is nothing any host can feed", () => {
    expect(onJalv(measured({ audioInputs: 0, hasMidiIn: false })).deciding?.code).toBe(HOSTING_CODE.topologyNoAudioInput);
  });

  it("the provided features are the profile's: state#makePath passes mod-host, fails the console and jalv", () => {
    const d = measured({}, { lv2Features: { required: ["http://lv2plug.in/ns/ext/state#makePath"] } });
    expect(classify(d).deciding?.code).toBe(HOSTING_CODE.featuresMissing);
    expect(onJalv(d).deciding?.code).toBe(HOSTING_CODE.featuresMissing);
    expect(onModHost(d).rating).toBe("suitable");
  });

  it("fixedBlockLength: a host that lists it provides it without a pinned quantum", () => {
    const d = measured({}, { lv2Features: { required: ["http://lv2plug.in/ns/ext/buf-size#fixedBlockLength"] } });
    expect(classify(d).deciding?.code).toBe(HOSTING_CODE.featuresDisqualifying);
    expect(onJalv(d).rating).toBe("suitable");
  });

  it("instance-access stays refused unless a profile lists it", () => {
    const d = measured({}, { lv2Features: { required: ["http://lv2plug.in/ns/ext/instance-access"] } });
    expect(onJalv(d).deciding?.code).toBe(HOSTING_CODE.featuresDisqualifying);
    const lists = { ...JALV_PROFILE, id: "t", lv2Features: [...JALV_PROFILE.lv2Features, "http://lv2plug.in/ns/ext/instance-access"] };
    expect(classify(d, { profile: lists }).rating).toBe("suitable");
  });

  it("the cost ceiling is the profile's budget: 9 % of a core fails the console, fits jalv's quarter core", () => {
    const d = measured({
      cpuCost: { perRate: { [String(RATE)]: { nsPerSampleMedian: 10, nsPerSampleP95: 12, coreFractionP95: 0.09 } } },
    } as Partial<PluginDescriptor>);
    expect(classify(d).deciding?.params).toMatchObject({ ceiling: DEFAULT_HOSTING_POLICY_CEILING });
    expect(onModHost(d).deciding?.code).toBe(HOSTING_CODE.costAboveCeiling);
    const j = onJalv(d);
    expect(j.rating).toBe("suitable");
    expect(j.reasons.find((r) => r.dimension === "cost")?.params).toMatchObject({ ceiling: JALV_PROFILE.cost.coreFractionCeiling });
  });

  it("a parameter-dependent latency is a caution only where the host compensates", () => {
    const d = measured({ latency: { paramSweep: { param: "lookahead" } } } as Partial<PluginDescriptor>);
    expect(classify(d).deciding?.code).toBe(HOSTING_CODE.latencyParameterDependent);
    expect(onJalv(d).rating).toBe("suitable");
  });

  it("unmeasured latency is unknown for every host — fail closed does not depend on the host", () => {
    const d = measured({ latency: undefined } as Partial<PluginDescriptor>);
    for (const v of [classify(d), onJalv(d), onModHost(d)]) expect(v.deciding?.code).toBe(HOSTING_CODE.latencyUnmeasured);
  });

  it("threads and a GUI toolkit are cautions only where the plugin shares a process", () => {
    for (const stability of [{ linksGuiToolkit: true }, { threads: { before: 1, afterFirstInstantiate: 3, afterAllFreed: 1, leaked: 0 } }]) {
      const d = measured({}, { stability });
      expect(classify(d).rating).toBe("conditional");
      expect(onModHost(d).rating).toBe("conditional");
      expect(onJalv(d).rating).toBe("suitable");
    }
  });

  it("a crash attributed to the plugin is unsuitable on every host: stability is not the host's to forgive", () => {
    const d = measured({}, { stability: { crashes: [{ topFrame: "lilv_instance_instantiate" }] } });
    for (const v of [classify(d), onJalv(d), onModHost(d)]) expect(v.deciding?.code).toBe(HOSTING_CODE.stabilityCrashedAttributed);
  });

  it("path: in-process only for an in-process host; a suitable plugin on jalv runs in jalv's process", () => {
    expect(classify(measured()).path).toBe("in-process");
    expect(onJalv(measured()).rating).toBe("suitable");
    expect(onJalv(measured()).path).toBe("isolated");
    expect(onModHost(measured()).path).toBe("isolated");
  });
});

describe("host profiles — the CLAP arm", () => {
  const clapFacts = (over: Partial<PluginClapMeasurement> = {}): PluginClapMeasurement => ({
    mainInputChannels: 2,
    mainOutputChannels: 2,
    sidechainInputs: 0,
    features: [CLAP_FEATURE_AUDIO_EFFECT],
    headlessOk: true,
    noteInputs: 0,
    latency: { [String(RATE)]: { declaredFrames: 0, measuredFrames: 0 } },
    threadViolations: 0,
    processErrors: 0,
    processCalls: 512,
    ...over,
  });
  const clapPlugin = (over: Partial<PluginClapMeasurement> = {}) => {
    const { lv2Features: _none, ...clean } = cleanMeasurements();
    return descriptor({ format: "clap", ...clean, clap: clapFacts(over) });
  };

  it("a host with no CLAP path refuses a CLAP, whatever it measured", () => {
    expect(classify(clapPlugin()).rating).toBe("suitable");
    const v = classify(clapPlugin(), { profile: JALV_PROFILE });
    expect(v.rating).toBe("unsuitable");
    expect(v.deciding?.code).toBe(HOSTING_CODE.clapFormatNotHosted);
  });

  it("a host offering less than the qualifier offered cannot inherit its headless pass", () => {
    const fewer = { ...OPENMIXER_CONSOLE_PROFILE, id: "t", clapExtensions: ["clap.log"] };
    const v = classify(clapPlugin(), { profile: fewer });
    expect(v.rating).toBe("unknown");
    expect(v.deciding?.code).toBe(HOSTING_CODE.clapExtensionsNotCovered);
  });

  it("a CLAP instrument earns an instrument host and not the console", () => {
    const synth = clapPlugin({ mainInputChannels: 0, noteInputs: 1, features: ["instrument"] });
    expect(classify(synth).rating).toBe("unsuitable");
    const host = { ...OPENMIXER_CONSOLE_PROFILE, id: "t", instruments: true, isolation: "per-process" as const };
    const v = classify(synth, { profile: host });
    expect(v.rating).toBe("suitable");
    expect(v.reasons.map((r) => r.code)).toContain(HOSTING_CODE.topologyInstrument);
  });
});
