// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
import { ORACLE_FLOOR_RATES, RT_HARD_TARGET } from "@openmixer/omx-contract";

/**
 * EVERY NUMBER plugin-qualify uses, declared once. The CLI's defaults and `--help`, the rating, and the Python tools (through the generated
 * `tools/_declarations.py`) all READ these; a consumer holding its own copy is what the package's
 * perturbation test catches (R-094).
 */

/**
 * The reference rate cost is quoted at: the rig's rate, 96 kHz.
 */
export const COST_REFERENCE_RATE = 96000;

/**
 * The reference quantum in frames: the rig's buffer, and the block `benchmark.py` runs.
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

/** The rates a run measures when `--rates` is not given — recorded in `run.rates`: omx-contract's ORACLE_FLOOR_RATES. */
export const QUALIFY_RATES: readonly number[] = ORACLE_FLOOR_RATES;

/** The quanta (frames) a run rates cost at when `--quanta` is not given: the contract's hard-target quantum, then 256, 512 and the reference. */
export const QUALIFY_QUANTA: readonly number[] = [RT_HARD_TARGET.quantum, 256, 512, QUANTUM_FRAMES];

/** Seconds one plugin's offline pass may take before its worker is killed and it reads as a timeout. */
export const PLUGIN_TIMEOUT_S = 15;

/** Seconds the offline worker may take to start (lilv world load on a large LV2_PATH). */
export const BOOT_TIMEOUT_S = 120;

/** Seconds one plugin's cost pass may take (a sustained tone runs longer than an impulse). */
export const COST_TIMEOUT_S = 60;

/**
 * The soak's control sweep is bounded to musically sane ranges (spec §2a.4): a `units:db` port
 * is swept at most this many dB either side of its default, and a strictly-positive-default
 * linear port at most this ratio either side. Calf's linear gains reach 64x (+36 dB); a startup
 * blast the sweep itself drives is not the plugin's. The measuring host reads both from the
 * environment this package sets (`soakSweepEnv`), so the C default and this value cannot differ.
 */
export const SOAK_SWEEP_DB = 12;
export const SOAK_SWEEP_RATIO = 4;

/**
 * A soak's wall-clock limit is SIZED, never fixed (spec §2a): the calibration soak's wall seconds
 * per audio second, times the soak length, times this margin, plus this floor in seconds.
 * 2026-10-01: a fixed 900 s cut ZamGEQ31's 51-minute wall at 192 kHz and read as "died".
 */
export const SOAK_TIMEOUT_MARGIN = 2;
export const SOAK_TIMEOUT_FLOOR_S = 60;

/** Audio seconds the calibration soak renders to measure the host's speed on this plugin and rate. */
export const SOAK_CALIBRATION_S = 30;

/**
 * The ONE setting that locates the CLAP scanner (spec §7): the environment variable that names
 * the `omx-clap-scan` binary, and what is run when it is unset (looked up on `PATH`).
 */
export const CLAP_SCAN_TOOL_ENV = "OMX_CLAP_SCAN";
export const CLAP_SCAN_TOOL_DEFAULT = "omx-clap-scan";

/**
 * The standard CLAP search path `--all` walks, in this order: every directory `CLAP_PATH` names
 * (colon-separated), then `~/.clap`, then `/usr/lib/clap`. The system directory is the same on
 * every distribution and architecture; it is never the library directory (`/usr/lib64`).
 */
export const CLAP_PATH_ENV = "CLAP_PATH";
export const CLAP_USER_DIR = ".clap";
export const CLAP_SYSTEM_DIR = "/usr/lib/clap";

/** Seconds one run of the CLAP scanner may take over everything it was pointed at. */
export const CLAP_SCAN_TIMEOUT_S = 300;

/**
 * The CLAP prober (`native/clap-qualify.c`), the LV2 measurer (`native/lv2-measure.c`), the
 * interposer both run under (`native/rt-interpose.c`) and the LV2 host probe
 * (`native/lv2-host-probe.c`, a worker plugin driven through lilv as a host drives it, for a console
 * that exports an LV2 plugin to test its host-facing half): each located by one environment variable,
 * else the package's own build in `native/build/`, else the first of `NATIVE_TOOL_DIRS` that holds it.
 */
