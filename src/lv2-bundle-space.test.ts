// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * An LV2 bundle whose directory or binary has a space in its name (Surge XT's `libSurge%20XT.so`, a bundle under
 * `~/My Plugins/`): a manifest names the file as an IRI, so `%20` is a space on the disk. The sync must read the file the
 * IRI names, not the literal string.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { iriPath, manifestPlugins } from "./lv2-loader.js";
import { digestFiles, discoverSyncItems } from "./qualify-sync.js";

const scratch = mkdtempSync(join(tmpdir(), "lv2-space-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const URI = "urn:test:surge-like";
const MANIFEST = `@prefix lv2: <http://lv2plug.in/ns/lv2core#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<${URI}> a lv2:Plugin ; lv2:binary <libSurge%20XT.so> ; rdfs:seeAlso <Surge%20XT.ttl> .
`;

/** A bundle under a directory with a space, its binary and data file named with a space on the disk. */
function spaced(): { dir: string; bundle: string } {
  const dir = join(scratch, "My Plugins");
  const bundle = join(dir, "Surge XT.lv2");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, "manifest.ttl"), MANIFEST);
  writeFileSync(join(bundle, "libSurge XT.so"), "binary bytes");
  writeFileSync(join(bundle, "Surge XT.ttl"), "data");
  return { dir, bundle };
}

describe("iriPath — a file IRI's path, as lilv and serd decode it", () => {
  it("decodes percent escapes in a relative name", () => {
    expect(iriPath("libSurge%20XT.so")).toBe("libSurge XT.so");
    expect(iriPath("a%2Fb%C3%A9.so")).toBe("a/bé.so");
  });
  it("takes the path of a file: URI, with or without an authority", () => {
    expect(iriPath("file:///usr/lib/My%20Plugins/x.lv2/")).toBe("/usr/lib/My Plugins/x.lv2/");
    expect(iriPath("file://localhost/a%20b")).toBe("/a b");
  });
  it("leaves a name with a malformed escape as it is, and a plain path alone", () => {
    expect(iriPath("100%zz.so")).toBe("100%zz.so");
    expect(iriPath("/plain/path")).toBe("/plain/path");
  });
});

describe("a bundle with a space in its names", () => {
  it("the manifest's binary is the file on the disk, its files keep the IRI's word", () => {
    const [p] = manifestPlugins(MANIFEST);
    expect(p?.binary).toBe("libSurge XT.so");
    expect(p?.files).toContain("libSurge%20XT.so");
  });

  it("digestFiles reads the file an encoded name stands for", () => {
    const { bundle } = spaced();
    const files = digestFiles(bundle, ["manifest.ttl", "libSurge%20XT.so", "Surge%20XT.ttl"]);
    expect(files?.map((f) => f.path)).toEqual(["Surge%20XT.ttl", "libSurge%20XT.so", "manifest.ttl"]);
    expect(files?.every((f) => f.size > 0)).toBe(true);
  });

  it("discovery finds the plugin and every one of its files can be digested", () => {
    const { dir, bundle } = spaced();
    const [item] = discoverSyncItems({ lv2Dirs: [dir], clapDirs: [] }).items;
    expect(item?.root).toBe(bundle);
    expect(item?.binary).toBe(join(bundle, "libSurge XT.so"));
    expect(digestFiles(item!.root, item!.files)).toBeDefined();
  });
});
