// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The path unit (#168): the generic package names the standard folders and no folder of one distribution; the
 * folders the settings file adds reach the unit through packaging/systemd/plugin-qualify-sync-generator.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const UNIT = readFileSync(join(PKG, "packaging", "systemd", "plugin-qualify-sync.path"), "utf8");
const GENERATOR = join(PKG, "packaging", "systemd", "plugin-qualify-sync-generator");
const STANDARD = ["/usr/lib/lv2", "/usr/lib64/lv2", "/usr/local/lib/lv2", "/usr/lib/clap", "/usr/lib64/clap"];
const scratch = mkdtempSync(join(tmpdir(), "path-unit-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const watched = (text: string): string[] => text.split("\n").filter((l) => l.startsWith("PathChanged=")).map((l) => l.slice("PathChanged=".length));

/** Run the generator over a settings file; the drop-in it wrote, or undefined when it wrote none. */
function generate(conf: string | undefined): { status: number | null; watched?: string[] } {
  const dir = mkdtempSync(join(scratch, "g-"));
  const file = join(dir, "qualify.conf");
  if (conf !== undefined) writeFileSync(file, conf);
  const out = join(dir, "out");
  const r = spawnSync("sh", [GENERATOR, out], { encoding: "utf8", env: { PATH: process.env["PATH"]!, PLUGIN_QUALIFY_CONF: file } });
  const dropIn = join(out, "plugin-qualify-sync.path.d", "50-qualify-conf.conf");
  return { status: r.status, ...(existsSync(dropIn) ? { watched: watched(readFileSync(dropIn, "utf8")) } : {}) };
}

describe("plugin-qualify-sync.path", () => {
  it("names the standard folders and no folder of one distribution", () => {
    expect(watched(UNIT)).toEqual(STANDARD);
    expect(UNIT).not.toMatch(/zynthian/i);
  });
});

describe("the generator ships", () => {
  it("in the rpm and in the deb, in systemd's generator folder", () => {
    expect(readFileSync(join(PKG, "packaging", "plugin-qualify.spec"), "utf8")).toContain("%{_systemdgeneratordir}/plugin-qualify-sync-generator\n");
    expect(readFileSync(join(PKG, "debian", "rules"), "utf8")).toContain("/usr/lib/systemd/system-generators/plugin-qualify-sync-generator");
  });
});

describe("plugin-qualify-sync-generator", () => {
  it("writes the folders of lv2_path, lv2_extra, clap_path and clap_extra, once each, in order", () => {
    const r = generate("lv2_path /opt/a:/usr/lib/lv2\nlv2_extra /opt/b # comment\nclap_path /opt/c\nclap_extra /opt/a:/opt/d\n");
    expect(r).toEqual({ status: 0, watched: ["/opt/a", "/usr/lib/lv2", "/opt/b", "/opt/c", "/opt/d"] });
  });

  it("ignores other keys, commented lines and relative folders", () => {
    const r = generate("#lv2_extra /nope\nbudget_s 30\npin_file /var/lib/omx/x\nlv2_extra relative/dir:/ok\n");
    expect(r.watched).toEqual(["/ok"]);
  });

  it("writes nothing, and succeeds, for a missing file or one that adds no folder", () => {
    expect(generate(undefined)).toEqual({ status: 0 });
    expect(generate("# nothing set\n#lv2_extra /zynthian/x\n")).toEqual({ status: 0 });
  });
});
