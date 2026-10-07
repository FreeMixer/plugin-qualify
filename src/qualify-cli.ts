// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The `plugin-qualify` CLI's decisions, as pure functions (`docs/design/specs/2026-09-25-plugin-qualify.md`
 * §5): parse the arguments against `QUALIFY_OPTIONS`, print `--help` from the same table, resolve
 * the named targets through the loader seam, turn each plugin's measurements into
 * `classifyPluginHosting`'s verdict (never a second one), and pick the exit code.
 * `bin/plugin-qualify.mjs` only spawns the measuring tools and calls these.
 */
import { readFileSync } from "node:fs";
import { QUALIFY_QUANTA, QUALIFY_RATES } from "./qualify-declarations.js";
import { OPENMIXER_CONSOLE_PROFILE, readHostProfile, shippedHostProfile, type HostProfile } from "./host-profiles.js";
import {
  buildMeasurementDocument,
  type DocumentVerdict,
  type MeasuredPlugin,
  type MeasurementDocument,
  type MeasurementRun,
} from "./measurement/format.js";
import { classifyPluginHosting, type QualifiedPlugin } from "./hosting-suitability.js";
import type { SuitabilityRating } from "./rating.js";
import type { PluginLoader, PluginTarget } from "./loader.js";
import { EXIT_CODE, OUTPUT_FORMATS, QUALIFY_OPTIONS, type OutputFormat } from "./qualify-options.js";

export interface QualifyArgs {
  readonly all: boolean;
  readonly targets: readonly string[];
  readonly rates: readonly number[];
  readonly quanta: readonly number[];
  readonly out?: string;
  readonly format: OutputFormat;
  readonly isolate: boolean;
  readonly hostSweep: boolean;
  /** `--host-profile` specs (a shipped id or a profile file), in order, once each. */
  readonly hostProfiles: readonly string[];
  readonly help: boolean;
}

export type ParseResult = { ok: true; args: QualifyArgs } | { ok: false; error: string };

function defaultOf(flag: string): string {
  const d = QUALIFY_OPTIONS.find((o) => o.flag === flag)?.default;
  if (d === undefined) throw new Error(`${flag} declares no default`);
  return d;
}

function numberList(text: string | undefined): number[] | undefined {
  if (text === undefined || text === "") return undefined;
  const out = [...new Set(text.split(",").map((t) => Number(t.trim())))];
  return out.every((n) => Number.isInteger(n) && n > 0) ? out.sort((a, b) => a - b) : undefined;
}

export function parseQualifyArgs(argv: readonly string[]): ParseResult {
  const known = new Set(QUALIFY_OPTIONS.map((o) => o.flag));
  const takesValue = new Set(QUALIFY_OPTIONS.filter((o) => o.value !== undefined).map((o) => o.flag));
  const seen = new Map<string, string | true>();
  const targets: string[] = [];
  // The one option that repeats: every host asked about is a verdict of its own.
  const profileSpecs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      targets.push(a);
      continue;
    }
    if (!known.has(a)) return { ok: false, error: `unknown option ${a}` };
    if (takesValue.has(a)) {
      const v = argv[++i];
      if (v === undefined) return { ok: false, error: `${a} needs a value` };
      if (a === "--host-profile") profileSpecs.push(...v.split(",").map((t) => t.trim()).filter((t) => t !== ""));
      seen.set(a, v);
    } else seen.set(a, true);
  }
  const help = seen.has("--help");
  const all = seen.has("--all");
  if (!help && all && targets.length > 0) return { ok: false, error: "--all takes no plugin targets" };
  if (!help && !all && targets.length === 0) return { ok: false, error: "name a plugin (URI or .lv2 bundle) or pass --all" };
  const rates = numberList((seen.get("--rates") as string | undefined) ?? defaultOf("--rates"));
  if (rates === undefined) return { ok: false, error: "--rates must be positive integers, comma-separated" };
  const quanta = numberList((seen.get("--quanta") as string | undefined) ?? defaultOf("--quanta"));
  if (quanta === undefined) return { ok: false, error: "--quanta must be positive integers, comma-separated" };
  const format = (seen.get("--format") as string | undefined) ?? defaultOf("--format");
  if (!(OUTPUT_FORMATS as readonly string[]).includes(format)) {
    return { ok: false, error: `--format must be one of ${OUTPUT_FORMATS.join(", ")}` };
  }
  const out = seen.get("--out") as string | undefined;
  const hostProfiles = [...new Set(profileSpecs.length > 0 ? profileSpecs : [defaultOf("--host-profile")])];
  return {
    ok: true,
    args: {
      all,
      targets,
      rates,
      quanta,
      ...(out === undefined ? {} : { out }),
      format: format as OutputFormat,
      isolate: seen.has("--isolate"),
      hostSweep: !seen.has("--no-host-sweep"),
      hostProfiles,
      help,
    },
  };
}

