// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * HOST PROFILES — the host a verdict is judged against, declared. The measurements are profile-free; `classifyPluginHosting` reads one of these to say
 * whether THAT host can run the plugin. A profile names only what differs between hosts; every
 * other rule is the one classifier's.
 */
import { HOST_BUDGETS } from "./qualify-declarations.js";

// The profile's shape and its reader belong to the interchange (a document carries its
// profiles, §3b), whose directory imports nothing from outside itself; they are re-exported here.
export {
  HOST_ISOLATIONS,
  HOST_LATENCY_HANDLING,
  type HostIsolation,
  type HostLatencyHandling,
} from "./measurement/vocabulary.js";
export { readHostProfile, type HostProfile, type HostProfileRead } from "./measurement/format.js";
import type { HostProfile } from "./measurement/format.js";

/**
 * The LV2 features the in-process stage provides — the ONE list (the console's host-backend contract).
 * The verdict judges `required ⊆ provided` against it (as the `openmixer-console` profile), and
 * the console hands the same array to the in-process LV2 table at `omx_host_backend_configure`,
 * which builds one provider per URI and refuses a URI it cannot provide; there is no C copy (the
 * console's native test reads this export).
 *
 * Equal to omx-clap-core's `LV2_CORE_PROVIDED_INIT` (`lv2/core/lv2_core.h`), same URIs in the same
 * order: the original seven, then the three rtmempool URIs (the header's `LV2_RTSAFE_MEMORY_POOL__Pool`,
 * the `#Pool` spelling some TTLs require, and the deprecated v1 URI), the three state-path features,
 * then uri-map and event (omx-clap-core #94).
 */
export const OMX_INPROCESS_FEATURES: readonly string[] = [
  "http://lv2plug.in/ns/ext/urid#map",
  "http://lv2plug.in/ns/ext/urid#unmap",
  "http://lv2plug.in/ns/ext/options#options",
  "http://lv2plug.in/ns/ext/buf-size#boundedBlockLength",
  "http://lv2plug.in/ns/ext/worker#schedule",
  "http://lv2plug.in/ns/ext/state#loadDefaultState",
  "http://lv2plug.in/ns/ext/log#log",
  "http://kxstudio.sf.net/ns/lv2ext/rtmempoolPool",
  "http://kxstudio.sf.net/ns/lv2ext/rtmempool#Pool",
  "http://home.gna.org/lv2dynparam/rtmempool/v1",
  "http://lv2plug.in/ns/ext/state#makePath",
  "http://lv2plug.in/ns/ext/state#mapPath",
  "http://lv2plug.in/ns/ext/state#freePath",
  "http://lv2plug.in/ns/ext/uri-map",
  "http://lv2plug.in/ns/ext/event",
];

/**
 * The CLAP host object's extensions — what the console's control-thread host provides to every
 * instance it hosts (CLAP hosting spec §5), and ALL the qualifier offers, so a plugin that needs
 * more fails `init` headless in qualification and reads `hosting.clap.headless-failed` rather
 * than on the desk. The list's home is the CLAP library — libomx-clap-core's own
 * `clap_host_extensions.h`, what its host object offers — and this is its mirror, held equal to the
 * header at the pinned omx-clap-host (by the console's conformance test), so the verdict never
 * promises more or less than the host provides. Nothing else: no `gui`.
 */
export const OMX_CLAP_HOST_EXTENSIONS: readonly string[] = [
  "clap.log",
  "clap.thread-check",
  "clap.latency",
  "clap.params",
  "clap.audio-ports",
  "clap.state",
  "clap.note-ports",
  "clap.note-name",
  "clap.voice-info",
  "clap.event-registry",
  "clap.timer-support",
  "clap.posix-fd-support",
  "clap.thread-pool",
  "clap.tail",
  "clap.surround/4",
  "clap.ambisonic/3",
  "clap.audio-ports-config",
];

/**
 * The three host extensions omx-clap-host turns on beyond the library's own (omx-clap-core
 * `src/effects.c` `configure_core`: `preset_load`, `track_info`, `remote_controls`), by the ids
 * its host object answers (`src/clap_host.c`); the prober offers them with `--offer`.
 */
export const OMX_CLAP_HOST_CONFIGURED_EXTENSIONS: readonly string[] = [
  "clap.preset-load/2",
  "clap.track-info/1",
  "clap.remote-controls/2",
];

/** The LV2 extension namespace the jalv and mod-host lists are spelled in. */
const LV2_EXT = "http://lv2plug.in/ns/ext/";
const BUF_SIZE_ALL = ["powerOf2BlockLength", "fixedBlockLength", "boundedBlockLength"].map((f) => `${LV2_EXT}buf-size#${f}`);

