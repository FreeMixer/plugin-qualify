// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * HOST ADMISSION — a `mod-host` or `jalv` verdict is MEASURED by running the plugin under that host,
 * one admission per plugin, not judged from a declaration. mod-host: `add`, `remove` on
 * its socket, a fresh host after any death (`tools/mod-host-admit.mjs` does the run and prints what
 * happened; one line of JSON). jalv: `jalv -n <name> <uri>` headless, hosted when it is still alive
 * at the deadline. The classifiers here are pure: what the host answered goes in, a {@link HostAdmission}
 * with the deciding code comes out; the runs are injected, so a test replays recorded answers.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { HostProfile } from "./host-profiles.js";

/** The profile ids whose verdict is measured by a run. */
export const ADMITTED_HOSTS = ["mod-host", "jalv"] as const;
export type AdmittedHost = (typeof ADMITTED_HOSTS)[number];

/** The admitting host of a profile, or `undefined` when its verdict is judged from a declaration. */
export function admittedHostOf(profile: HostProfile): AdmittedHost | undefined {
  return ADMITTED_HOSTS.find((h) => h === profile.id);
}

/**
 * plugin-hostd's LV2 adapter, omx-clap-host: an LV2 plugin is run under it once, as under mod-host, and the record
 * carries the outcome as its own step (plugin-qualify#223). The run decides the omx-clap-host verdict of an LV2
 * plugin, the isolated tier, as a mod-host run decides mod-host's; a CLAP plugin's stays the measurement.
 */
export const ADAPTER_HOST = "omx-clap-host";

/** The profiles whose LV2 plugins run under that adapter: omx-clap-host, and the Pi boards it runs on (`host-profiles.ts`). */
export const ADAPTER_RUN_HOSTS: readonly string[] = [ADAPTER_HOST, "openmixer-pi-4gb", "openmixer-pi-8gb"];

/**
 * Whether this run decides the profile's verdict for a plugin of this format. A mod-host or jalv run always does, an
 * unmeasured one making the verdict unknown; the adapter's only when it measured, since the omx-clap-host verdict
 * otherwise stands on the measurement.
 */
export function runDecides(profile: HostProfile, format: string, admission: HostAdmission): boolean {
  return admittedHostOf(profile) !== undefined || (ADAPTER_RUN_HOSTS.includes(profile.id) && format === "lv2" && admission.measured);
}

/** What running the plugin under one host came to. */
export interface HostAdmission {
  readonly host: AdmittedHost | typeof ADAPTER_HOST;
  /** False when the host could not be run (not installed): there is no evidence either way. */
  readonly measured: boolean;
  readonly admitted: boolean;
  /** Why not: `<host>.resp-<n>`, `<host>.signal-<SIG>`, `mod-host.died-on-add`, `jalv.unknown-port-type`, `<host>.not-installed`, … */
  readonly code?: string;
  readonly params: Readonly<Record<string, string | number>>;
}

type ProtocolHost = "mod-host" | typeof ADAPTER_HOST;
const admitted = (host: HostAdmission["host"]): HostAdmission => ({ host, measured: true, admitted: true, params: {} });
const refused = (host: HostAdmission["host"], code: string, params: HostAdmission["params"] = {}): HostAdmission => ({
  host,
  measured: true,
  admitted: false,
  code: `${host}.${code}`,
  params,
});
const notInstalled = (host: HostAdmission["host"]): HostAdmission => ({ host, measured: false, admitted: false, code: `${host}.not-installed`, params: {} });

/** One command mod-host was sent and what came of it: its `resp` number, or how the host died. */
export interface ModHostStep {
  readonly cmd: "add" | "remove";
  readonly resp?: number;
  /** The signal that killed the host, or `exit` / `closed` when it went without one. */
  readonly died?: string;
}

/** What `tools/mod-host-admit.mjs` printed. */
export interface ModHostRun {
  readonly installed: boolean;
  /** False when the host never took a connection (omx-clap-host with no JACK server): no plugin was loaded. */
  readonly started?: boolean;
  readonly steps: readonly ModHostStep[];
}

/** The verdict of a run of a host that speaks mod-host's protocol: the first step that did not answer `resp 0` decides. */
export function classifyProtocolRun(host: ProtocolHost, run: ModHostRun): HostAdmission {
  if (!run.installed) return notInstalled(host);
  // the host never listened, so the plugin was never loaded: nothing was learned about it
  if (run.started === false) return { host, measured: false, admitted: false, code: `${host}.not-started`, params: {} };
  for (const s of run.steps) {
    if (s.died !== undefined) {
      if (s.died.startsWith("SIG")) return refused(host, `signal-${s.died}`, { step: s.cmd });
      return s.cmd === "add" ? refused(host, "died-on-add", { how: s.died }) : refused(host, "died", { step: s.cmd, how: s.died });
    }
    if (s.resp === undefined) return refused(host, "no-answer", { step: s.cmd });
    // the host answers an error as a negative number (`resp -102`); the code carries its magnitude
    if (s.resp < 0) return refused(host, `resp-${-s.resp}`, { step: s.cmd, resp: s.resp });
  }
  if (run.steps.length === 0) return refused(host, "no-answer");
  return admitted(host);
}

/** The verdict of a mod-host run. */
export function classifyModHostRun(run: ModHostRun): HostAdmission {
  return classifyProtocolRun("mod-host", run);
}

/** What `jalv -n <name> <uri>` did in its window. */
export interface JalvRun {
  readonly installed: boolean;
  /** True when jalv was still running at the deadline and was stopped by the caller. */
  readonly stillRunning: boolean;
  readonly status: number | null;
  readonly signal: string | null;
  readonly stderr: string;
}

