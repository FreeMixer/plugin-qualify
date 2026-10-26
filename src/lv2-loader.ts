// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The LV2 implementation of the one discovery seam (`loader.ts`, spec §7). A target that names an
 * existing directory is a bundle: every subject its `manifest.ttl` declares `a lv2:Plugin` is a
 * plugin, with its `lv2:binary` basename. Anything else shaped like a URI (`scheme:rest`) is one
 * plugin. A path that does not exist is not this loader's — the CLI refuses it by name.
 *
 * The manifest is read as plugin-hostd reads it to pin a plugin: statements of IRIs and prefixed names, with blank
 * nodes and collections stepped over, not a whole Turtle parser. A plugin is a subject typed `lv2:Plugin`; its files
 * are the ones the manifest names for it with `lv2:binary` or `rdfs:seeAlso`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import type { PluginLoader, PluginTarget } from "./loader.js";

const URI_SHAPE = /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/;

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const LV2_PLUGIN = "http://lv2plug.in/ns/lv2core#Plugin";
const LV2_BINARY = "http://lv2plug.in/ns/lv2core#binary";
const RDFS_SEE_ALSO = "http://www.w3.org/2000/01/rdf-schema#seeAlso";

type Token = { readonly kind: "iri" | "name" | "punct" | "literal"; readonly text: string };

/** The words of a Turtle text: IRIs, prefixed names, literals (with their tag or type) and punctuation; comments dropped. */
function turtleTokens(ttl: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < ttl.length) {
    const c = ttl[i]!;
    if (/\s/.test(c)) i++;
    else if (c === "#") while (i < ttl.length && ttl[i] !== "\n") i++;
    else if (c === "<") {
      const end = ttl.indexOf(">", i);
      if (end < 0) break;
      out.push({ kind: "iri", text: ttl.slice(i + 1, end) });
      i = end + 1;
    } else if (c === '"' || c === "'") {
      const quote = ttl.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      let j = i + quote.length;
      while (j < ttl.length && !ttl.startsWith(quote, j)) j += ttl[j] === "\\" ? 2 : 1;
      i = j + quote.length;
      // a language tag or a datatype belongs to the literal
      if (ttl[i] === "@") while (i < ttl.length && /[A-Za-z0-9-@]/.test(ttl[i]!)) i++;
      else if (ttl.startsWith("^^", i)) {
        i += 2;
        if (ttl[i] === "<") i = ttl.indexOf(">", i) + 1;
        else while (i < ttl.length && /[^\s;,.\])]/.test(ttl[i]!)) i++;
      }
      out.push({ kind: "literal", text: "" });
    } else if (".;,[]()".includes(c)) {
      out.push({ kind: "punct", text: c });
      i++;
    } else {
      let j = i;
      while (j < ttl.length && /[^\s<>"';,\[\]()]/.test(ttl[j]!) && !(ttl[j] === "." && (j + 1 >= ttl.length || /\s/.test(ttl[j + 1]!)))) j++;
      out.push({ kind: "name", text: ttl.slice(i, j) });
      i = Math.max(j, i + 1);
    }
  }
  return out;
}

/** A plugin a manifest declares, with the files it names for it, each relative to the bundle, in the order named. */
export interface ManifestPlugin {
  readonly uri: string;
  readonly files: readonly string[];
  /** The basename of its `lv2:binary`, when it names one. */
  readonly binary?: string;
}

/**
 * Every plugin a bundle manifest declares and the files it names for it with `lv2:binary` or `rdfs:seeAlso`: the
 * files plugin-hostd's pin holds besides `manifest.ttl` itself. A file named outside the bundle (an absolute IRI) is
 * not one of them.
 */
export function manifestPlugins(ttl: string): ManifestPlugin[] {
  const prefixes = new Map<string, string>();
  const subjects = new Map<string, { typed: boolean; files: string[]; binary?: string }>();
  const expand = (t: Token): string | undefined => {
    if (t.kind === "iri") return t.text;
    if (t.kind !== "name") return undefined;
    if (t.text === "a") return RDF_TYPE;
    const colon = t.text.indexOf(":");
    const base = colon < 0 ? undefined : prefixes.get(t.text.slice(0, colon));
    return base === undefined ? undefined : base + t.text.slice(colon + 1);
  };
  const tokens = turtleTokens(ttl);
  let state: "subject" | "predicate" | "object" | "after" = "subject";
  let depth = 0;
  let subject: string | undefined;
  let predicate: string | undefined;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.kind === "name" && /^(@prefix|PREFIX)$/i.test(t.text) && state === "subject" && depth === 0) {
      const name = tokens[k + 1]?.text ?? "";
      const iri = tokens[k + 2];
      if (iri?.kind === "iri") prefixes.set(name.replace(/:$/, ""), iri.text);
      k += t.text.startsWith("@") ? 3 : 2;
      continue;
    }
    if (t.kind === "name" && /^(@base|BASE)$/i.test(t.text) && state === "subject" && depth === 0) {
      k += t.text.startsWith("@") ? 2 : 1;
      continue;
    }
    if (t.kind === "punct" && (t.text === "[" || t.text === "(")) {
      if (depth++ === 0 && state === "subject") subject = undefined;
      continue;
    }
    if (t.kind === "punct" && (t.text === "]" || t.text === ")")) {
      if (depth > 0 && --depth === 0) state = state === "subject" ? "predicate" : "after";
      continue;
    }
    if (depth > 0) continue;
    if (t.kind === "punct") {
      if (t.text === ".") state = "subject";
      else if (t.text === ";") state = "predicate";
      else if (t.text === ",") state = "object";
      continue;
    }
    if (state === "subject") {
      subject = expand(t);
      state = "predicate";
    } else if (state === "predicate") {
      predicate = expand(t);
      state = "object";
    } else if (state === "object") {
      state = "after";
      if (subject === undefined) continue;
      const entry = subjects.get(subject) ?? { typed: false, files: [] };
      subjects.set(subject, entry);
      const object = expand(t);
      if (predicate === RDF_TYPE && object === LV2_PLUGIN) entry.typed = true;
      if ((predicate === LV2_BINARY || predicate === RDFS_SEE_ALSO) && t.kind === "iri" && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(t.text) && !t.text.startsWith("/")) {
        const file = t.text.replace(/^(\.\/)+/, "");
        if (!entry.files.includes(file)) entry.files.push(file);
        if (predicate === LV2_BINARY && entry.binary === undefined) entry.binary = basename(file);
      }
    }
  }
  return [...subjects.entries()]
    .filter(([, e]) => e.typed)
    .map(([uri, e]) => ({ uri, files: e.files, ...(e.binary === undefined ? {} : { binary: e.binary }) }));
}

/** The plugins a bundle manifest declares, each with its `lv2:binary` basename. */
export function pluginsInManifest(ttl: string): { uri: string; binary?: string }[] {
  return manifestPlugins(ttl).map((p) => (p.binary === undefined ? { uri: p.uri } : { uri: p.uri, binary: p.binary }));
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
