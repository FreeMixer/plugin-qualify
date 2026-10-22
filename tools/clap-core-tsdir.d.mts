// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/** The two TypeScript modules omx-clap-core's `tsdir` carries. */
export const CLAP_CORE_TS_MODULES: readonly string[];
/** Where omx-clap-core's TypeScript modules are looked for, in order. */
export function clapCoreTsDirCandidates(env?: Readonly<Record<string, string | undefined>>): readonly string[];
/** The first candidate holding both modules, or `undefined`. */
export function findClapCoreTsDir(env?: Readonly<Record<string, string | undefined>>): string | undefined;
/** True for an export name that is one of omx-clap-core's hosting tables. */
export function isHostingTableName(name: string): boolean;
/** One hosting table: key to its entry. */
export type HostingEntries = Readonly<Record<string, { readonly code: string }>>;
/** Every hosting table the modules in `dir` export, by export name. */
export function loadHostingTables(dir: string): Promise<Record<string, HostingEntries>>;
/** The tables flattened into one `key: code` map. */
export function flattenHostingTables(tables: Readonly<Record<string, HostingEntries>>): Record<string, string>;
