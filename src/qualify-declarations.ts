// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * EVERY NUMBER plugin-qualify uses, declared once (`docs/design/specs/2026-09-25-plugin-qualify.md`
 * §4). The CLI's defaults and `--help`, the rating, and the Python tools (through the generated
 * `tools/_declarations.py`) all READ these; a consumer holding its own copy is what the package's
 * perturbation test catches (R-094).
 */

/**
 * The reference rate cost is quoted at: the rig's rate (2026-09-14 ruling, 96 kHz). Moved here
 * from `@freemixer/catalog`'s `cpu-cost.ts`, which re-exports it.
 */
export const COST_REFERENCE_RATE = 96000;

/**
 * The reference quantum in frames: the rig's buffer, and the block `benchmark.py` runs.
 * Moved here from `@freemixer/catalog`'s `types.ts`, which re-exports it.
 */
export const QUANTUM_FRAMES = 1024;

/** The rate the offline capture window is sized at; other rates scale from it. */
export const MEASURE_BASE_RATE = 48000;

/**
 * The lowest rate the console runs a show at. A reading below it is informational for the scaling
 * class: kept in `perRate` and served at its own rate, but never alone enough to flag a plugin
 * `nonconforming` (`lv2-measurement-interchange.md` §1a).
 */
export const OPERATIONAL_RATE_FLOOR = 48000;

/** The rates a run measures when `--rates` is not given — recorded in `run.rates`. */
export const QUALIFY_RATES: readonly number[] = [44100, MEASURE_BASE_RATE, COST_REFERENCE_RATE, 192000];

/** The quanta (frames) a run rates cost at when `--quanta` is not given. */
export const QUALIFY_QUANTA: readonly number[] = [128, 256, 512, QUANTUM_FRAMES];

/** Seconds one plugin's offline pass may take before its worker is killed and it reads as a timeout. */
export const PLUGIN_TIMEOUT_S = 15;

/** Seconds the offline worker may take to start (lilv world load on a large LV2_PATH). */
export const BOOT_TIMEOUT_S = 120;

/** Seconds one plugin's cost pass may take (a sustained tone runs longer than an impulse). */
export const COST_TIMEOUT_S = 60;

/**
 * The ONE setting that locates the CLAP scanner (spec §7): the environment variable that names
 * the `omx-clap-scan` binary, and what is run when it is unset (looked up on `PATH`).
 */
export const CLAP_SCAN_TOOL_ENV = "OMX_CLAP_SCAN";
export const CLAP_SCAN_TOOL_DEFAULT = "omx-clap-scan";

/** Seconds one run of the CLAP scanner may take over everything it was pointed at. */
export const CLAP_SCAN_TIMEOUT_S = 300;




// The rating's thresholds (`2026-09-04-lv2-hosting-path.md` §3), moved here from
// `@freemixer/catalog`'s `hosting-suitability.ts`.

/** Every threshold, so none is baked into the code. */
export interface HostingPolicy {
  /** Minimum instantiate/destroy lifecycles. The operator's §14.4 ruling: 1000. */
  readonly cycleFloor: number;
  /** Minimum continuous soak, seconds. Default 3 h — the operator's longest show. */
  readonly soakSeconds: number;
  /** Above this ratio a plugin is spiky: in-process a spike is the whole desk's xrun. */
  readonly costTailRatioCeiling: number;
  /** A soak rate whose settled output sits this far under the plugin's own best rate is
   *  dead there. A ratio against the plugin itself, never an absolute floor. */
  readonly soakDeadDropDb: number;
  /** The host string the shipped figures were taken on, when the console knows its own. */
  readonly hostProvenance?: string;
}

/**
 * Defaults. The cycle floor is the operator's ruling of 2026-09-05 (§14.4, option c) and the
 * soak is §3's default show length. The per-instance cost ceiling is the HOST's budget and
 * lives in {@link HOST_BUDGETS} (plugin-qualify §3a), not here.
 */
export const DEFAULT_HOSTING_POLICY: HostingPolicy = {
  cycleFloor: 1000,
  soakSeconds: 3 * 60 * 60,
  costTailRatioCeiling: 4,
  soakDeadDropDb: 40,
};

/** What a host spends on one plugin instance (`2026-09-25-plugin-qualify.md` §3a) — the
 *  interchange's shape, since a document carries each profile's budget. */
import type { HostBudget } from "./measurement/format.js";
export type { HostBudget };

/**
 * Each shipped host profile's budget, by profile id. `openmixer-console` is §14.2's 5 % per
 * instance at the rig's rate and buffer. `mod-host` runs a whole pedalboard on one JACK thread,
 * so it gets the same per-instance share, at 48 kHz / 128 frames. `jalv` gives each plugin its own
 * process and client, so a quarter core per instance, at 48 kHz / 256 frames. The last two are
 * declared defaults, not a measurement of anyone's board — a project brings its own profile file.
 */
export const HOST_BUDGETS = {
  "openmixer-console": { coreFractionCeiling: 0.05, rate: COST_REFERENCE_RATE, quantum: QUANTUM_FRAMES },
  jalv: { coreFractionCeiling: 0.25, rate: MEASURE_BASE_RATE, quantum: 256 },
  "mod-host": { coreFractionCeiling: 0.05, rate: MEASURE_BASE_RATE, quantum: 128 },
} as const satisfies Readonly<Record<string, HostBudget>>;

