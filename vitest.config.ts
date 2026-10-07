// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * vitest for plugin-qualify. Some tests spawn the measuring tools and wait on them, so the
 * per-test, per-hook and poll timeouts are 15 minutes rather than vitest's 5 s: a hang is caught
 * by the CI job's own timeout, not by a guess at how long a measurement takes.
 */
import { defineConfig } from 'vitest/config';

const HANG_GUARD_MS = 900_000;

export default defineConfig({
  test: {
    testTimeout: HANG_GUARD_MS,
    hookTimeout: HANG_GUARD_MS,
    expect: { poll: { timeout: HANG_GUARD_MS } },
  },
});
