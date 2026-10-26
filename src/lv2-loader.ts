// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The LV2 implementation of the one discovery seam (`loader.ts`, spec §7). A target that names an
 * existing directory is a bundle: every subject its `manifest.ttl` declares `a lv2:Plugin` is a
 * plugin, with its `lv2:binary` basename. Anything else shaped like a URI (`scheme:rest`) is one
 * plugin. A path that does not exist is not this loader's — the CLI refuses it by name.
 *
 * The manifest read is the subset every LV2 bundle's manifest uses (subject, `a lv2:Plugin`,
 * `lv2:binary <x.so>`), not a Turtle parser; `--all` goes through lilv itself.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import type { PluginLoader, PluginTarget } from "./loader.js";

const URI_SHAPE = /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/;

/** The plugins a bundle manifest declares: one statement per subject, `;`-separated predicates. */
export function pluginsInManifest(ttl: string): { uri: string; binary?: string }[] {
  const body = ttl.replace(/#[^\n>]*$/gm, "");
  const out: { uri: string; binary?: string }[] = [];
  const statement = /<([^>]+)>\s+((?:[^.<"]|<[^>]*>|"[^"]*")*)\./g;
  for (let m = statement.exec(body); m !== null; m = statement.exec(body)) {
    const [, subject, predicates] = m;
    if (subject === undefined || predicates === undefined) continue;
    if (!/(^|;)\s*a\s+lv2:Plugin\b/.test(predicates)) continue;
    const bin = /lv2:binary\s+<([^>]+)>/.exec(predicates)?.[1];
    out.push(bin === undefined ? { uri: subject } : { uri: subject, binary: basename(bin) });
  }
  return out;
}

export const lv2Loader: PluginLoader = {
  format: "lv2",
  resolve(target: string): readonly PluginTarget[] | undefined {
    if (existsSync(target) && statSync(target).isDirectory()) {
      const manifest = join(target, "manifest.ttl");
      if (!existsSync(manifest)) return [];
      return pluginsInManifest(readFileSync(manifest, "utf8")).map((p) => ({
        format: "lv2",
        uri: p.uri,
        bundle: target,
        ...(p.binary === undefined ? {} : { binary: p.binary }),
      }));
    }
    if (target.includes("/") || target.endsWith(".lv2")) return undefined; // a path that is not there
    return URI_SHAPE.test(target) ? [{ format: "lv2", uri: target }] : undefined;
  },
};

/** lilv's default LV2 search path, used when `LV2_PATH` is unset. */
const LV2_DEFAULT_DIRS = [".lv2", "/usr/lib/lv2", "/usr/lib64/lv2", "/usr/local/lib/lv2", "/usr/local/lib64/lv2"];

/**
 * Every `.lv2` bundle directly under the LV2 search path (`LV2_PATH`, else lilv's defaults). An
 * absent directory holds none; any other fs error propagates for the caller to name. A bundle is
 * a directory holding `manifest.ttl`: a dangling `.lv2` symlink or a plain `.lv2` file is not one.
 */
export function lv2BundlesOnPath(env: Readonly<Record<string, string | undefined>>, home: string = homedir()): string[] {
  const named = (env["LV2_PATH"] ?? "").split(":").filter((d) => d !== "");
  const dirs = named.length > 0 ? named : LV2_DEFAULT_DIRS.map((d) => (d.startsWith("/") ? d : join(home, d)));
  const bundles: string[] = [];
  for (const dir of new Set(dirs.map((d) => resolve(d)))) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw e;
    }
    for (const n of names.sort()) {
      if (!n.endsWith(".lv2")) continue;
      const path = join(dir, n);
      let isBundle: boolean;
      try {
        isBundle = statSync(path).isDirectory() && existsSync(join(path, "manifest.ttl"));
      } catch {
        isBundle = false; // a dangling symlink
      }
      if (isBundle) bundles.push(path);
    }
  }
  return bundles;
}
