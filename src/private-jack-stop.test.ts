// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * A private JACK server stops on its TERM. A TERM to the shell's process group leaves a jackd that is not the group's
 * leader running (measured on a Raspberry Pi 5 and on CI): every stop then waited out the TERM, went on to HUP and a KILL,
 * and the KILL left the server's row in JACK's registry, the dead rows that filled it ("Too many servers"). On CI a missing
 * jackd is a failure; elsewhere the test skips.
 */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { startPrivateJack } from "./qualify-adapter-pass.js";

const installed = (tool: string): boolean => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;

describe("a private JACK server", () => {
  it("stops on its TERM, well inside the wait a stop gives it before a KILL", (ctx) => {
    if (!installed("jackd")) {
      if (process.env["CI"] !== undefined) throw new Error("jackd is missing: CI installs it");
      ctx.skip("needs jackd");
    }
    const server = startPrivateJack({ rate: 48000, quantum: 256 });
    if (server === undefined) throw new Error("no private JACK server came up");
    expect(server.alive()).toBe(true);
    const started = Date.now();
    server.stop();
    const ms = Date.now() - started;
    expect(server.alive()).toBe(false);
    // jackd ends about 20 ms after its TERM; a stop that had to KILL took the whole wait first (10 s, 2 s before #279)
    expect(ms).toBeLessThan(1000);
  });
});
