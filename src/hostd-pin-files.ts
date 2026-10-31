// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The files a pin holds, as plugin-hostd collects them (plugin-qualify#228). One definition of a plugin's files: the
 * daemon's, the list an add checks before it hashes them (`pins_check`), which `plugin-hostd --pin-files <uri>` prints
 * (plugin-hostd 0.15.0 and later). This module never works the list out itself: it runs the daemon on the device's LV2
 * directories, reads `root <dir>` and the `file <name>` lines, and hashes exactly those files.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The daemon binary, else `plugin-hostd` on the PATH. */
export const HOSTD_ENV = "PLUGIN_HOSTD";

export interface PinFilesRunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The daemon is not installed. */
  readonly missing?: boolean;
}

/** One run of `plugin-hostd --pin-files <uri>` with `lv2_path` set to `lv2Dirs`. */
export type PinFilesRun = (uri: string, lv2Dirs: readonly string[], env: Readonly<Record<string, string | undefined>>) => PinFilesRunResult;

export const SPAWNED_PIN_FILES: PinFilesRun = (uri, lv2Dirs, env) => {
  const dir = mkdtempSync(join(tmpdir(), "plugin-qualify-pin-files-"));
  try {
    const conf = join(dir, "plugin-hostd.conf");
    writeFileSync(conf, `lv2_path ${lv2Dirs.join(":")}\n`);
    const r = spawnSync(env[HOSTD_ENV] ?? "plugin-hostd", ["-c", conf, "--pin-files", uri], { encoding: "utf8", timeout: 30000, env: { ...env } });
    const missing = (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ...(missing ? { missing } : {}) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export type PinFiles =
  | { readonly ok: true; readonly root: string; readonly files: readonly { readonly path: string; readonly sha256: string }[] }
  | { readonly ok: false; readonly detail: string };

/** The files plugin-hostd collects for `uri`, each hashed; why not, when it cannot say. */
export function hostdPinFiles(
  uri: string,
  lv2Dirs: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  run: PinFilesRun = SPAWNED_PIN_FILES,
  read: (path: string) => Buffer = (p) => readFileSync(p),
): PinFiles {
  const r = run(uri, lv2Dirs, env);
  if (r.missing) return { ok: false, detail: "plugin-hostd is not installed: the files of a pin are plugin-hostd's to name" };
  if (r.status !== 0) {
    const why = r.stdout.startsWith("Usage:")
      ? "this plugin-hostd has no --pin-files (plugin-hostd 0.15.0 or later names the files of a pin)"
      : r.stderr.trim().split("\n").pop() || `plugin-hostd --pin-files exited ${String(r.status)}`;
    return { ok: false, detail: why };
  }
  let root: string | undefined;
  const names: string[] = [];
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("root ")) root = line.slice(5);
    else if (line.startsWith("file ")) names.push(line.slice(5));
  }
  if (root === undefined || names.length === 0) return { ok: false, detail: "plugin-hostd --pin-files printed no root or no file" };
  try {
    // a name is the word of a pin, percent-encoded when the file's name needs it (Surge XT's libSurge%20XT.so): the pin
    // keeps it as written, the file is the name it decodes to, as the daemon opens it
    const files = names.map((path) => ({ path, sha256: createHash("sha256").update(read(join(root!, decodeURIComponent(path)))).digest("hex") }));
    return { ok: true, root, files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
  } catch (e) {
    return { ok: false, detail: `a file plugin-hostd names cannot be read: ${e instanceof Error ? e.message : String(e)}` };
  }
}
