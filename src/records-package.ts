// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * `plugin-qualify-records-package`: the Debian package of a device's qualification records, so other devices of the
 * machine class install them as the distributed layer instead of measuring the same plugin set again.
 *
 * In: a qualification directory as plugin-qualify-sync leaves it. Out: `omx-qualification-<class>-<set>_<version>_all.deb`
 * installing every record and the probe output it judged under `/usr/share/omx/qualification/<class>/<set>/`, beside
 * the set's `provenance.json`. A record goes in only with its probe output, byte for byte the copy the record names;
 * an unmeasured record never applies and stays out. The archive is written here, `ar` and two `tar.xz` members, so a
 * machine without dpkg builds it too; the tar members are GNU tar's, owned by root, in name order, at one time.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DISTRIBUTED_DIR_SYSTEM, DISTRIBUTED_LAYER_SINCE, DISTRIBUTED_PROVENANCE_FILE, DISTRIBUTED_PROVENANCE_SCHEMA, type DistributedProvenance } from "./distributed-records.js";
import { sha256Hex } from "./probe-output.js";
import { QUALIFICATION_RECORD_SCHEMA } from "./qualification-record.js";

export interface RecordsPackageArgs {
  readonly stateDir: string;
  readonly hostClass: string;
  readonly set: string;
  /** A JSON file, or the JSON itself. */
  readonly provenance: string;
  readonly version?: string;
  readonly out: string;
  readonly maintainer: string;
}

export const RECORDS_PACKAGE_MAINTAINER = "Pau Aliagas <linuxnow@gmail.com>";

/** A word a Debian package name can hold: lowercase letters, digits, `+`, `-` and `.`, a letter or digit first. */
const DEB_WORD = /^[a-z0-9][a-z0-9+.-]*$/;
/** dpkg counts Installed-Size in kibibytes. */
const KIB = 2 ** 10;
const DEB_VERSION = /^[0-9][A-Za-z0-9.+~]*$/;

export function recordsPackageHelp(): string {
  return [
    "plugin-qualify-records-package: the Debian package of a device's qualification records, for the distributed layer",
    "",
    "  plugin-qualify-records-package <qualification dir> --host-class <class> --set <set> --provenance <json> [options]",
    "",
    "  --host-class <class>     the machine class the records were measured on (rpi5): the directory they install in",
    "  --set <set>              the plugin set they cover (zynthian-vangelis)",
    "  --provenance <json>      a JSON file, or the JSON itself: the image, the package versions, the source revisions",
    "  --version <version>      the package's version (default: today, 2026.10.29)",
    "  --out <dir>              where the .deb is written (default: .)",
    "  --maintainer <who>       the package's Maintainer field",
    "  --help                   this text",
    "",
    `the package installs ${DISTRIBUTED_DIR_SYSTEM}/<class>/<set>/ and depends on plugin-qualify (>= ${DISTRIBUTED_LAYER_SINCE})`,
    "exit 0 the package was written, 2 it could not be",
    "",
  ].join("\n");
}

