// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * JACK's table of its servers, /dev/shm/jack-shm-registry: a header, then eight rows of a pid and a name
 * (`jack-<uid>:<server>:`). A server that is killed never clears its row, and once the eight are taken no server starts.
 * The adapter pass starts and stops servers of its own, `omx-qualify-<pid>-<rate>-<quantum>`; a row of one of those whose
 * process is gone is freed (pid 0, name empty) before the next start, as jackd frees its own row when it ends well.
 * Rows of any other server are never touched, and a file of another layout is left as it is.
 */
import { closeSync, existsSync, openSync, readSync, writeSync } from "node:fs";

export const JACK_REGISTRY = "/dev/shm/jack-shm-registry";
/** the header jack2 writes before the server rows, and the size of a row: a pid, then the name */
export const JACK_REGISTRY_HEADER = 24;
export const JACK_REGISTRY_ENTRY = 264;
const ROWS = 8;
const MAGIC = "KCAJ";
const OWN = ":omx-qualify-";

const alive = (pid: number): boolean => existsSync(`/proc/${String(pid)}`);

/** Frees the rows of the pass's own servers that are gone; the names freed, in the table's order. */
export function freeDeadJackSlots(path: string = process.env["OMX_JACK_REGISTRY"] ?? JACK_REGISTRY): string[] {
  const freed: string[] = [];
  let fd: number;
  try {
    fd = openSync(path, "r+");
  } catch {
    return freed;
  }
  try {
    const head = Buffer.alloc(JACK_REGISTRY_HEADER + ROWS * JACK_REGISTRY_ENTRY);
    if (readSync(fd, head, 0, head.length, 0) !== head.length) return freed;
    // the layout this code knows, or nothing is touched
    if (head.toString("latin1", 0, 4) !== MAGIC || head.readUInt32LE(16) !== JACK_REGISTRY_HEADER + ROWS * JACK_REGISTRY_ENTRY) return freed;
    for (let k = 0; k < ROWS; k++) {
      const at = JACK_REGISTRY_HEADER + k * JACK_REGISTRY_ENTRY;
      const pid = head.readInt32LE(at);
      const name = head.toString("latin1", at + 4, at + JACK_REGISTRY_ENTRY).split("\0")[0] ?? "";
      if (pid <= 0 || !name.includes(OWN) || alive(pid)) continue;
      writeSync(fd, Buffer.alloc(4), 0, 4, at);
      writeSync(fd, Buffer.alloc(1), 0, 1, at + 4);
      freed.push(name);
    }
  } finally {
    closeSync(fd);
  }
  return freed;
}
