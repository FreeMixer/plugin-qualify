// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The RPM and the DEB install the CLAP prober and its interposer where the CLI looks for them:
 * each package's `LIBEXECDIR` is one of `NATIVE_TOOL_DIRS`. The spec and `debian/rules` cannot
 * import the declaration, so this ties them to it: a directory moved on one side alone turns it red.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NATIVE_TOOL_DIRS } from "./qualify-declarations.js";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string): string => readFileSync(join(PKG, path), "utf8");

/** Every `LIBEXECDIR=` a packaging file passes to `make -C native install`. */
function libexecDirs(source: string): string[] {
  return [...source.matchAll(/-C native\b.*\bLIBEXECDIR=(\S+)/g)].map((m) => m[1]!);
}

describe("the packages install the native tools where the CLI looks", () => {
  it("the RPM: %{_libexecdir}/%{name}", () => {
    const spec = read("packaging/plugin-qualify.spec");
    const name = /^Name:\s*(\S+)/m.exec(spec)?.[1];
    const dirs = libexecDirs(spec).map((d) => d.replace("%{_libexecdir}", "/usr/libexec").replace("%{name}", name ?? "?"));
    expect(dirs).toEqual([NATIVE_TOOL_DIRS[0]]);
  });

  it("the DEB: /usr/lib/<package>", () => {
    expect(libexecDirs(read("debian/rules"))).toEqual([NATIVE_TOOL_DIRS[1]]);
  });
});
