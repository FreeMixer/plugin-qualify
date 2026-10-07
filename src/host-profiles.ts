// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * HOST PROFILES — the host a verdict is judged against, declared (`docs/design/specs/2026-09-25-plugin-qualify.md`
 * §3a). The measurements are profile-free; `classifyPluginHosting` reads one of these to say
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
 * The LV2 features the in-process stage provides — the ONE list (host-backend-one-contract §3).
 * The verdict judges `required ⊆ provided` against it (as the `openmixer-console` profile), and
 * the console hands the same array to the in-process LV2 table at `omx_host_backend_configure`,
 * which builds one provider per URI and refuses a URI it cannot provide; there is no C copy (the
 * native test reads this export through `packages/pipewire-native/tools/lv2-inprocess-features.sh`).
 */
export const OMX_INPROCESS_FEATURES: readonly string[] = [
  "http://lv2plug.in/ns/ext/urid#map",
  "http://lv2plug.in/ns/ext/urid#unmap",
  "http://lv2plug.in/ns/ext/options#options",
  "http://lv2plug.in/ns/ext/buf-size#boundedBlockLength",
  "http://lv2plug.in/ns/ext/worker#schedule",
  "http://lv2plug.in/ns/ext/state#loadDefaultState",
  "http://lv2plug.in/ns/ext/log#log",
];

/**
 * The CLAP host object's extensions — what the console's control-thread host provides to every
 * instance it hosts (CLAP hosting spec §5), and ALL the qualifier offers, so a plugin that needs
 * more fails `init` headless in qualification and reads `hosting.clap.headless-failed` rather
 * than on the desk. Rendered into `omx_contract_limits.h` (`OMX_CLAP_HOST_EXTENSIONS_INIT`) so
 * the C host reads the one list and can never provide less than the verdict promised. Nothing
 * else: no `gui`, no `timer-support`, no `posix-fd-support`, no `thread-pool`.
 */
export const OMX_CLAP_HOST_EXTENSIONS: readonly string[] = [
  "clap.log",
  "clap.thread-check",
  "clap.latency",
  "clap.params",
  "clap.audio-ports",
  "clap.state",
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

/** Every profile the tool ships, by id. */
export const HOST_PROFILES: readonly HostProfile[] = [OPENMIXER_CONSOLE_PROFILE, JALV_PROFILE, MOD_HOST_PROFILE];

/** A shipped profile by id, or `undefined`. */
export function shippedHostProfile(id: string): HostProfile | undefined {
  return HOST_PROFILES.find((p) => p.id === id);
}
