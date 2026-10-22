// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/** The committed generated module, `src/hosting-codes.generated.ts`. */
export const OUT: string;
/** The generated module's text for a flattened `key: code` map. */
export function hostingCodesFile(flat: Readonly<Record<string, string>>): string;
/** The generated module's text from the omx-clap-core modules in `dir`. */
export function hostingCodesFileFrom(dir: string): Promise<string>;
