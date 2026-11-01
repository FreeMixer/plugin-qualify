// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
//
// JACK keeps a table of its servers in /dev/shm/jack-shm-registry, eight rows, and a server that is killed never takes
// its row back: once the rows are full no server starts ("Too many servers already active"), and every adapter run of
// the pass after it is omx-clap-host.no-private-server. Before it starts a server of its own, the pass frees the rows
// of its own servers whose process is gone, and no other row.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { JACK_REGISTRY_ENTRY, JACK_REGISTRY_HEADER, freeDeadJackSlots } from "./jack-registry.js";

const dir = mkdtempSync(join(tmpdir(), "jack-registry-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** a registry as jack2 writes it: the header, then eight rows of a pid and a name */
function registry(rows: readonly { pid: number; name: string }[]): Buffer {
  const b = Buffer.alloc(JACK_REGISTRY_HEADER + 8 * JACK_REGISTRY_ENTRY + 64);
  b.write("KCAJ", 0, "latin1");
  b.writeUInt32LE(0, 4);
  b.writeUInt32LE(1, 8);
  b.writeUInt32LE(b.length, 12);
  b.writeUInt32LE(JACK_REGISTRY_HEADER + 8 * JACK_REGISTRY_ENTRY, 16);
  rows.forEach((r, k) => {
    b.writeInt32LE(r.pid, JACK_REGISTRY_HEADER + k * JACK_REGISTRY_ENTRY);
    b.write(r.name, JACK_REGISTRY_HEADER + k * JACK_REGISTRY_ENTRY + 4, "latin1");
  });
  return b;
}
const row = (b: Buffer, k: number) => ({
  pid: b.readInt32LE(JACK_REGISTRY_HEADER + k * JACK_REGISTRY_ENTRY),
  name: b.toString("latin1", JACK_REGISTRY_HEADER + k * JACK_REGISTRY_ENTRY + 4, JACK_REGISTRY_HEADER + k * JACK_REGISTRY_ENTRY + 40).split("\0")[0],
});
const DEAD = 0x7ffffff0; // no process has this pid

describe("the JACK server table", () => {
  it("frees the rows of the pass's own servers that are gone, and only those", () => {
    const path = join(dir, "registry");
    writeFileSync(path, registry([
      { pid: process.pid, name: "jack-0:default:" },
      { pid: DEAD, name: "jack-0:omx-qualify-1234-128:" },
      { pid: DEAD, name: "jack-0:someone-else:" },
      { pid: process.pid, name: "jack-0:omx-qualify-5678-256:" },
    ]));
    expect(freeDeadJackSlots(path)).toEqual(["jack-0:omx-qualify-1234-128:"]);
    const b = readFileSync(path);
    expect(row(b, 0)).toEqual({ pid: process.pid, name: "jack-0:default:" });
    expect(row(b, 1)).toEqual({ pid: 0, name: "" });
    expect(row(b, 2)).toEqual({ pid: DEAD, name: "jack-0:someone-else:" });
    expect(row(b, 3)).toEqual({ pid: process.pid, name: "jack-0:omx-qualify-5678-256:" });
  });

  it("leaves a file it does not recognise as it was, and a registry that is not there is nothing to free", () => {
    const path = join(dir, "other");
    const b = registry([{ pid: DEAD, name: "jack-0:omx-qualify-1-128:" }]);
    b.writeUInt32LE(12345, 16); // another header length: another layout
    writeFileSync(path, b);
    expect(freeDeadJackSlots(path)).toEqual([]);
    expect(readFileSync(path).equals(b)).toBe(true);
    expect(freeDeadJackSlots(join(dir, "none"))).toEqual([]);
  });
});
