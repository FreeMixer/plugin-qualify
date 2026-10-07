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
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

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
