// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The scan after a package transaction (#168): packaging/trigger-scan.sh, which the dpkg trigger and the rpm file
 * triggers run, and the package files that wire it. The script runs against stub `systemctl`, `nice` and
 * `plugin-qualify-sync` that record their arguments.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(PKG, "packaging", "trigger-scan.sh");
const FOLDERS = ["/usr/lib/lv2", "/usr/lib64/lv2", "/usr/local/lib/lv2", "/usr/lib/clap", "/usr/lib64/clap"];
const scratch = mkdtempSync(join(tmpdir(), "trigger-scan-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Run the script with stubs first on PATH; `fail` names the stubs that exit 1. */
function run(opts: { systemd: boolean; fail?: string[] }): { status: number | null; stderr: string; calls: string[] } {
  const dir = mkdtempSync(join(scratch, "run-"));
  const bin = join(dir, "bin");
  const log = join(dir, "calls");
  mkdirSync(bin);
  for (const name of ["systemctl", "plugin-qualify-sync"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${opts.fail?.includes(name) ? "exit 1" : "exit 0"}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  // nice runs the command it is given, and records the niceness it asked for
  writeFileSync(join(bin, "nice"), `#!/bin/sh\necho "nice $1 $2" >> "${log}"\nshift 2\nexec "$@"\n`);
  chmodSync(join(bin, "nice"), 0o755);
  const run = join(dir, "run-systemd");
  if (opts.systemd) mkdirSync(run);
  const r = spawnSync("sh", [SCRIPT], { encoding: "utf8", input: "/usr/lib/lv2/x.lv2/manifest.ttl\n", env: { PATH: `${bin}:/usr/bin:/bin`, PLUGIN_QUALIFY_SYSTEMD_RUN: run } });
  return { status: r.status, stderr: r.stderr, calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
}

describe("trigger-scan.sh", () => {
  it("starts the service without waiting when systemd is running, and runs no sync itself", () => {
    const r = run({ systemd: true });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(["systemctl start --no-block plugin-qualify-sync.service"]);
  });

  it("runs the sync directly at the lowest priority when systemd is not running", () => {
    const r = run({ systemd: false });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(["nice -n 19", "plugin-qualify-sync --system"]);
  });

  it("never fails the transaction when the service cannot be started", () => {
    const r = run({ systemd: true, fail: ["systemctl"] });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("could not start plugin-qualify-sync.service");
  });

  it("never fails the transaction when the direct sync fails", () => {
    const r = run({ systemd: false, fail: ["plugin-qualify-sync"] });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("plugin-qualify-sync --system failed");
  });
});

describe("the package wiring", () => {
  const read = (p: string): string => readFileSync(join(PKG, p), "utf8");

  it("the dpkg triggers file is interest-noawait on every standard folder", () => {
    const lines = read("debian/triggers").split("\n").filter((l) => l !== "" && !l.startsWith("#"));
    expect(lines).toEqual(FOLDERS.map((f) => `interest-noawait ${f}`));
  });

  it("postinst scans on triggered and debian/rules installs the script where postinst calls it", () => {
    expect(read("debian/plugin-qualify.postinst")).toMatch(/"\$1" = "triggered" \]; then\n\t\/usr\/lib\/plugin-qualify\/trigger-scan\n/);
    expect(read("debian/rules")).toContain("packaging/trigger-scan.sh $(CURDIR)/debian/plugin-qualify/usr/lib/plugin-qualify/trigger-scan");
  });

  it("the rpm file triggers cover the same folders, on install and on removal, and the script ships", () => {
    const spec = read("packaging/plugin-qualify.spec");
    for (const kind of ["transfiletriggerin", "transfiletriggerpostun"]) {
      expect(spec).toContain(`%${kind} -- ${FOLDERS.join(" ")}\n%{_libexecdir}/%{name}/trigger-scan\n`);
    }
    expect(spec).toContain("packaging/trigger-scan.sh %{buildroot}%{_libexecdir}/%{name}/trigger-scan");
  });
});
