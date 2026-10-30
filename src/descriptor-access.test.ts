// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The descriptor directory is read by the console, which runs as another user than the sync (#221): the sync says
 * when it is not readable, and the package publishes it world-readable.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { descriptorAccessProblems } from "./qualify-sync.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p: string[]): string => readFileSync(join(PKG, ...p), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "descriptor-access-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function layout(parentMode: number, dirMode: number, fileMode: number): string {
  const parent = mkdtempSync(join(scratch, "omx-"));
  const dir = join(parent, "descriptors");
  mkdirSync(dir);
  writeFileSync(join(dir, "a@1-aaaaaaaaaaaa.json"), "{}\n");
  chmodSync(join(dir, "a@1-aaaaaaaaaaaa.json"), fileMode);
  chmodSync(dir, dirMode);
  chmodSync(parent, parentMode);
  return dir;
}

describe("descriptorAccessProblems", () => {
  it("is silent for a directory published 0755 / 0644, and for one that does not exist yet", () => {
    expect(descriptorAccessProblems(layout(0o755, 0o755, 0o644))).toEqual([]);
    expect(descriptorAccessProblems(join(scratch, "nowhere"))).toEqual([]);
  });

  it("names a directory other users cannot list", () => {
    const [line, ...rest] = descriptorAccessProblems(layout(0o755, 0o700, 0o644));
    expect(rest).toEqual([]);
    expect(line).toMatch(/mode 0700.*cannot list/);
  });

  it("names a parent other users cannot enter", () => {
    const [line, ...rest] = descriptorAccessProblems(layout(0o700, 0o755, 0o644));
    expect(rest).toEqual([]);
    expect(line).toMatch(/mode 0700.*cannot enter/);
  });

  it("names descriptors other users cannot read", () => {
    const [line, ...rest] = descriptorAccessProblems(layout(0o755, 0o755, 0o600));
    expect(rest).toEqual([]);
    expect(line).toMatch(/1 descriptor\(s\).*cannot be read/);
  });
});

describe("the package publishes the descriptor directory world-readable (#221)", () => {
  const tmpfiles = read("packaging", "systemd", "plugin-qualify.tmpfiles.conf");

  it("tmpfiles creates /var/lib/omx and its descriptors 0755", () => {
    expect(tmpfiles).toMatch(/^d \/var\/lib\/omx 0755 /m);
    expect(tmpfiles).toMatch(/^d \/var\/lib\/omx\/descriptors 0755 /m);
  });

  it("the service keeps its state directory 0755 and creates files 0644", () => {
    const unit = read("packaging", "systemd", "plugin-qualify-sync.service");
    expect(unit).toMatch(/^StateDirectoryMode=0755$/m);
    expect(unit).toMatch(/^UMask=0022$/m);
  });

  it("the rpm and the deb install the tmpfiles file", () => {
    expect(read("packaging", "plugin-qualify.spec")).toContain("%{_tmpfilesdir}/plugin-qualify.conf");
    expect(read("debian", "rules")).toContain("usr/lib/tmpfiles.d/plugin-qualify.conf");
  });
});
