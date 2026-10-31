// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
// The files of a pin are plugin-hostd's (plugin-qualify#228): what `plugin-hostd --pin-files` prints, hashed, nothing
// worked out here. On the Pi the pins left out the presets.ttl the manifest names and the daemon refused the add -509.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { HOSTD_ENV, hostdPinFiles, type PinFilesRun } from "./hostd-pin-files.js";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

describe("hostdPinFiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "hostd-pin-files-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const bundle = join(dir, "lv2", "mda-piano.lv2");
  mkdirSync(bundle, { recursive: true });
  for (const f of ["manifest.ttl", "Piano.so", "Piano.ttl", "presets.ttl", "default-preset.ttl"]) writeFileSync(join(bundle, f), `bytes of ${f}`);

  it("hashes exactly the files plugin-hostd names, the presets files included", () => {
    const seen: (readonly string[])[] = [];
    const run: PinFilesRun = (uri, dirs) => {
      seen.push(dirs);
      return { status: 0, stderr: "", stdout: `root ${bundle}\nfile manifest.ttl\nfile Piano.so\nfile Piano.ttl\nfile presets.ttl\nfile default-preset.ttl\n` };
    };
    const r = hostdPinFiles("http://moddevices.com/plugins/mda/Piano", ["/usr/lib/lv2", join(dir, "lv2")], {}, run);
    expect(r).toEqual({
      ok: true,
      root: bundle,
      files: ["Piano.so", "Piano.ttl", "default-preset.ttl", "manifest.ttl", "presets.ttl"].map((p) => ({ path: p, sha256: sha(`bytes of ${p}`) })),
    });
    expect(seen).toEqual([["/usr/lib/lv2", join(dir, "lv2")]]);
  });

  it("hashes the file a percent-encoded name decodes to, and keeps the name as the pin's word", () => {
    writeFileSync(join(bundle, "libSurge XT.so"), "bytes of the binary");
    const run: PinFilesRun = () => ({ status: 0, stderr: "", stdout: `root ${bundle}\nfile libSurge%20XT.so\n` });
    expect(hostdPinFiles("urn:x", [], {}, run)).toEqual({ ok: true, root: bundle, files: [{ path: "libSurge%20XT.so", sha256: sha("bytes of the binary") }] });
  });

  it("names no files when plugin-hostd cannot, with its reason", () => {
    const r = hostdPinFiles("urn:x", [], {}, () => ({ status: 1, stdout: "", stderr: "plugin-hostd: urn:x: manifest.ttl is in no bundle of lv2_path naming the plugin\n" }));
    expect(r).toEqual({ ok: false, detail: "plugin-hostd: urn:x: manifest.ttl is in no bundle of lv2_path naming the plugin" });
  });

  it("an older plugin-hostd without --pin-files is said so, never worked around", () => {
    const r = hostdPinFiles("urn:x", [], {}, () => ({ status: 1, stdout: "Usage: plugin-hostd [-n] ...\n", stderr: "plugin-hostd: unrecognized option '--pin-files'\n" }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.detail).toMatch(/no --pin-files .*0\.15\.0/);
  });

  it("no plugin-hostd installed is no pin", () => {
    expect(hostdPinFiles("urn:x", [], {}, () => ({ status: null, stdout: "", stderr: "", missing: true })).ok).toBe(false);
  });

  it("the spawned run hands plugin-hostd the LV2 directories as lv2_path and the uri", () => {
    const stand = join(dir, "plugin-hostd");
    writeFileSync(stand, `#!/bin/sh\n[ "$1" = -c ] && [ "$3" = --pin-files ] || exit 9\ngrep -q "^lv2_path ${join(dir, "lv2")}$" "$2" || exit 8\necho "root ${bundle}"; echo "file presets.ttl"\n`);
    chmodSync(stand, 0o755);
    const r = hostdPinFiles("http://moddevices.com/plugins/mda/Piano", [join(dir, "lv2")], { ...process.env, [HOSTD_ENV]: stand });
    expect(r).toEqual({ ok: true, root: bundle, files: [{ path: "presets.ttl", sha256: sha("bytes of presets.ttl") }] });
  });
});
