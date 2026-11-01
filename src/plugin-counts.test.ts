// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
//
// The records counted per plugin over its offers: a CLAP plugin has a record per offer (.default, the console's
// in-process tier; .custom, omx-clap-host's isolated tier), and is one plugin, offered when any of its records is.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { pluginCounts, pluginCountsLine } from "./qualify-sync.js";

const dir = mkdtempSync(join(tmpdir(), "plugin-counts-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const put = (name: string, format: string, id: string, offeredOn: string[]): void =>
  writeFileSync(join(dir, `${name}.qualification.json`), JSON.stringify({ plugin: { format, id }, tiers: { offeredOn } }));

describe("plugin counts over offers", () => {
  it("counts a plugin once whatever its records, offered when any record is", () => {
    put("a@unversioned-aaaaaaaaaaaa.default", "clap", "org.example.a", []);
    put("a@unversioned-aaaaaaaaaaaa.custom", "clap", "org.example.a", ["isolated"]);
    put("b@unversioned-bbbbbbbbbbbb.default", "clap", "org.example.b", []);
    put("b@unversioned-bbbbbbbbbbbb.custom", "clap", "org.example.b", []);
    put("c@1-cccccccccccc.default", "lv2", "urn:example:c", ["isolated"]);
    put("d@1-dddddddddddd.default", "lv2", "urn:example:d", []);
    writeFileSync(join(dir, "junk.qualification.json"), "not json");
    const c = pluginCounts(dir);
    expect(c).toEqual({ plugins: { clap: 2, lv2: 2 }, offered: { clap: 1, lv2: 1 }, notOffered: { clap: 1, lv2: 1 } });
    expect(pluginCountsLine(c)).toBe("plugins 4 (clap 2, lv2 2), offered 2 (clap 1, lv2 1), not offered 2 (clap 1, lv2 1)");
  });

  it("a directory that is not there counts nothing", () => {
    expect(pluginCountsLine(pluginCounts(join(dir, "none")))).toBe("plugins 0, offered 0, not offered 0");
  });
});
