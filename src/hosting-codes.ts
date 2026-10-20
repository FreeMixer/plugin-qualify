// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The hosting verdict's message codes. Codes, never prose: the
 * surface renders the operator's locale.
 *
 * Generated from omx-contract's `HOSTING_*_CODES` (FreeMixer/plugin-qualify#120): the contract
 * is the one table every hosting-code writer and reader (plugin-qualify, plugin-hostd,
 * omx-clap-core) draws from, so a code this package does not yet use still appears here the
 * moment the contract declares it. The KEYS are plugin-qualify's own, kept from before the
 * contract existed; a code with no prior key here uses the contract's own key name.
 */
import {
  HOSTING_CLAP_CODES,
  HOSTING_COST_CODES,
  HOSTING_FEATURES_CODES,
  HOSTING_INTEGRITY_CODES,
  HOSTING_LATENCY_CODES,
  HOSTING_OUTPUT_CODES,
  HOSTING_OVERRIDE_CODES,
  HOSTING_PATCH_CODES,
  HOSTING_PRESET_CODES,
  HOSTING_PROVENANCE_CODES,
  HOSTING_REALISED_CODES,
  HOSTING_RT_SAFETY_CODES,
  HOSTING_STABILITY_CODES,
  HOSTING_STATE_CODES,
  HOSTING_TOPOLOGY_CODES,
  HOSTING_WORKER_CODES,
} from "@openmixer/omx-contract";

function codesOf<T extends Record<string, { readonly code: string }>>(
  table: T,
): { [K in keyof T]: T[K]["code"] } {
  const out = {} as { [K in keyof T]: T[K]["code"] };
  for (const [key, value] of Object.entries(table) as [keyof T, T[keyof T]][]) {
    out[key] = value.code;
  }
  return out;
}

export const HOSTING_CODE = {
  ...codesOf(HOSTING_STABILITY_CODES),
  ...codesOf(HOSTING_RT_SAFETY_CODES),
  ...codesOf(HOSTING_FEATURES_CODES),
  ...codesOf(HOSTING_COST_CODES),
  ...codesOf(HOSTING_LATENCY_CODES),
  ...codesOf(HOSTING_TOPOLOGY_CODES),
  ...codesOf(HOSTING_CLAP_CODES),
  ...codesOf(HOSTING_OUTPUT_CODES),
  ...codesOf(HOSTING_WORKER_CODES),
  ...codesOf(HOSTING_INTEGRITY_CODES),
  ...codesOf(HOSTING_OVERRIDE_CODES),
  ...codesOf(HOSTING_PROVENANCE_CODES),
  ...codesOf(HOSTING_REALISED_CODES),
  ...codesOf(HOSTING_STATE_CODES),
  ...codesOf(HOSTING_PATCH_CODES),
  ...codesOf(HOSTING_PRESET_CODES),
} as const;
