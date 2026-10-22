// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The hosting verdict's message codes. Codes, never prose: the surface renders the operator's
 * locale.
 *
 * omx-clap-core declares every hosting code now (the contract split moved `data/hosting/*.json`
 * there, byte for byte): one `HOSTING_<DIMENSION>_CODES` table per dimension, rendered into the
 * TypeScript modules its package installs under `pkg-config --variable=tsdir omx-clap-core`
 * (BUILDING.md) — `omx-clap-core-vocabulary.js` for the dimensions carried from omx-contract,
 * `omx-clap-core-hosting.js` for `hosting.idle.*`, its own (both with a `.d.ts`). {@link
 * HOSTING_CODE} is those tables flattened into one `key: code` map, loaded at import: a code
 * neither module declares cannot be named here, and a dimension either adds arrives without an
 * edit.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The two TypeScript modules omx-clap-core's `tsdir` carries, each a `HOSTING_<DIMENSION>_CODES` source. */
const CLAP_CORE_TS_MODULES = ["omx-clap-core-vocabulary.js", "omx-clap-core-hosting.js"] as const;

/** This package's own root, resolved from this module so it follows wherever it is installed. */
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** `native/fetch-deps.sh`'s own checkout of omx-clap-core, for a build with no omx-clap-core-devel installed. */
const DEPS_TS_DIR = join(PACKAGE_ROOT, "native/deps/omx-clap-core/ts");

/** Where `make install` of omx-clap-host puts them (BUILDING.md), for a run with no `pkg-config` binary at all. */
const DEFAULT_SYSTEM_TS_DIR = "/usr/share/omx-clap-core/ts";

