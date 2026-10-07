// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The host profiles as declared (`docs/design/specs/2026-09-25-plugin-qualify.md` §3a): the
 * shipped three, the lists they cite, and the reader a project's own profile file goes through —
 * which refuses a missing or mistyped field rather than filling in a host it was not told about.
 */
import { describe, expect, it } from "vitest";
import {
  HOST_PROFILES,
  JALV_LV2_FEATURES,
  JALV_PROFILE,
  MOD_HOST_LV2_FEATURES,
  OMX_CLAP_HOST_EXTENSIONS,
  OMX_INPROCESS_FEATURES,
  OPENMIXER_CONSOLE_PROFILE,
  readHostProfile,
  shippedHostProfile,
} from "./host-profiles.js";
import * as hosting from "./hosting-suitability.js";
import { HOST_BUDGETS } from "./qualify-declarations.js";

describe("the shipped profiles", () => {
  it("are three, by unique id, openmixer-console first", () => {
    expect(HOST_PROFILES.map((p) => p.id)).toEqual(["openmixer-console", "jalv", "mod-host"]);
    for (const p of HOST_PROFILES) expect(shippedHostProfile(p.id)).toBe(p);
    expect(shippedHostProfile("ardour")).toBeUndefined();
  });

  it("openmixer-console IS the in-process lists the console configures — the same arrays, re-exported", () => {
    expect(OPENMIXER_CONSOLE_PROFILE.lv2Features).toBe(OMX_INPROCESS_FEATURES);
    expect(OPENMIXER_CONSOLE_PROFILE.clapExtensions).toBe(OMX_CLAP_HOST_EXTENSIONS);
    expect(hosting.OMX_INPROCESS_FEATURES).toBe(OMX_INPROCESS_FEATURES);
    expect(hosting.OMX_CLAP_HOST_EXTENSIONS).toBe(OMX_CLAP_HOST_EXTENSIONS);
    expect(OPENMIXER_CONSOLE_PROFILE).toMatchObject({ instruments: false, latency: "compensated", isolation: "in-process" });
  });

  it("each budget is the declaration's", () => {
    for (const p of HOST_PROFILES) expect(p.cost).toBe(HOST_BUDGETS[p.id as keyof typeof HOST_BUDGETS]);
  });

  it("jalv and mod-host carry the lists read from their sources, and host no CLAP", () => {
    expect(JALV_LV2_FEATURES).toHaveLength(9); // jalv 1.6.8 src/jalv.c 1316-1325, NULL excluded
    expect(MOD_HOST_LV2_FEATURES).toHaveLength(13); // mod-host f14a230 src/effects.c 2980-2995, HMI excluded
    expect(new Set(JALV_LV2_FEATURES).size).toBe(9);
    expect(new Set(MOD_HOST_LV2_FEATURES).size).toBe(13);
    expect(JALV_PROFILE).toMatchObject({ clapExtensions: null, instruments: true, isolation: "per-process" });
  });
});

describe("readHostProfile — a project's own profile file", () => {
  it("reads every shipped profile back from its JSON unchanged", () => {
    for (const p of HOST_PROFILES) {
      const r = readHostProfile(JSON.parse(JSON.stringify(p)));
      expect(r).toEqual({ ok: true, profile: p });
    }
  });

  it("refuses each missing field by name — no default fills a host in", () => {
    const whole = JSON.parse(JSON.stringify(JALV_PROFILE)) as Record<string, unknown>;
    for (const field of Object.keys(whole)) {
      const { [field]: _gone, ...rest } = whole;
      const r = readHostProfile(rest);
      expect(r.ok, field).toBe(false);
      if (!r.ok) expect(r.problem.startsWith(`${field}:`), r.problem).toBe(true);
    }
  });

  it("refuses a mistyped field", () => {
    const whole = JSON.parse(JSON.stringify(JALV_PROFILE)) as Record<string, unknown>;
    const bad: Record<string, unknown> = {
      isolation: "threaded",
      latency: "maybe",
      instruments: "yes",
      clapExtensions: "clap.log",
      lv2Features: [1],
      cost: { coreFractionCeiling: -1, rate: 48000, quantum: 256 },
    };
    for (const [field, value] of Object.entries(bad)) expect(readHostProfile({ ...whole, [field]: value }).ok, field).toBe(false);
    expect(readHostProfile({ ...whole, cost: { coreFractionCeiling: 0.1, rate: 48000.5, quantum: 256 } }).ok).toBe(false);
    expect(readHostProfile([]).ok).toBe(false);
  });
});
