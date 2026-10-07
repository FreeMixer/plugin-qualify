// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The `plugin-qualify` CLI's decisions (`docs/design/specs/2026-09-25-plugin-qualify.md` §5):
 * argument parsing and `--help` read the OPTIONS table and the declarations; the single-plugin
 * path (by URI, by bundle path) is its own case, never `--all` filtered; the verdict is
 * `classifyPluginHosting`'s and nothing else; the exit code is 0/1/2 as declared.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { QUALIFY_QUANTA, QUALIFY_RATES, DEFAULT_HOSTING_POLICY, COST_REFERENCE_RATE, QUANTUM_FRAMES } from "./qualify-declarations.js";
import { EXIT_CODE, QUALIFY_OPTIONS } from "./qualify-options.js";
import { HOSTING_CODE, attributeCrash, type QualifiedPlugin } from "./hosting-suitability.js";
import { lv2Loader } from "./lv2-loader.js";
import {
  exitCodeFor,
  helpText,
  parseQualifyArgs,
  qualifyPlugins,
  judgedDocument,
  resolveHostProfiles,
  resolveTargets,
  textTable,
} from "./qualify-cli.js";
import { JALV_PROFILE, OPENMIXER_CONSOLE_PROFILE } from "./host-profiles.js";
import { readMeasurementDocument, serialiseMeasurementDocument } from "./measurement/format.js";
import { fixtureRun } from "./measurement/fixtures.js";

/** A run record, as every document must carry one. */
const RUN = fixtureRun();

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const ZERO_PATH_BUNDLE = join(PKG, "fixtures", "zero-path.lv2");
const ZERO_PATH_URI = "urn:openmixer:eval:zero-path";

describe("parseQualifyArgs — the named-plugin path is first-class", () => {
  it("one LV2 URI qualifies exactly that plugin, with the declared rate and quantum defaults", () => {
    const a = parseQualifyArgs([ZERO_PATH_URI]);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.args.all).toBe(false);
    expect(a.args.targets).toEqual([ZERO_PATH_URI]);
    expect(a.args.rates).toEqual(QUALIFY_RATES);
    expect(a.args.quanta).toEqual(QUALIFY_QUANTA);
    expect(a.args.hostSweep).toBe(true);
    expect(a.args.format).toBe("text");
  });

  it("a bundle path is a target like a URI", () => {
    const a = parseQualifyArgs([ZERO_PATH_BUNDLE, "--no-host-sweep", "--format", "json"]);
    expect(a.ok && a.args.targets).toEqual([ZERO_PATH_BUNDLE]);
    expect(a.ok && a.args.hostSweep).toBe(false);
    expect(a.ok && a.args.format).toBe("json");
  });

  it("--all takes no targets; targets and --all together are refused, as is neither", () => {
    const all = parseQualifyArgs(["--all"]);
    expect(all.ok && all.args.all).toBe(true);
    expect(parseQualifyArgs(["--all", ZERO_PATH_URI]).ok).toBe(false);
    expect(parseQualifyArgs([]).ok).toBe(false);
  });

  it("--rates/--quanta override the declarations; a non-number or an unknown flag is refused", () => {
    const a = parseQualifyArgs(["--rates", "48000,96000", "--quanta", "256", "x:y"]);
    expect(a.ok && a.args.rates).toEqual([48000, 96000]);
    expect(a.ok && a.args.quanta).toEqual([256]);
    expect(parseQualifyArgs(["--rates", "fast", "x:y"]).ok).toBe(false);
    expect(parseQualifyArgs(["--format", "xml", "x:y"]).ok).toBe(false);
    expect(parseQualifyArgs(["--bogus", "x:y"]).ok).toBe(false);
  });

  it("--out, --isolate are carried", () => {
    const a = parseQualifyArgs(["--out", "/tmp/o", "--isolate", "x:y"]);
    expect(a.ok && a.args.out).toBe("/tmp/o");
    expect(a.ok && a.args.isolate).toBe(true);
  });
});

