// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * clap-core-tsdir.mjs — where omx-clap-core's TypeScript modules are, and their hosting tables.
 *
 * omx-clap-core declares every hosting code: one `HOSTING_<DIMENSION>_CODES` table per dimension,
 * rendered into the modules its package installs under `pkg-config --variable=tsdir omx-clap-core`
 * (BUILDING.md) — `omx-clap-core-vocabulary.js` for the dimensions carried from omx-contract,
 * `omx-clap-core-hosting.js` for `hosting.idle.*`. `tools/gen-hosting-codes.mjs` reads them here
 * to write `src/hosting-codes.generated.ts`, and the conformance test reads them here to hold that
 * file to them.
 *
 * Node only, and build and test only: no module under src/ imports it, so nothing a public subpath
 * reaches touches the filesystem or a child process.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The two TypeScript modules omx-clap-core's `tsdir` carries, each a `HOSTING_<DIMENSION>_CODES` source. */
export const CLAP_CORE_TS_MODULES = Object.freeze(['omx-clap-core-vocabulary.js', 'omx-clap-core-hosting.js']);

/** This package's root. */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** `native/fetch-deps.sh`'s own checkout of omx-clap-core, for a build with no omx-clap-core-devel installed. */
const DEPS_TS_DIR = join(PACKAGE_ROOT, 'native/deps/omx-clap-core/ts');

/** Where `make install` of omx-clap-host puts them (BUILDING.md), for a run with no `pkg-config` binary at all. */
const DEFAULT_SYSTEM_TS_DIR = '/usr/share/omx-clap-core/ts';

/** `pkg-config --variable=tsdir omx-clap-core`, or `undefined` where pkg-config or the package is absent. */
function pkgConfigTsDir(env) {
  try {
    const out = execFileSync(env.PKG_CONFIG ?? 'pkg-config', ['--variable=tsdir', 'omx-clap-core'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === '' ? undefined : out;
  } catch {
    return undefined;
  }
}

/**
 * Where omx-clap-core's TypeScript modules are looked for, in order: `OMX_CLAP_CORE_TSDIR` when
 * set (and only that), else `pkg-config --variable=tsdir omx-clap-core`, else the checkout
 * `native/fetch-deps.sh` stages, else the path `make install` of omx-clap-host uses by default.
 */
export function clapCoreTsDirCandidates(env = process.env) {
  const set = env.OMX_CLAP_CORE_TSDIR;
  if (set !== undefined && set !== '') return [set];
  const fromPkgConfig = pkgConfigTsDir(env);
  return [...(fromPkgConfig === undefined ? [] : [fromPkgConfig]), DEPS_TS_DIR, DEFAULT_SYSTEM_TS_DIR];
}

/** The first candidate holding both modules, or `undefined`. */
export function findClapCoreTsDir(env = process.env) {
  return clapCoreTsDirCandidates(env).find((d) => CLAP_CORE_TS_MODULES.every((m) => existsSync(join(d, m))));
}

/** True for an export name that is one of omx-clap-core's hosting tables. */
export function isHostingTableName(name) {
  return /^HOSTING_[A-Z0-9_]+_CODES$/.test(name);
}

/** Every `HOSTING_<DIMENSION>_CODES` table the two modules in `dir` export, by export name, in module order. */
export async function loadHostingTables(dir) {
  const tables = {};
  for (const name of CLAP_CORE_TS_MODULES) {
    // The modules are self-contained ES modules in a directory with no package.json: Node 18 reads such a .js as
    // CommonJS and refuses `export`, so the source is imported as a data: module, which is a module on every Node.
    const source = readFileSync(join(dir, name), 'utf8');
    const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    for (const [exportName, table] of Object.entries(mod)) {
      if (isHostingTableName(exportName)) tables[exportName] = table;
    }
  }
  return tables;
}

/** The tables flattened into one `key: code` map; a key two tables declare is refused. */
export function flattenHostingTables(tables) {
  const flat = {};
  for (const [name, entries] of Object.entries(tables)) {
    for (const [key, entry] of Object.entries(entries)) {
      if (key in flat) throw new Error(`omx-clap-core declares the hosting key ${key} twice (${name})`);
      flat[key] = entry.code;
    }
  }
  return flat;
}