const UNKNOWN_PORT_TYPE = /Mandatory port "([^"]*)" has unknown type/;

/** The verdict of a jalv run: alive at the deadline is hosted; a signal, an unknown port type, or an exit is not. */
export function classifyJalvRun(run: JalvRun): HostAdmission {
  if (!run.installed) return notInstalled("jalv");
  if (run.stillRunning) return admitted("jalv");
  if (run.signal !== null) return refused("jalv", `signal-${run.signal}`);
  const port = UNKNOWN_PORT_TYPE.exec(run.stderr)?.[1];
  if (port !== undefined) return refused("jalv", "unknown-port-type", { port });
  if (run.status !== 0 && run.status !== null) return refused("jalv", `exit-${run.status}`);
  return admitted("jalv");
}

/** How long jalv must stay alive to count as hosting the plugin, in milliseconds. */
export const JALV_HOSTED_MS = 3000;
/** The wall clock of one whole mod-host admission, in milliseconds. */
export const MOD_HOST_ADMISSION_MS = 30000;

/**
 * The runs of one plugin under the installed hosts. `env` is the environment each host starts with: its `LV2_PATH`
 * must be the device's LV2 directories, the ones the host sees in use (plugin-qualify#224: a mod-host started with no
 * `LV2_PATH` sees only lilv's defaults and answers -101 for a plugin it runs every day).
 */
export interface AdmissionRuns {
  readonly modHost: (uri: string, env?: Readonly<Record<string, string | undefined>>) => ModHostRun;
  readonly jalv: (uri: string, env?: Readonly<Record<string, string | undefined>>) => JalvRun;
  /** The run under plugin-hostd's LV2 adapter; a set without it records no adapter step. */
  readonly adapter?: (uri: string, env?: Readonly<Record<string, string | undefined>>) => ModHostRun;
}

const MOD_HOST_ADMIT = fileURLToPath(new URL("../tools/mod-host-admit.mjs", import.meta.url));

/** The runs against the installed hosts. */
export const SPAWNED_ADMISSIONS: AdmissionRuns = {
  adapter(uri, env) {
    const r = spawnSync(process.execPath, [MOD_HOST_ADMIT, uri, ADAPTER_HOST], { encoding: "utf8", timeout: MOD_HOST_ADMISSION_MS, ...(env === undefined ? {} : { env: { ...env } }) });
    if (r.error !== undefined || r.status !== 0) {
      throw new Error(`${ADAPTER_HOST} admission of ${uri} gave no answer (${r.error?.message ?? `exit ${String(r.status)}`}): ${(r.stderr ?? "").trim()}`);
    }
    return JSON.parse(r.stdout) as ModHostRun;
  },
  modHost(uri, env) {
    const r = spawnSync(process.execPath, [MOD_HOST_ADMIT, uri], { encoding: "utf8", timeout: MOD_HOST_ADMISSION_MS, ...(env === undefined ? {} : { env: { ...env } }) });
    if (r.error !== undefined || r.status !== 0) {
      throw new Error(`mod-host admission of ${uri} gave no answer (${r.error?.message ?? `exit ${String(r.status)}`}): ${(r.stderr ?? "").trim()}`);
    }
    return JSON.parse(r.stdout) as ModHostRun;
  },
  jalv(uri, env) {
    // SIGKILL at the deadline: jalv hosting some plugins ignores SIGTERM, and one stuck in jack_client_open never reaches
    // the loop that reads the flag TERM sets, so a TERM left spawnSync waiting with it (#187). Alive at the deadline is
    // all the verdict asks, so nothing is lost by not letting it exit cleanly.
    const r = spawnSync("jalv", ["-n", "plugin-qualify", uri], { encoding: "utf8", timeout: JALV_HOSTED_MS, killSignal: "SIGKILL", input: "", ...(env === undefined ? {} : { env: { ...env } }) });
    const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return { installed: false, stillRunning: false, status: null, signal: null, stderr: "" };
    return { installed: true, stillRunning: code === "ETIMEDOUT", status: r.status, signal: code === "ETIMEDOUT" ? null : r.signal, stderr: r.stderr ?? "" };
  },
};

/** One admission of `uri` under `host`, the host started with `env` (its `LV2_PATH` the device's LV2 directories). */
export function admitPlugin(
  host: AdmittedHost,
  uri: string,
  runs: AdmissionRuns = SPAWNED_ADMISSIONS,
  env?: Readonly<Record<string, string | undefined>>,
): HostAdmission {
  try {
    return host === "mod-host" ? classifyModHostRun(runs.modHost(uri, env)) : classifyJalvRun(runs.jalv(uri, env));
  } catch (e) {
    // the run itself broke: nothing was learned about the plugin, so nothing is rated
    return { host, measured: false, admitted: false, code: `${host}.admission-failed`, params: { problem: e instanceof Error ? e.message : String(e) } };
  }
}

/** The run of an LV2 plugin under plugin-hostd's LV2 adapter, `undefined` when the runs have none (plugin-qualify#223). */
export function admitUnderAdapter(
  uri: string,
  runs: AdmissionRuns = SPAWNED_ADMISSIONS,
  env?: Readonly<Record<string, string | undefined>>,
): HostAdmission | undefined {
  if (runs.adapter === undefined) return undefined;
  try {
    return classifyProtocolRun(ADAPTER_HOST, runs.adapter(uri, env));
  } catch (e) {
    return { host: ADAPTER_HOST, measured: false, admitted: false, code: `${ADAPTER_HOST}.admission-failed`, params: { problem: e instanceof Error ? e.message : String(e) } };
  }
}
