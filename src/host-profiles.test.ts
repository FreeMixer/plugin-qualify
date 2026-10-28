// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The host profiles as declared: the
 * shipped four, the lists they cite, and the reader a project's own profile file goes through —
 * which refuses a missing or mistyped field rather than filling in a host it was not told about.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HOST_PROFILES,
  JALV_LV2_FEATURES,
  JALV_PROFILE,
  MOD_HOST_LV2_FEATURES,
  OMX_CLAP_HOST_CONFIGURED_EXTENSIONS,
  OMX_CLAP_HOST_EXTENSIONS,
  OMX_CLAP_HOST_PROFILE,
  OMX_INPROCESS_FEATURES,
  OPENMIXER_CONSOLE_PROFILE,
  readHostProfile,
  shippedHostProfile,
} from "./host-profiles.js";
import * as hosting from "./hosting-suitability.js";
import { HOST_BUDGETS } from "./qualify-declarations.js";

describe("the shipped profiles", () => {
  it("are four, by unique id, openmixer-console first", () => {
    expect(HOST_PROFILES.map((p) => p.id)).toEqual(["openmixer-console", "jalv", "mod-host", "omx-clap-host"]);
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

  it("holds the seven plus the eight omx-clap-core #94 added, in the adapter's order", () => {
    // plugin-qualify#118: state paths, the three rtmempool URIs, uri-map and event, after the seven.
    expect(OMX_INPROCESS_FEATURES.slice(0, 7)).toEqual([
      "http://lv2plug.in/ns/ext/urid#map",
      "http://lv2plug.in/ns/ext/urid#unmap",
      "http://lv2plug.in/ns/ext/options#options",
      "http://lv2plug.in/ns/ext/buf-size#boundedBlockLength",
      "http://lv2plug.in/ns/ext/worker#schedule",
      "http://lv2plug.in/ns/ext/state#loadDefaultState",
      "http://lv2plug.in/ns/ext/log#log",
    ]);
    expect(OMX_INPROCESS_FEATURES.slice(7)).toEqual([
      "http://lv2plug.in/ns/ext/state#makePath",
      "http://lv2plug.in/ns/ext/state#mapPath",
      "http://lv2plug.in/ns/ext/state#freePath",
      "http://kxstudio.sf.net/ns/lv2ext/rtmempoolPool",
      "http://home.gna.org/lv2dynparam/rtmempool/v1",
      "http://kxstudio.sf.net/ns/lv2ext/rtmempool#Pool",
      "http://lv2plug.in/ns/ext/uri-map",
      "http://lv2plug.in/ns/ext/event",
    ]);
    expect(OMX_INPROCESS_FEATURES).toHaveLength(15);
    expect(new Set(OMX_INPROCESS_FEATURES).size).toBe(15);
  });
});

describe("OMX_INPROCESS_FEATURES against omx-clap-core's own header", () => {
  // omx-clap-core's own tree: the deps checkout `make -C native deps` fetches (CI), else the installed header
  const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
  const CORE_H = [
    join(PKG, "native", "deps", "omx-clap-core", "lv2", "core", "lv2_core.h"),
    "/usr/include/omx-clap-core/lv2_core.h",
  ].find((p) => existsSync(p));

  it("equals LV2_CORE_PROVIDED_INIT, URI for URI, in order", (ctx) => {
    if (CORE_H === undefined) {
      if (process.env["CI"]) throw new Error("no lv2_core.h: CI fetches it with make -C native deps");
      return ctx.skip("no lv2_core.h: make -C native deps, or install omx-clap-core-devel");
    }
    const init = /#define\s+LV2_CORE_PROVIDED_INIT\s*\{([^}]*)\}/.exec(readFileSync(CORE_H, "utf8"));
    expect(init, CORE_H).not.toBeNull();
    const listed = [...init![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(listed).toEqual(OMX_INPROCESS_FEATURES);
  });
});

describe("omx-clap-host's profile", () => {
  // omx-clap-core's own tree: the deps checkout `make -C native deps` fetches (CI), else the installed header
  const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
  const DEPS = join(PKG, "native", "deps", "omx-clap-core", "src");
  const HEADER = [join(DEPS, "clap_host_extensions.h"), "/usr/include/omx-clap-host/clap_host_extensions.h"].find((p) => existsSync(p));
  const EFFECTS = join(DEPS, "effects.c");

  it("is the console's extensions plus the three omx-clap-host configures, instruments fed", () => {
    expect(OMX_CLAP_HOST_PROFILE.clapExtensions).toEqual([...OMX_CLAP_HOST_EXTENSIONS, ...OMX_CLAP_HOST_CONFIGURED_EXTENSIONS]);
    expect(OMX_CLAP_HOST_PROFILE).toMatchObject({ instruments: true, latency: "uncompensated", isolation: "shared-process" });
    expect(OMX_CLAP_HOST_PROFILE.cost).toBe(HOST_BUDGETS["omx-clap-host"]);
  });

  it("holds the library's host extensions as omx-clap-core's clap_host_extensions.h lists them", (ctx) => {
    if (HEADER === undefined) {
      if (process.env["CI"]) throw new Error("no clap_host_extensions.h: CI fetches it with make -C native deps");
      return ctx.skip("no clap_host_extensions.h: make -C native deps, or install omx-clap-core-devel");
    }
    const init = /#define\s+CLAP_HOST_EXTENSIONS_INIT\s*\{([^}]*)\}/.exec(readFileSync(HEADER, "utf8"));
    expect(init, HEADER).not.toBeNull();
    const listed = [...init![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(listed).toEqual(OMX_CLAP_HOST_EXTENSIONS);
  });

  it("holds the three configured ones as omx-clap-host's configure_core turns them on", (ctx) => {
    if (!existsSync(EFFECTS)) {
      if (process.env["CI"]) throw new Error("no omx-clap-core checkout: CI fetches it with make -C native deps");
      return ctx.skip("no omx-clap-core checkout: make -C native deps");
    }
    const configure = /static int configure_core\(void\)\s*\{([\s\S]*?)\n\}/.exec(readFileSync(EFFECTS, "utf8"));
    expect(configure).not.toBeNull();
    const on = [...configure![1]!.matchAll(/config\.(preset_load|track_info|remote_controls) = 1;/g)].map((m) => m[1]);
    const ids: Record<string, string> = {
      preset_load: "clap.preset-load/2",
      track_info: "clap.track-info/1",
      remote_controls: "clap.remote-controls/2",
    };
    expect(on.map((k) => ids[k!])).toEqual(OMX_CLAP_HOST_CONFIGURED_EXTENSIONS);
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