describe("--help lists every declared option with its declared default", () => {
  it("every OPTIONS flag appears, and every default is the declaration's value", () => {
    const help = helpText();
    for (const o of QUALIFY_OPTIONS) {
      expect(help).toContain(o.flag);
      if (o.default !== undefined) expect(help).toContain(`default: ${o.default}`);
    }
    expect(help).toContain(QUALIFY_RATES.join(","));
    expect(help).toContain(QUALIFY_QUANTA.join(","));
    for (const code of Object.values(EXIT_CODE)) expect(help).toContain(String(code));
  });
});

describe("lv2Loader — the one discovery seam", () => {
  it("a URI resolves to exactly that plugin", () => {
    expect(lv2Loader.resolve(ZERO_PATH_URI)).toEqual([{ format: "lv2", uri: ZERO_PATH_URI }]);
  });

  it("a bundle path resolves to every plugin its manifest declares, with the binary's basename", () => {
    expect(lv2Loader.resolve(ZERO_PATH_BUNDLE)).toEqual([
      { format: "lv2", uri: ZERO_PATH_URI, bundle: ZERO_PATH_BUNDLE, binary: "zero-path.so" },
    ]);
  });

  it("a bundle with two plugins yields both; one with none yields [] (a refusal, not nothing)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pq-bundle-"));
    try {
      const two = join(dir, "two.lv2");
      mkdirSync(two);
      writeFileSync(
        join(two, "manifest.ttl"),
        "@prefix lv2: <http://lv2plug.in/ns/lv2core#> .\n" +
          "<urn:t:a> a lv2:Plugin ; lv2:binary <a.so> .\n" +
          "<urn:t:b>\n    a lv2:Plugin ;\n    lv2:binary <b.so> .\n",
      );
      expect(lv2Loader.resolve(two)?.map((t) => [t.uri, t.binary])).toEqual([
        ["urn:t:a", "a.so"],
        ["urn:t:b", "b.so"],
      ]);
      const none = join(dir, "none.lv2");
      mkdirSync(none);
      writeFileSync(join(none, "manifest.ttl"), "@prefix lv2: <http://lv2plug.in/ns/lv2core#> .\n");
      expect(lv2Loader.resolve(none)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("resolveTargets refuses a target no loader claims, naming it", () => {
    const r = resolveTargets(["/no/such/bundle.lv2"], [lv2Loader]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refused).toEqual(["/no/such/bundle.lv2"]);
    const ok = resolveTargets([ZERO_PATH_URI, ZERO_PATH_BUNDLE], [lv2Loader]);
    expect(ok.ok && ok.plugins.map((p) => p.uri)).toEqual([ZERO_PATH_URI]); // one plugin, named twice
  });
});

/** A plugin with every dimension measured clean at the reference rate and quantum. */
function knownGood(): QualifiedPlugin {
  const rate = COST_REFERENCE_RATE;
  return {
    audioInputs: 1,
    audioOutputs: 1,
    hasMidiIn: false,
    latency: { scalingClass: "constant" },
    cpuCost: { perRate: { [String(rate)]: { coreFractionP95: 0.001, nsPerSampleMedian: 10, nsPerSampleP95: 12 } } },
    stability: {
      lifecycle: { cycles: DEFAULT_HOSTING_POLICY.cycleFloor, instantiated: DEFAULT_HOSTING_POLICY.cycleFloor, failed: 0 },
      threads: { before: 1, afterFirstInstantiate: 1, afterAllFreed: 1, leaked: 0 },
      crashes: [],
      soak: {
        sweptParams: true,
        perRate: {
          [String(rate)]: {
            instantiated: true,
            seconds: DEFAULT_HOSTING_POLICY.soakSeconds,
            windows: 1000,
            nonFiniteWindows: 0,
            silentWindows: 0,
            firstRmsDbfs: -20,
            lastRmsDbfs: -20,
            rssGrowthKb: 0,
          },
        },
      },
    },
    rtSafety: {
      rate,
      blockFrames: QUANTUM_FRAMES,
      blocks: 512,
      repeats: 3,
      interposer: true,
      swept: true,
      sweepApplicable: true,
      allocationsInRun: 0,
      allocationsMin: 0,
      locksInRun: 0,
      syscallsInRun: 0,
      variable: false,
    },
    lv2Features: { required: [], optional: [], cvPorts: 0 },
  } as QualifiedPlugin;
}

/** The #98 positive control as the ASan sweep records it: a heap overflow in its own binary. */
function zeroPathUnderAsan(): QualifiedPlugin {
  const good = knownGood();
  return {
    ...good,
    stability: {
      ...good.stability,
      crashes: [{ signal: "SIGABRT", topFrame: "run", sanitizer: "heap-buffer-overflow", frameObject: "zero-path.so" }],
    },
  } as QualifiedPlugin;
}

describe("the verdict is classifyPluginHosting's, and the exit code follows it", () => {
  const opts = { rate: COST_REFERENCE_RATE, quantum: QUANTUM_FRAMES };

  it("attributeCrash: a sanitizer error in the plugin's own binary is the plugin's; elsewhere unknown", () => {
    const c = { signal: "SIGABRT" as const, topFrame: "run", sanitizer: "heap-buffer-overflow", frameObject: "zero-path.so" };
    expect(attributeCrash(c, undefined, "zero-path.so")).toBe("plugin");
    expect(attributeCrash({ ...c, frameObject: "mod-host" }, undefined, "zero-path.so")).toBe("unknown");
    expect(attributeCrash({ ...c, sanitizer: undefined }, undefined, "zero-path.so")).toBe("unknown");
    expect(attributeCrash(c)).toBe("unknown"); // no binary named: nothing to match against
  });

  it("POSITIVE CONTROL: zero-path under the ASan sweep is NOT suitable, decided by the attributed crash", () => {
    const [v] = qualifyPlugins([{ target: { format: "lv2", uri: ZERO_PATH_URI, binary: "zero-path.so" }, plugin: zeroPathUnderAsan() }], opts);
    expect(v?.rating).toBe("unsuitable");
    expect(v?.qualified).toBe(false);
    expect(v?.deciding).toBe(HOSTING_CODE.stabilityCrashedAttributed);
    expect(exitCodeFor([v!])).toBe(EXIT_CODE.someNotQualified);
    expect(textTable([v!])).toMatch(new RegExp(`${ZERO_PATH_URI}\\s+unsuitable\\s+${HOSTING_CODE.stabilityCrashedAttributed}`));
  });

  it("KNOWN GOOD: every dimension measured clean is suitable and exits 0", () => {
    const [v] = qualifyPlugins([{ target: { format: "lv2", uri: "urn:t:good" }, plugin: knownGood() }], opts);
    expect(v?.rating).toBe("suitable");
    expect(v?.qualified).toBe(true);
    expect(exitCodeFor([v!])).toBe(EXIT_CODE.allQualified);
  });

  it("a plugin with no measurement at all could not be measured: exit 2, never a pass", () => {
    const [v] = qualifyPlugins([{ target: { format: "lv2", uri: "urn:t:none" } }], opts);
    expect(v?.measured).toBe(false);
    expect(v?.qualified).toBe(false);
    expect(exitCodeFor([v!])).toBe(EXIT_CODE.couldNotMeasure);
    const [g] = qualifyPlugins([{ target: { format: "lv2", uri: "urn:t:good" }, plugin: knownGood() }], opts);
    expect(exitCodeFor([g!, v!])).toBe(EXIT_CODE.couldNotMeasure);
  });
});

describe("--host-profile — one verdict per plugin per profile (§3a, §5)", () => {
  // The live pair the fixtures were costed at; each profile's own declared pair is its own test below.
  const opts = { rate: COST_REFERENCE_RATE, quantum: QUANTUM_FRAMES };
  const good = { target: { format: "lv2", uri: "urn:t:good" }, plugin: knownGood() };
  const synth = { target: { format: "lv2", uri: "urn:t:synth" }, plugin: { ...knownGood(), audioInputs: 0, audioOutputs: 2, hasMidiIn: true } as QualifiedPlugin };

  it("defaults to openmixer-console, the declared default --help prints", () => {
    const a = parseQualifyArgs(["urn:t:good"]);
    expect(a.ok && a.args.hostProfiles).toEqual([OPENMIXER_CONSOLE_PROFILE.id]);
    expect(helpText()).toContain(`--host-profile <file|id>`);
    expect(helpText()).toContain(`(default: ${OPENMIXER_CONSOLE_PROFILE.id})`);
  });

  it("repeats and comma-separates, in order, once each", () => {
    const a = parseQualifyArgs(["urn:t:good", "--host-profile", "jalv,mod-host", "--host-profile", "./zynth.json", "--host-profile", "jalv"]);
    expect(a.ok && a.args.hostProfiles).toEqual(["jalv", "mod-host", "./zynth.json"]);
  });

  it("resolves a shipped id and a profile file; refuses an id nobody ships and a bad file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pq-profile-"));
    try {
      const own = join(dir, "zynth.json");
      writeFileSync(own, JSON.stringify({ ...JALV_PROFILE, id: "zynthian-v5", cost: { coreFractionCeiling: 0.3, rate: 44100, quantum: 256 } }));
      const bad = join(dir, "bad.json");
      writeFileSync(bad, JSON.stringify({ id: "half" }));
      const ok = resolveHostProfiles(["jalv", own]);
      expect(ok.ok).toBe(true);
      if (ok.ok) expect(ok.profiles.map((p) => p.id)).toEqual(["jalv", "zynthian-v5"]);
      const no = resolveHostProfiles(["ardour", bad, join(dir, "absent.json")]);
      expect(no.ok).toBe(false);
      if (!no.ok) expect(no.refused.map((r) => r.spec)).toEqual(["ardour", bad, join(dir, "absent.json")]);
      // Two specs naming one id are one host asked twice: refused, never two verdicts for one id.
      const clash = join(dir, "clash.json");
      writeFileSync(clash, JSON.stringify(JALV_PROFILE));
      const twice = resolveHostProfiles(["jalv", clash]);
      expect(twice.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("several profiles: one verdict per plugin per profile, each carrying the host's id", () => {
    const vs = qualifyPlugins([good, synth], { profiles: [OPENMIXER_CONSOLE_PROFILE, JALV_PROFILE], ...opts });
    expect(vs.map((v) => [v.uri, v.host, v.rating])).toEqual([
      ["urn:t:good", "openmixer-console", "suitable"],
      ["urn:t:good", "jalv", "suitable"],
      ["urn:t:synth", "openmixer-console", "unsuitable"],
      ["urn:t:synth", "jalv", "suitable"],
    ]);
    // Qualified under one host and not the other has not answered yes.
    expect(exitCodeFor(vs)).toBe(EXIT_CODE.someNotQualified);
    expect(exitCodeFor(vs.filter((v) => v.host === "jalv"))).toBe(EXIT_CODE.allQualified);
    expect(textTable(vs)).toMatch(/urn:t:synth\s+unsuitable\s+hosting\.topology\.no-audio-input\s+openmixer-console/);
  });

  it("each profile is judged at its own declared rate and quantum unless the caller names a live pair", () => {
    // knownGood() carries cost at the console's reference rate only: a host judged at 48 k has no figure there.
    const [j] = qualifyPlugins([good], { profiles: [JALV_PROFILE] });
    expect(j?.deciding).toBe(HOSTING_CODE.costUnmeasured);
    const [live] = qualifyPlugins([good], { profiles: [JALV_PROFILE], rate: COST_REFERENCE_RATE });
    expect(live?.rating).toBe("suitable");
  });

  it("the interchange document carries the profiles and the verdicts with their host id, and reads back", () => {
    const vs = qualifyPlugins([good, synth], { profiles: [OPENMIXER_CONSOLE_PROFILE, JALV_PROFILE], ...opts });
    const doc = judgedDocument(RUN, [], [OPENMIXER_CONSOLE_PROFILE, JALV_PROFILE], vs);
    expect(doc.formatVersion).toBe("1.2");
    expect(doc.hostProfiles?.map((p) => p.id)).toEqual(["openmixer-console", "jalv"]);
    expect(doc.verdicts).toHaveLength(4);
    expect(doc.verdicts?.[3]).toEqual({ uri: "urn:t:synth", host: "jalv", rating: "suitable", qualified: true });
    const back = readMeasurementDocument(JSON.parse(serialiseMeasurementDocument(doc)));
    expect(back.ok && back.document).toEqual(doc);
  });
});
