// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * `lv2BundlesOnPath`: what counts as an LV2 bundle on the search path for `--all`'s LV2 refusal
 * (clap-loader.ts). A bundle is a directory holding `manifest.ttl`, same as the loader's own
 * `resolve` — not anything merely named `*.lv2`.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { lv2BundlesOnPath } from "./lv2-loader.js";

const scratch = mkdtempSync(join(tmpdir(), "lv2-loader-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function bundle(dir: string, name: string): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "manifest.ttl"), "");
  return path;
}

describe("lv2BundlesOnPath — what counts as a bundle", () => {
  it("a directory holding manifest.ttl is a bundle", () => {
    const dir = join(scratch, "real");
    const gain = bundle(dir, "gain.lv2");
    expect(lv2BundlesOnPath({ LV2_PATH: dir })).toEqual([gain]);
  });

  it("a dangling .lv2 symlink is not a bundle", () => {
    const dir = join(scratch, "dangling");
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(dir, "nowhere"), join(dir, "dead.lv2"));
    expect(lv2BundlesOnPath({ LV2_PATH: dir })).toEqual([]);
  });

  it("a plain file named *.lv2 is not a bundle", () => {
    const dir = join(scratch, "file");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "x.lv2"), "");
    expect(lv2BundlesOnPath({ LV2_PATH: dir })).toEqual([]);
  });

  it("a directory without manifest.ttl is not a bundle", () => {
    const dir = join(scratch, "no-manifest");
    mkdirSync(join(dir, "empty.lv2"), { recursive: true });
    expect(lv2BundlesOnPath({ LV2_PATH: dir })).toEqual([]);
  });

  it("the broken and the real can sit on the same path: only the real one is found", () => {
    const dir = join(scratch, "mixed");
    const gain = bundle(dir, "gain.lv2");
    symlinkSync(join(dir, "nowhere"), join(dir, "dead.lv2"));
    writeFileSync(join(dir, "x.lv2"), "");
    expect(lv2BundlesOnPath({ LV2_PATH: dir })).toEqual([gain]);
  });
});