/**
 * jalv 1.6.8 `src/jalv.c` 123–127 + 1316–1325: the list passed to `lilv_plugin_instantiate`
 * (the zynthian fork, 1.6.9, `src/jalv.c` 1371–1380, passes the identical list).
 */
export const JALV_LV2_FEATURES: readonly string[] = [
  ...["urid#map", "urid#unmap", "worker#schedule", "log#log", "options#options", "state#loadDefaultState"].map((f) => LV2_EXT + f),
  ...BUF_SIZE_ALL,
];

/**
 * mod-host f14a230 `src/effects.c` 254–275 + 2980–2995, without the `__MOD_DEVICES__`-only HMI
 * feature: every feature `effects_add` hands a plugin, in its enum order.
 */
export const MOD_HOST_LV2_FEATURES: readonly string[] = [
  ...["uri-map", "urid#map", "urid#unmap", "options#options"].map((f) => LV2_EXT + f),
  "http://moddevices.com/ns/ext/license#feature",
  ...BUF_SIZE_ALL,
  ...["log#log", "state#freePath", "state#makePath"].map((f) => LV2_EXT + f),
  "http://kx.studio/ns/lv2ext/control-input-port-change-request",
  `${LV2_EXT}worker#schedule`,
];

/** The console's RT thread — exactly the verdict before profiles existed, and the default. */
export const OPENMIXER_CONSOLE_PROFILE: HostProfile = {
  id: "openmixer-console",
  lv2Features: OMX_INPROCESS_FEATURES,
  clapExtensions: OMX_CLAP_HOST_EXTENSIONS,
  instruments: false,
  cost: HOST_BUDGETS["openmixer-console"],
  latency: "compensated",
  isolation: "in-process",
};

/** zynthian's host: one jalv process per plugin, instruments fed, latency published to JACK. */
export const JALV_PROFILE: HostProfile = {
  id: "jalv",
  lv2Features: JALV_LV2_FEATURES,
  clapExtensions: null,
  instruments: true,
  cost: HOST_BUDGETS.jalv,
  latency: "uncompensated",
  isolation: "per-process",
};

/** MOD's host: every plugin of a pedalboard in one shared mod-host process. */
export const MOD_HOST_PROFILE: HostProfile = {
  id: "mod-host",
  lv2Features: MOD_HOST_LV2_FEATURES,
  clapExtensions: null,
  instruments: true,
  cost: HOST_BUDGETS["mod-host"],
  latency: "uncompensated",
  isolation: "shared-process",
};

/**
 * omx-clap-host, alone or as plugin-hostd's CLAP worker: one JACK client per plugin in a host
 * process that several plugins may share (a plugin-hostd pool), instruments fed through each
 * client's `midi_in`, latency published on the JACK ports. Its CLAP host object is the library's
 * plus the three it configures; its LV2 plugins run through the same feature provider as the
 * console's in-process stage.
 */
export const OMX_CLAP_HOST_PROFILE: HostProfile = {
  id: "omx-clap-host",
  lv2Features: OMX_INPROCESS_FEATURES,
  clapExtensions: [...OMX_CLAP_HOST_EXTENSIONS, ...OMX_CLAP_HOST_CONFIGURED_EXTENSIONS],
  instruments: true,
  cost: HOST_BUDGETS["omx-clap-host"],
  latency: "uncompensated",
  isolation: "shared-process",
};

/**
 * A Raspberry Pi with 4 GB, and with 8 GB: what runs a plugin there is omx-clap-host under plugin-hostd, so the same
 * extensions, instruments and isolation, on the rates, quanta and memory of the board. Its memory budget is provisional
 * ({@link HOST_BUDGETS}), so a plugin under it is `conditional` until the numbers are measured on a Pi, and the reason says
 * so. Judged at every cell the board runs.
 */
export const PI_4GB_PROFILE: HostProfile = { ...OMX_CLAP_HOST_PROFILE, id: "openmixer-pi-4gb", cost: HOST_BUDGETS["openmixer-pi-4gb"] };
export const PI_8GB_PROFILE: HostProfile = { ...OMX_CLAP_HOST_PROFILE, id: "openmixer-pi-8gb", cost: HOST_BUDGETS["openmixer-pi-8gb"] };

/** Every profile the tool ships, by id. */
export const HOST_PROFILES: readonly HostProfile[] = [
  OPENMIXER_CONSOLE_PROFILE,
  JALV_PROFILE,
  MOD_HOST_PROFILE,
  OMX_CLAP_HOST_PROFILE,
  PI_4GB_PROFILE,
  PI_8GB_PROFILE,
];

/** A shipped profile by id, or `undefined`. */
export function shippedHostProfile(id: string): HostProfile | undefined {
  return HOST_PROFILES.find((p) => p.id === id);
}
