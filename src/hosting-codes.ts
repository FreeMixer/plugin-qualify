// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The hosting verdict's message codes. Codes, never prose: the surface renders the operator's
 * locale.
 *
 * omx-clap-core declares every hosting code: one `HOSTING_<DIMENSION>_CODES` table per dimension,
 * in the TypeScript modules its package installs under `pkg-config --variable=tsdir omx-clap-core`
 * (BUILDING.md). {@link HOSTING_CODE} is those tables flattened into one `key: code` map, written
 * as plain data into `hosting-codes.generated.ts` by `tools/gen-hosting-codes.mjs` at build time:
 * a code omx-clap-core does not declare cannot be named here, and this module reads no file and
 * imports no `node:` module, so every public subpath that reaches it bundles for a browser.
 * `src/contract-vocabulary-conformance.test.ts` holds the generated map to omx-clap-core's real
 * modules, either way.
 */
import { HOSTING_CODE } from "./hosting-codes.generated.js";

export { HOSTING_CODE };

/** {@link HOSTING_CODE}'s type: each key's literal code. */
export type HostingCodeTable = typeof HOSTING_CODE;
