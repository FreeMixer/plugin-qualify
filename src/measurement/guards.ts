// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The only shape primitives this directory uses.
 *
 * `src/measurement/` is written to be lifted out of openmixer as a directory copy
 * (issue #343), so it imports NOTHING from its parent package — not even the catalog's
 * own `guards.ts`, whose header explains the same reasoning one level up. Keep it that
 * way: any import that reaches outside this directory turns a copy into a port.
 *
 * Every reader here returns `undefined` for input it cannot vouch for, and every builder
 * omits a field it has no value for. Both halves of the format's central rule: an absent
 * field means "not determined", never "zero" and never "false".
 */

/** Non-null, non-array plain object — the only shape a validator may index into. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A finite number, or `undefined` for anything else (including `NaN` and `Infinity`). */
export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A finite number strictly greater than zero, or `undefined`. */
export function positiveNumber(value: unknown): number | undefined {
  const n = finiteNumber(value);
  return n !== undefined && n > 0 ? n : undefined;
}

/** A non-empty string, or `undefined`. An empty string is absence spelled differently. */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A boolean, or `undefined` — never a coerced truthiness. */
export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Every element of an array that a reader accepted, in order; `undefined` if not an array. */
export function mapArray<T>(value: unknown, read: (item: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: T[] = [];
  for (const item of value) {
    const parsed = read(item);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

/**
 * `{ [key]: value }` when `value` is defined, `{}` otherwise — the spread helper every
 * builder uses for an optional field.
 *
 * Written as a function rather than an inline ternary at ~40 call sites so the intent
 * (omit, do not null) is named once and cannot drift.
 */
export function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  if (value === undefined) return {};
  const out: { [P in K]?: V } = {};
  out[key] = value;
  return out;
}