export const CLAP_QUALIFY_TOOL_ENV = "OMX_CLAP_QUALIFY";
export const LV2_MEASURE_TOOL_ENV = "OMX_LV2_MEASURE";
export const RT_INTERPOSE_ENV = "OMX_RT_INTERPOSE";
export const LV2_HOST_PROBE_TOOL_ENV = "OMX_LV2_HOST_PROBE";

/** The file names of the native tools, in every place they are looked for. */
export const CLAP_QUALIFY_TOOL_NAME = "clap-qualify";
export const LV2_MEASURE_TOOL_NAME = "lv2_measure";
export const RT_INTERPOSE_NAME = "rt_interpose.so";
export const LV2_HOST_PROBE_TOOL_NAME = "lv2_host_probe";

/**
 * The ONE list of the native tools the packages install, each with the setting that names it.
 * `make -C native install` installs exactly these; a test holds the Makefile to the list.
 */
export const NATIVE_TOOLS: readonly { readonly name: string; readonly env: string }[] = [
  { name: CLAP_QUALIFY_TOOL_NAME, env: CLAP_QUALIFY_TOOL_ENV },
  { name: LV2_MEASURE_TOOL_NAME, env: LV2_MEASURE_TOOL_ENV },
  { name: RT_INTERPOSE_NAME, env: RT_INTERPOSE_ENV },
  { name: LV2_HOST_PROBE_TOOL_NAME, env: LV2_HOST_PROBE_TOOL_ENV },
];

/**
 * Where the RPM and the DEB install the native tools: the libexec directory on Fedora,
 * `/usr/lib/<package>` on Debian (policy keeps a package's private programs there). The packaging
 * installs into exactly these; a test holds the spec and `debian/rules` to them.
 */
export const NATIVE_TOOL_DIRS: readonly string[] = ["/usr/libexec/plugin-qualify", "/usr/lib/plugin-qualify"];

/** The CLAP sweep: blocks of `CLAP_SWEEP_FRAMES` frames per rate, every parameter moved through events. */
export const CLAP_SWEEP_BLOCKS = 512;
export const CLAP_SWEEP_FRAMES = 512;

/** Seconds one `.clap` may take to qualify at every rate before the prober is killed. */
export const CLAP_QUALIFY_TIMEOUT_S = 120;

/**
 * The LV2 hosting pass (`lv2-measure.mjs`, the native `lv2_measure`): each plugin at the run's highest
 * rate, in blocks of `LV2_HOSTING_BLOCK_FRAMES` frames, `LV2_HOSTING_LIFECYCLES` instantiate/destroy
 * cycles and `LV2_HOSTING_REPEATS` swept RT-safety runs (the worst kept), under the noise stimulus:
 * the figures openmixer's hosting sweep took. One plugin may take `LV2_HOSTING_TIMEOUT_S` seconds.
 */
export const LV2_HOSTING_BLOCK_FRAMES = 512;
export const LV2_HOSTING_LIFECYCLES = 30;
export const LV2_HOSTING_REPEATS = 3;
export const LV2_HOSTING_TIMEOUT_S = 240;




// The rating's thresholds.

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

/** What a host spends on one plugin instance — the
 *  interchange's shape, since a document carries each profile's budget. */
import type { HostBudget } from "./measurement/format.js";
export type { HostBudget };

/**
 * Each shipped host profile's budget, by profile id. `openmixer-console` is §14.2's 5 % per
 * instance at the rig's rate and buffer. `mod-host` runs a whole pedalboard on one JACK thread,
 * so it gets the same per-instance share, at 48 kHz / 128 frames. `jalv` gives each plugin its own
 * process and client, so a quarter core per instance, at 48 kHz / 256 frames. The last two are
 * declared defaults, not a measurement of anyone's board — a project brings its own profile file.
 * `omx-clap-host` runs its plugins one JACK client each, called in turn on the server's one cycle,
 * so it gets mod-host's share and pair.
 */
export const HOST_BUDGETS = {
  "openmixer-console": { coreFractionCeiling: 0.05, rate: COST_REFERENCE_RATE, quantum: QUANTUM_FRAMES },
  jalv: { coreFractionCeiling: 0.25, rate: MEASURE_BASE_RATE, quantum: 256 },
  "mod-host": { coreFractionCeiling: 0.05, rate: MEASURE_BASE_RATE, quantum: 128 },
  "omx-clap-host": { coreFractionCeiling: 0.05, rate: MEASURE_BASE_RATE, quantum: 128 },
} as const satisfies Readonly<Record<string, HostBudget>>;

