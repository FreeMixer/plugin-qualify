// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The hosting verdict's message codes. Codes, never prose: the surface renders the operator's
 * locale.
 *
 * omx-contract declares every hosting code, one `HOSTING_<DIMENSION>_CODES` table per dimension
 * (its `data/hosting/<dimension>.json`). {@link HOSTING_CODE} is those tables flattened into one
 * `key: code` map, read from the contract at load: a code the contract does not declare cannot be
 * named here, and a dimension the contract adds arrives without an edit.
 */
import * as contract from "@openmixer/omx-contract";

type Contract = typeof contract;

/** The contract's hosting tables, by export name: every `HOSTING_<DIMENSION>_CODES`. */
type HostingTables = {
  [Name in keyof Contract as Name extends `HOSTING_${string}_CODES` ? Name : never]: Contract[Name];
};

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;

/** Every hosting table's `key: code`, merged into one record. */
type HostingCodeTable = UnionToIntersection<
  {
    [Name in keyof HostingTables]: {
      readonly [Key in keyof HostingTables[Name]]: HostingTables[Name][Key] extends { readonly code: infer Code } ? Code : never;
    };
  }[keyof HostingTables]
>;

/** True for an export name that is one of the contract's hosting tables. */
export function isHostingTableName(name: string): boolean {
  return /^HOSTING_[A-Z0-9_]+_CODES$/.test(name);
}

function flatten(): HostingCodeTable {
  const table: Record<string, string> = {};
  for (const [name, entries] of Object.entries(contract)) {
    if (!isHostingTableName(name)) continue;
    for (const [key, entry] of Object.entries(entries as Record<string, { readonly code: string }>)) {
      if (key in table) throw new Error(`omx-contract declares the hosting key ${key} twice (${name})`);
      table[key] = entry.code;
    }
  }
  return Object.freeze(table) as unknown as HostingCodeTable;
}

export const HOSTING_CODE: HostingCodeTable = flatten();
