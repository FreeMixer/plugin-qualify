// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The sync service holds itself to limits (#168): a sweep on a small machine must leave it reachable and the audio
 * undisturbed, whoever starts it (the timer, the path unit, a package trigger, a person).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const UNIT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "packaging", "systemd", "plugin-qualify-sync.service"), "utf8");
const service = new Map(
  UNIT.slice(UNIT.indexOf("[Service]"))
    .split("\n")
    .filter((l) => /^[A-Za-z]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as const),
);

describe("plugin-qualify-sync.service limits", () => {
  it("runs at the lowest CPU priority and idle IO, without real-time scheduling", () => {
    expect(service.get("Nice")).toBe("19");
    expect(service.get("IOSchedulingClass")).toBe("idle");
    expect(service.get("RestrictRealtime")).toBe("yes");
  });

  it("caps tasks and memory", () => {
    expect(service.get("TasksMax")).toBe("64");
    expect(service.get("MemoryMax")).toBe("1000M");
  });

  it("leaves two of four cores free for sshd and the console", () => {
    const quota = Number(/^(\d+)%$/.exec(service.get("CPUQuota") ?? "")?.[1]);
    expect(quota).toBeGreaterThan(0);
    expect(quota).toBeLessThanOrEqual(200);
  });
});
