// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/** A suite without python3-lilv (Debian 12) is told plainly, and the package declares the dependency per suite (#168). */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { lv2DescriptorFailure } from "./qualify-sync.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("lv2DescriptorFailure", () => {
  it("names the missing python3-lilv in one plain line", () => {
    const msg = lv2DescriptorFailure(1, undefined, "Traceback (most recent call last):\n  File \"scan.py\", line 181\nModuleNotFoundError: No module named 'lilv'\n");
    expect(msg).toContain("python3-lilv is not installed");
    expect(msg).not.toContain("Traceback");
  });

  it("keeps the last lines of any other failure", () => {
    expect(lv2DescriptorFailure(3, undefined, "a\nb\nc\nd\n")).toBe("LV2 descriptors not all written (exit 3): b; c; d");
  });
});

describe("the deb's python3-lilv dependency", () => {
  it("is the substvar debian/rules fills per suite, not a plain Depends or a Recommends", () => {
    const control = readFileSync(join(PKG, "debian", "control"), "utf8");
    expect(control).toMatch(/^Depends:.*\$\{lilv:Depends\}/m);
    expect(control).not.toMatch(/python3-lilv/);
    const rules = readFileSync(join(PKG, "debian", "rules"), "utf8");
    expect(rules).toContain('dh_gencontrol -- -Vlilv:Depends="$(LILV_DEPENDS)"');
    expect(rules).toContain('"$$VERSION_ID" = 12');
  });
});