export function parseRecordsPackageArgs(argv: readonly string[]): { ok: true; args: RecordsPackageArgs } | { ok: true; help: true } | { ok: false; error: string } {
  const values = new Map<string, string>();
  const positional: string[] = [];
  const valued = new Set(["--host-class", "--set", "--provenance", "--version", "--out", "--maintainer"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help") return { ok: true, help: true };
    if (valued.has(a)) {
      const v = argv[++i];
      if (v === undefined) return { ok: false, error: `${a} needs a value` };
      values.set(a, v);
    } else if (a.startsWith("--")) return { ok: false, error: `unknown argument ${a}` };
    else positional.push(a);
  }
  if (positional.length !== 1) return { ok: false, error: "name one qualification directory" };
  for (const flag of ["--host-class", "--set", "--provenance"]) if (!values.has(flag)) return { ok: false, error: `${flag} is needed` };
  const hostClass = values.get("--host-class")!;
  const set = values.get("--set")!;
  for (const [what, v] of [["--host-class", hostClass], ["--set", set]] as const) {
    if (!DEB_WORD.test(v)) return { ok: false, error: `${what} ${v}: a package name holds lowercase letters, digits, + - and . only` };
  }
  const version = values.get("--version");
  if (version !== undefined && !DEB_VERSION.test(version)) return { ok: false, error: `--version ${version} is not a Debian version` };
  return {
    ok: true,
    args: {
      stateDir: positional[0]!,
      hostClass,
      set,
      provenance: values.get("--provenance")!,
      ...(version === undefined ? {} : { version }),
      out: values.get("--out") ?? ".",
      maintainer: values.get("--maintainer") ?? RECORDS_PACKAGE_MAINTAINER,
    },
  };
}

/** The package of a class and a set. */
export const recordsPackageName = (hostClass: string, set: string): string => `omx-qualification-${hostClass}-${set}`;

/** Today as a package version, `2026.10.29`, and as a date, `2026-10-29`, in local time. */
export function today(now = new Date()): { version: string; date: string } {
  const p = (n: number): string => String(n).padStart(2, "0");
  const [y, m, d] = [String(now.getFullYear()), p(now.getMonth() + 1), p(now.getDate())];
  return { version: `${y}.${m}.${d}`, date: `${y}-${m}-${d}` };
}

/** The files of a qualification directory that go in the package: each record with its probe output, and what stays out, by name and why. */
export function collectRecords(stateDir: string): { records: string[]; files: string[]; left: { name: string; why: string }[] } {
  const names = readdirSync(stateDir).sort();
  const records: string[] = [];
  const files: string[] = [];
  const left: { name: string; why: string }[] = [];
  for (const name of names) {
    if (name.endsWith(".unmeasured.json")) {
      left.push({ name, why: "unmeasured, never applies" });
      continue;
    }
    if (!name.endsWith(".qualification.json")) continue;
    let record: { schema?: unknown; probe?: { file?: unknown; sha256?: unknown } };
    try {
      record = JSON.parse(readFileSync(join(stateDir, name), "utf8"));
    } catch {
      left.push({ name, why: "does not read" });
      continue;
    }
    if (record.schema !== QUALIFICATION_RECORD_SCHEMA || typeof record.probe?.file !== "string" || record.probe.file.includes("/")) {
      left.push({ name, why: `not a ${QUALIFICATION_RECORD_SCHEMA} naming its probe output` });
      continue;
    }
    let probe: Buffer;
    try {
      probe = readFileSync(join(stateDir, record.probe.file));
    } catch {
      left.push({ name, why: `its probe output ${record.probe.file} is not there` });
      continue;
    }
    if (sha256Hex(probe) !== record.probe.sha256) {
      left.push({ name, why: `its probe output ${record.probe.file} is not the copy it names` });
      continue;
    }
    records.push(name);
    files.push(name, record.probe.file);
  }
  return { records, files: [...new Set(files)].sort(), left };
}

/** The provenance argument read: a file's JSON, or the JSON itself. */
function readProvenanceArg(arg: string): Record<string, unknown> {
  const text = arg.trimStart().startsWith("{") ? arg : readFileSync(arg, "utf8");
  const v = JSON.parse(text) as unknown;
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("--provenance is not a JSON object");
  return v as Record<string, unknown>;
}

// --- the archive ------------------------------------------------------------------------------------------------------

/** One `ar` member header: name, time, owner, group, mode, size, as dpkg reads them. */
function arHeader(name: string, size: number, mtime: number): Buffer {
  const field = (v: string, n: number): string => v.padEnd(n, " ").slice(0, n);
  return Buffer.from(`${field(name, 16)}${field(String(mtime), 12)}${field("0", 6)}${field("0", 6)}${field("100644", 8)}${field(String(size), 10)}\`\n`, "latin1");
}

function writeAr(path: string, members: readonly { name: string; bytes: Buffer }[], mtime: number): void {
  const fd = openSync(path, "w", 0o644);
  try {
    writeSync(fd, Buffer.from("!<arch>\n"));
    for (const m of members) {
      writeSync(fd, arHeader(m.name, m.bytes.length, mtime));
      writeSync(fd, m.bytes);
      if (m.bytes.length % 2 === 1) writeSync(fd, Buffer.from("\n"));
    }
  } finally {
    closeSync(fd);
  }
}

/** A tree as a `tar.xz`, every entry `./`-rooted, owned by root, in name order, at `mtime`. */
function tarXz(tree: string, out: string, mtime: number): void {
  const r = spawnSync(
    "tar",
    ["--create", "--xz", "--format=gnu", "--owner=0", "--group=0", "--numeric-owner", "--sort=name", `--mtime=@${String(mtime)}`, "--mode=u=rwX,go=rX", "-f", out, "-C", tree, "."],
    { encoding: "utf8", env: { ...process.env, XZ_OPT: "-6" } },
  );
  if (r.status !== 0) throw new Error(`tar: ${r.error?.message ?? r.stderr.trim()}`);
}

export interface BuiltRecordsPackage {
  readonly path: string;
  readonly name: string;
  readonly version: string;
  readonly records: number;
  /** The files the package installs. */
  readonly files: number;
  readonly left: readonly { name: string; why: string }[];
}

/** The package of `args`, written into `args.out`. Throws, naming why, when it cannot be built. */
export function buildRecordsPackage(args: RecordsPackageArgs, now = new Date()): BuiltRecordsPackage {
  const name = recordsPackageName(args.hostClass, args.set);
  const day = today(now);
  const version = args.version ?? day.version;
  statSync(args.stateDir);
  const { records, files, left } = collectRecords(args.stateDir);
  if (records.length === 0) throw new Error(`${args.stateDir} holds no record that can go in the package`);
  const provenance: DistributedProvenance = {
    ...readProvenanceArg(args.provenance),
    schema: DISTRIBUTED_PROVENANCE_SCHEMA,
    set: args.set,
    hostClass: args.hostClass,
    package: { name, version },
    date: day.date,
  };
  const work = mkdtempSync(join(tmpdir(), "records-package-"));
  try {
    const data = join(work, "data");
    const rel = join("usr", "share", "omx", "qualification", args.hostClass, args.set);
    const dir = join(data, rel);
    mkdirSync(dir, { recursive: true });
    for (const f of files) copyFileSync(join(args.stateDir, f), join(dir, f));
    writeFileSync(join(dir, DISTRIBUTED_PROVENANCE_FILE), `${JSON.stringify(provenance, null, 2)}\n`);
    const installed = [...files, DISTRIBUTED_PROVENANCE_FILE].sort();
    let kib = 0;
    const sums: string[] = [];
    for (const f of installed) {
      const bytes = readFileSync(join(dir, f));
      kib += Math.ceil(bytes.length / KIB);
      sums.push(`${createHash("md5").update(bytes).digest("hex")}  ${join(rel, f)}`);
    }
    const control = join(work, "control");
    mkdirSync(control);
    writeFileSync(
      join(control, "control"),
      [
        `Package: ${name}`,
        `Version: ${version}`,
        "Architecture: all",
        `Maintainer: ${args.maintainer}`,
        `Installed-Size: ${String(kib)}`,
        `Depends: plugin-qualify (>= ${DISTRIBUTED_LAYER_SINCE}~)`,
        "Section: sound",
        "Priority: optional",
        "Multi-Arch: foreign",
        `Description: qualification records of the ${args.set} plugin set for ${args.hostClass}`,
        ` The plugin-qualify records of the ${args.set} plugin set, measured on a`,
        ` ${args.hostClass} device. plugin-qualify-sync takes a plugin from them instead of`,
        " measuring it, and only when every file of the installed plugin hashes as the",
        " measured one did; any other plugin is measured on the device as before.",
        "",
      ].join("\n"),
    );
    writeFileSync(join(control, "md5sums"), `${sums.join("\n")}\n`);
    const mtime = Math.floor(now.getTime() / 1000);
    tarXz(control, join(work, "control.tar.xz"), mtime);
    tarXz(data, join(work, "data.tar.xz"), mtime);
    mkdirSync(args.out, { recursive: true });
    const path = join(args.out, `${name}_${version}_all.deb`);
    writeAr(
      path,
      [
        { name: "debian-binary", bytes: Buffer.from("2.0\n") },
        { name: "control.tar.xz", bytes: readFileSync(join(work, "control.tar.xz")) },
        { name: "data.tar.xz", bytes: readFileSync(join(work, "data.tar.xz")) },
      ],
      mtime,
    );
    return { path, name, version, records: records.length, files: installed.length, left };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- reading one back -------------------------------------------------------------------------------------------------

export interface ReadDeb {
  readonly members: readonly string[];
  readonly debianBinary: string;
  readonly control: Readonly<Record<string, string>>;
  /** The control member's files, `./`-rooted. */
  readonly controlFiles: readonly string[];
  /** The data member's regular files, `./`-rooted, sorted. */
  readonly files: readonly string[];
}

/** A `.deb` read with nothing but `ar`'s layout and tar: its members, its control fields, its files; unpacked into `into` when given. */
export function readDeb(path: string, into?: string): ReadDeb {
  const bytes = readFileSync(path);
  if (bytes.subarray(0, 8).toString("latin1") !== "!<arch>\n") throw new Error(`${path}: not an ar archive`);
  const members = new Map<string, Buffer>();
  for (let at = 8; at < bytes.length; ) {
    const head = bytes.subarray(at, at + 60).toString("latin1");
    const name = head.slice(0, 16).trim().replace(/\/$/, "");
    const size = Number(head.slice(48, 58).trim());
    members.set(name, bytes.subarray(at + 60, at + 60 + size));
    at += 60 + size + (size % 2);
  }
  const work = mkdtempSync(join(tmpdir(), "read-deb-"));
  try {
    const list = (member: string, extract?: string): string[] => {
      const file = join(work, member);
      writeFileSync(file, members.get(member) ?? Buffer.alloc(0));
      const r = spawnSync("tar", ["-tvJf", file], { encoding: "utf8", maxBuffer: 256 << 20 });
      if (r.status !== 0) throw new Error(`${member}: ${r.stderr.trim()}`);
      if (extract !== undefined) {
        mkdirSync(extract, { recursive: true });
        const x = spawnSync("tar", ["-xJf", file, "-C", extract], { encoding: "utf8" });
        if (x.status !== 0) throw new Error(`${member}: ${x.stderr.trim()}`);
      }
      return r.stdout
        .split("\n")
        .filter((l) => l.startsWith("-"))
        .map((l) => l.slice(l.indexOf("./")))
        .sort();
    };
    const controlDir = join(work, "control");
    const controlFiles = list("control.tar.xz", controlDir);
    const control: Record<string, string> = {};
    for (const line of readFileSync(join(controlDir, "control"), "utf8").split("\n")) {
      const m = /^([A-Za-z-]+): (.*)$/.exec(line);
      if (m !== null) control[m[1]!] = m[2]!;
    }
    return {
      members: [...members.keys()],
      debianBinary: (members.get("debian-binary") ?? Buffer.alloc(0)).toString("latin1"),
      control,
      controlFiles,
      files: list("data.tar.xz", into),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