/** `pkg-config --variable=tsdir omx-clap-core`, or `undefined` where pkg-config or the package is absent. */
function pkgConfigTsDir(env: Readonly<Record<string, string | undefined>>): string | undefined {
  try {
    const out = execFileSync(env.PKG_CONFIG ?? "pkg-config", ["--variable=tsdir", "omx-clap-core"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "" ? undefined : out;
  } catch {
    return undefined;
  }
}

/**
 * Where omx-clap-core's TypeScript modules are looked for, in order: `OMX_CLAP_CORE_TSDIR` when
 * set (and only that), else `pkg-config --variable=tsdir omx-clap-core`, else the checkout
 * `native/fetch-deps.sh` stages, else the path `make install` of omx-clap-host uses by default —
 * a packaged plugin-qualify's runtime has no `pkg-config` binary to ask.
 */
export function clapCoreTsDirCandidates(env: Readonly<Record<string, string | undefined>> = process.env): readonly string[] {
  const set = env.OMX_CLAP_CORE_TSDIR;
  if (set !== undefined && set !== "") return [set];
  const fromPkgConfig = pkgConfigTsDir(env);
  return [...(fromPkgConfig === undefined ? [] : [fromPkgConfig]), DEPS_TS_DIR, DEFAULT_SYSTEM_TS_DIR];
}

function locateClapCoreTsDir(): string {
  const candidates = clapCoreTsDirCandidates();
  const dir = candidates.find((d) => CLAP_CORE_TS_MODULES.every((m) => existsSync(join(d, m))));
  if (dir === undefined) {
    throw new Error(
      `omx-clap-core's TypeScript modules (${CLAP_CORE_TS_MODULES.join(", ")}) were not found in any of: ` +
        `${candidates.join(", ")}. Install omx-clap-core-devel (pkg-config omx-clap-core), set ` +
        "OMX_CLAP_CORE_TSDIR to its tsdir, or run native/fetch-deps.sh.",
    );
  }
  return dir;
}

/** True for an export name that is one of omx-clap-core's hosting tables. */
export function isHostingTableName(name: string): boolean {
  return /^HOSTING_[A-Z0-9_]+_CODES$/.test(name);
}

type HostingEntries = Record<string, { readonly code: string }>;

async function loadHostingTables(): Promise<Record<string, HostingEntries>> {
  const dir = locateClapCoreTsDir();
  const tables: Record<string, HostingEntries> = {};
  for (const name of CLAP_CORE_TS_MODULES) {
    // The modules are self-contained ES modules in a directory with no package.json: Node 18 reads such a .js as
    // CommonJS and refuses `export`, so the source is imported as a data: module, which is a module on every Node.
    const source = readFileSync(join(dir, name), "utf8");
    const mod: Record<string, unknown> = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    for (const [exportName, table] of Object.entries(mod)) {
      if (isHostingTableName(exportName)) tables[exportName] = table as HostingEntries;
    }
  }
  return tables;
}

function flatten(tables: Record<string, HostingEntries>): HostingCodeTable {
  const table: Record<string, string> = {};
  for (const [name, entries] of Object.entries(tables)) {
    for (const [key, entry] of Object.entries(entries)) {
      if (key in table) throw new Error(`omx-clap-core declares the hosting key ${key} twice (${name})`);
      table[key] = entry.code;
    }
  }
  return Object.freeze(table) as unknown as HostingCodeTable;
}

/**
 * omx-clap-core's hosting codes, by key, across its two TypeScript modules — hand-kept here
 * (not derived from a static import: the source is a runtime-resolved install directory, not an
 * npm dependency) and held to the real modules by
 * `src/contract-vocabulary-conformance.test.ts`, which turns red on any drift either way.
 */
export interface HostingCodeTable {
  readonly clapExtensionsNotCovered: "hosting.clap.extensions-not-covered";
  readonly clapFormatNotHosted: "hosting.clap.format-not-hosted";
  readonly clapHeadlessFailed: "hosting.clap.headless-failed";
  readonly clapLatencyMismatch: "hosting.clap.latency-mismatch";
  readonly clapNoteInput: "hosting.clap.note-input";
  readonly clapProcessError: "hosting.clap.process-error";
  readonly clapThreadViolation: "hosting.clap.thread-violation";
  readonly clapUnqualified: "hosting.clap.unqualified";
  readonly costAboveCeiling: "hosting.cost.above-ceiling";
  readonly costFieldsMissing: "hosting.cost.fields-missing";
  readonly costSpiky: "hosting.cost.spiky-tail";
  readonly costUnmeasured: "hosting.cost.unmeasured-at-rate-and-quantum";
  readonly costWithinCeiling: "hosting.cost.within-ceiling";
  readonly featuresAtomInUnfed: "hosting.features.atom-in-unfed";
  readonly featuresDisqualifying: "hosting.features.host-not-provided";
  readonly featuresMidiIn: "hosting.features.midi-in-fed-empty";
  readonly featuresMissing: "hosting.features.missing";
  readonly featuresPortsUnreadable: "hosting.features.ports-unreadable";
  readonly featuresProvided: "hosting.features.all-provided";
  readonly featuresUnscanned: "hosting.features.scan-predates-field";
  readonly idleHoldRefused: "hosting.idle.hold-refused";
  readonly latencyNonconforming: "hosting.latency.nonconforming";
  readonly latencyParameterDependent: "hosting.latency.parameter-dependent";
  readonly latencyResolved: "hosting.latency.resolved";
  readonly latencyUnmeasured: "hosting.latency.unmeasured";
  readonly outputNonFinite: "hosting.output.non-finite";
  readonly overrideIsolated: "hosting.override.curator-isolated";
  readonly patchBusy: "hosting.patch.busy";
  readonly patchNotWritable: "hosting.patch.not-writable";
  readonly patchTooLarge: "hosting.patch.too-large";
  readonly presetNotFound: "hosting.preset.not-found";
  readonly hostProvenanceDiffers: "hosting.provenance.host-differs";
  readonly sweepControlDidNotFire: "hosting.provenance.sweep-control-did-not-fire";
  readonly disabled: "hosting.disabled";
  readonly linked: "hosting.linked";
  readonly noRealisation: "hosting.no-realisation";
  readonly realisedInProcess: "hosting.realised.in-process";
  readonly unjudged: "hosting.unjudged";
  readonly rtSafetyClean: "hosting.rt-safety.clean-under-sweep";
  readonly rtSafetyNotReproducible: "hosting.rt-safety.not-reproducible";
  readonly rtSafetyNotesClean: "hosting.rt-safety.clean-under-notes";
  readonly rtSafetyNotesUnmeasured: "hosting.rt-safety.notes-unmeasured";
  readonly rtSafetyNotesViolations: "hosting.rt-safety.violations-under-notes";
  readonly rtSafetyUnmeasured: "hosting.rt-safety.unmeasured";
  readonly rtSafetyViolations: "hosting.rt-safety.violations-in-run";
  readonly stabilityBelowFloor: "hosting.stability.cycles-below-floor";
  readonly stabilityCrashUnattributed: "hosting.stability.crash-unattributed";
  readonly stabilityCrashedAttributed: "hosting.stability.crashed-attributed-plugin";
  readonly stabilityCrashedLive: "hosting.stability.crashed-live-on-this-rig";
  readonly stabilityLinksGuiToolkit: "hosting.stability.links-gui-toolkit";
  readonly stabilitySoakFailedAtRate: "hosting.stability.soak-failed-at-rate";
  readonly stabilitySoaked: "hosting.stability.soaked";
  readonly stabilitySpawnsThreads: "hosting.stability.spawns-threads";
  readonly stabilityUnmeasured: "hosting.stability.unmeasured";
  readonly stabilityUnsoaked: "hosting.stability.unsoaked";
  readonly stateNotACopy: "hosting.state.not-a-copy";
  readonly statePathOnAudio: "hosting.state.path-on-audio";
  readonly statePathOutside: "hosting.state.path-outside";
  readonly statePathSymlink: "hosting.state.path-symlink";
  readonly statePathTooLong: "hosting.state.path-too-long";
  readonly statePathUnmakeable: "hosting.state.path-unmakeable";
  readonly stateUnreadable: "hosting.state.unreadable";
  readonly topologyAmbisonicConfig: "hosting.topology.ambisonic-config";
  readonly topologyChannelMapUnknown: "hosting.topology.channel-map-unknown";
  readonly topologyInstrument: "hosting.topology.instrument";
  readonly topologyMatched: "hosting.topology.matched";
  readonly topologyNoAudioInput: "hosting.topology.no-audio-input";
  readonly topologyNoAudioOutput: "hosting.topology.no-audio-output";
  readonly topologyPortTooWide: "hosting.topology.port-too-wide";
  readonly topologyPortWithoutChannels: "hosting.topology.port-without-channels";
  readonly topologyTooManyPorts: "hosting.topology.too-many-ports";
  readonly topologyWiderThanStrip: "hosting.topology.wider-than-strip";
  readonly workerNonconforming: "hosting.worker.nonconforming";
}

export const HOSTING_CODE: HostingCodeTable = flatten(await loadHostingTables());
