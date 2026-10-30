// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The hard limit of a process plugin-qualify spawns directly. Through plugin-hostd's runner a measured child has `memory.max`;
 * a direct spawn has no runner, so it gets `RLIMIT_AS`, which needs no privilege. It is off for a sanitizer build, which
 * reserves far more address space than it uses and would fail at start under any limit worth having.
 *
 * Hitting the limit is an outcome: the interposer ends the child with `MEMORY_BOUND_EXIT_STATUS` on the first refused
 * allocation when `MEMORY_BOUND_EXIT_ENV` is set ({@link addressSpaceLimited} sets it), and {@link directOutcome} names it.
 */
import { readFileSync } from "node:fs";
import { totalmem } from "node:os";

import { ADDRESS_SPACE_LIMIT_RAM_FRACTION, MEMORY_BOUND_EXIT_ENV, MEMORY_BOUND_EXIT_STATUS } from "./qualify-declarations.js";

/** The outcome of a direct spawn that hit its limit. */
export const MEMORY_LIMIT_EXCEEDED = "memory-limit-exceeded";
export const ADDRESS_SPACE_MECHANISM = "rlimit-as";

const SANITIZER_ENTRY = ["__asan_init", "__tsan_init", "__msan_init"];

/** Whether the program is built with a sanitizer that reserves address space: its own init symbol is in the binary. */
export function isSanitizerBuild(tool: string, read: (path: string) => Buffer = (p) => readFileSync(p)): boolean {
  let bytes: Buffer;
  try {
    bytes = read(tool);
  } catch {
    return false;
  }
  return SANITIZER_ENTRY.some((s) => bytes.includes(s));
}

export interface DirectSpawn {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** The limit it runs under, in bytes; absent for a sanitizer build. */
  readonly limitBytes?: number;
}

/** The limit a direct spawn takes by default: `ADDRESS_SPACE_LIMIT_RAM_FRACTION` of the machine's RAM. */
export const defaultAddressSpaceLimit = (ramBytes: number = totalmem()): number => Math.floor(ramBytes * ADDRESS_SPACE_LIMIT_RAM_FRACTION);

/**
 * How to spawn `tool` under the limit: the shell sets it and execs the program, since node has no way to set a child's
 * rlimit. The program's own process stays the one spawned, so a signal or a timeout reaches it as before.
 */
export function addressSpaceLimited(
  tool: string,
  args: readonly string[],
  limitBytes: number = defaultAddressSpaceLimit(),
  sanitizer: boolean = isSanitizerBuild(tool),
): DirectSpawn {
  if (sanitizer) return { command: tool, args, env: {} };
  const kb = Math.ceil(limitBytes / 2 ** 10);
  return {
    command: "/bin/sh",
    args: ["-c", `ulimit -v ${String(kb)} && exec "$@"`, "sh", tool, ...args],
    env: { [MEMORY_BOUND_EXIT_ENV]: "1" },
    limitBytes,
  };
}

/** What the end of a direct spawn under a limit comes to: the outcome and the limit when it hit it, else nothing. */
export function directOutcome(status: number | null, spawn: DirectSpawn): { readonly outcome: string; readonly memoryLimit: { readonly bytes: number; readonly mechanism: string } } | undefined {
  if (spawn.limitBytes === undefined || status !== MEMORY_BOUND_EXIT_STATUS) return undefined;
  return { outcome: MEMORY_LIMIT_EXCEEDED, memoryLimit: { bytes: spawn.limitBytes, mechanism: ADDRESS_SPACE_MECHANISM } };
}