export function helpText(): string {
  const rows = QUALIFY_OPTIONS.map((o) => {
    const left = o.value === undefined ? o.flag : `${o.flag} <${o.value}>`;
    const def = o.default === undefined ? "" : ` (default: ${o.default})`;
    return `  ${left.padEnd(28)}${o.describe}${def}`;
  });
  return [
    "plugin-qualify — qualify audio plugins for real-time hosting",
    "",
    "  plugin-qualify <uri|bundle-path>...   exactly the named plugins; a .lv2 bundle = every plugin in it",
    "  plugin-qualify --all                  every plugin lilv finds (LV2_PATH honoured)",
    "",
    ...rows,
    "",
    `exit ${EXIT_CODE.allQualified} all qualified / ${EXIT_CODE.someNotQualified} some not / ${EXIT_CODE.couldNotMeasure} could not measure`,
    `defaults are declarations: rates ${QUALIFY_RATES.join(",")}, quanta ${QUALIFY_QUANTA.join(",")}`,
    "",
  ].join("\n");
}

export type ResolveResult =
  | { ok: true; plugins: readonly PluginTarget[] }
  | { ok: false; refused: readonly string[] };

/** Every target through the loaders; a target no loader claims, or one naming no plugin, is refused. */
export function resolveTargets(targets: readonly string[], loaders: readonly PluginLoader[]): ResolveResult {
  const plugins = new Map<string, PluginTarget>();
  const refused: string[] = [];
  for (const t of targets) {
    let found: readonly PluginTarget[] | undefined;
    for (const l of loaders) {
      found = l.resolve(t);
      if (found !== undefined) break;
    }
    if (found === undefined || found.length === 0) {
      refused.push(t);
      continue;
    }
    for (const p of found) {
      const prior = plugins.get(p.uri);
      // A URI and its bundle name the same plugin: keep the richer record (bundle, binary).
      if (prior === undefined || (prior.binary === undefined && p.binary !== undefined)) plugins.set(p.uri, p);
    }
  }
  return refused.length > 0 ? { ok: false, refused } : { ok: true, plugins: [...plugins.values()] };
}

export type HostProfilesResult =
  | { ok: true; profiles: readonly HostProfile[] }
  | { ok: false; refused: readonly { spec: string; problem: string }[] };

/** Read a profile file as JSON; `undefined` when it cannot be read or parsed. */
function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Every `--host-profile` spec to a profile: a shipped id, else a profile file read through
 * `readHostProfile`. An id nobody ships and no readable file names, a file the reader refuses, or
 * two specs naming one id are refused — never judged against a default.
 */
export function resolveHostProfiles(
  specs: readonly string[],
  readJson: (path: string) => unknown = readJsonFile,
): HostProfilesResult {
  const profiles: HostProfile[] = [];
  const refused: { spec: string; problem: string }[] = [];
  for (const spec of specs) {
    const shipped = shippedHostProfile(spec);
    let profile: HostProfile | undefined = shipped;
    if (profile === undefined) {
      const json = readJson(spec);
      if (json === undefined) {
        refused.push({ spec, problem: "no shipped profile has this id, and no readable JSON file is at this path" });
        continue;
      }
      const r = readHostProfile(json);
      if (!r.ok) {
        refused.push({ spec, problem: r.problem });
        continue;
      }
      profile = r.profile;
    }
    if (profiles.some((p) => p.id === profile.id)) {
      refused.push({ spec, problem: `a second profile with id ${profile.id}` });
      continue;
    }
    profiles.push(profile);
  }
  return refused.length > 0 ? { ok: false, refused } : { ok: true, profiles };
}

export interface QualifyVerdict {
  readonly uri: string;
  /** The id of the host profile this verdict was judged against. */
  readonly host: string;
  /** False when nothing about the plugin was measured at all. */
  readonly measured: boolean;
  readonly rating: SuitabilityRating;
  /** `rating === "suitable"` — the only meaning `qualified` has. */
  readonly qualified: boolean;
  /** The code of the reason that decided it (absent for `suitable`). */
  readonly deciding?: string;
}

/**
 * The verdict of each plugin under each host profile: `classifyPluginHosting`'s rating and
 * deciding reason, nothing more. Each profile is judged at the live `rate`/`quantum` when the
 * caller names them, else at the profile's own declared budget pair.
 */
export function qualifyPlugins(
  measured: readonly { target: PluginTarget; plugin?: QualifiedPlugin }[],
  options: { rate?: number; quantum?: number; profiles?: readonly HostProfile[] },
): QualifyVerdict[] {
  const profiles = options.profiles ?? [OPENMIXER_CONSOLE_PROFILE];
  return measured.flatMap(({ target, plugin }) =>
    profiles.map((profile): QualifyVerdict => {
      if (plugin === undefined) {
        return { uri: target.uri, host: profile.id, measured: false, rating: "unknown", qualified: false, deciding: "not-measured" };
      }
      const live = options.rate !== undefined;
      const quantum = live ? options.quantum : profile.cost.quantum;
      const v = classifyPluginHosting(plugin, {
        rate: options.rate ?? profile.cost.rate,
        ...(quantum === undefined ? {} : { quantum }),
        ...(target.binary === undefined ? {} : { pluginBinary: target.binary }),
        profile,
      });
      return {
        uri: target.uri,
        host: profile.id,
        measured: true,
        rating: v.rating,
        qualified: v.rating === "suitable",
        ...(v.deciding === undefined ? {} : { deciding: v.deciding.code }),
      };
    }),
  );
}

/** The run's interchange document (v1.2, §6): the raw plugin blocks, the profiles judged against, and the verdicts. */
export function judgedDocument(
  run: MeasurementRun,
  plugins: readonly MeasuredPlugin[],
  profiles: readonly HostProfile[],
  verdicts: readonly QualifyVerdict[],
): MeasurementDocument {
  const written: DocumentVerdict[] = verdicts.map((v) => ({
    uri: v.uri,
    host: v.host,
    rating: v.rating,
    qualified: v.qualified,
    ...(v.deciding === undefined ? {} : { deciding: v.deciding }),
  }));
  return buildMeasurementDocument(run, plugins, { hostProfiles: profiles, verdicts: written });
}

export function exitCodeFor(verdicts: readonly QualifyVerdict[]): number {
  if (verdicts.length === 0 || verdicts.some((v) => !v.measured)) return EXIT_CODE.couldNotMeasure;
  return verdicts.every((v) => v.qualified) ? EXIT_CODE.allQualified : EXIT_CODE.someNotQualified;
}

/** Plain words: plugin, verdict, the reason that decided it, the host it was judged for. */
export function textTable(verdicts: readonly QualifyVerdict[]): string {
  const w = Math.max("plugin".length, ...verdicts.map((v) => v.uri.length));
  const r = Math.max("reason".length, ...verdicts.map((v) => (v.deciding ?? "-").length));
  const head = `${"plugin".padEnd(w)}  ${"verdict".padEnd(11)}  ${"reason".padEnd(r)}  host`;
  const rows = verdicts.map((v) => `${v.uri.padEnd(w)}  ${v.rating.padEnd(11)}  ${(v.deciding ?? "-").padEnd(r)}  ${v.host}`);
  return [head, ...rows, ""].join("\n");
}
