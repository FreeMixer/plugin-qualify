// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * R-094 for the package (`docs/design/specs/2026-09-25-plugin-qualify.md` §4): a declared
 * number is MOVED and every consumer must move with it — here the CLI's defaults and `--help`,
 * both read through `qualify-options.ts` — and a declaration no production module (or the
 * Python-declarations generator) reads is dead.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const PERTURBED_RATES = [22050, 88200] as const;
const PERTURBED_QUANTA = [64, 2048] as const;

vi.mock("./qualify-declarations.js", async (orig) => ({
  ...(await orig<typeof import("./qualify-declarations.js")>()),
  QUALIFY_RATES: PERTURBED_RATES,
  QUALIFY_QUANTA: PERTURBED_QUANTA,
}));

const { helpText, parseQualifyArgs } = await import("./qualify-cli.js");
const declarations = await vi.importActual<typeof import("./qualify-declarations.js")>("./qualify-declarations.js");

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");

function productionSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|mjs)$/.test(e.name) && !/\.test\.ts$|\.d\.mts$/.test(e.name) && e.name !== "declarations.ts") out.push(p);
    }
  };
  walk(join(PKG, "src"));
  walk(join(PKG, "tools"));
  walk(join(PKG, "bin"));
  return out;
}

describe("declarations — a moved number moves every consumer", () => {
  it("the perturbation landed: the mocked lists differ from the real ones", () => {
    expect(declarations.QUALIFY_RATES).not.toEqual(PERTURBED_RATES);
    expect(declarations.QUALIFY_QUANTA).not.toEqual(PERTURBED_QUANTA);
  });

  it("the CLI's default rates and quanta are the perturbed declarations", () => {
    const a = parseQualifyArgs(["urn:x:y"]);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.args.rates).toEqual([...PERTURBED_RATES]);
    expect(a.args.quanta).toEqual([...PERTURBED_QUANTA]);
  });

  it("--help prints the perturbed defaults and not the real ones", () => {
    const h = helpText();
    expect(h).toContain(PERTURBED_RATES.join(","));
    expect(h).toContain(PERTURBED_QUANTA.join(","));
    expect(h).not.toContain(declarations.QUALIFY_RATES.join(","));
  });
});

describe("declarations — none is dead", () => {
  it("every exported declaration is read by a production module or the Python generator", () => {
    const text = productionSources().map((f) => readFileSync(f, "utf8")).join("\n");
    const names = Object.keys(declarations);
    expect(names.length).toBeGreaterThan(8);
    const dead = names.filter((n) => !new RegExp(`\\b${n}\\b`).test(text));
    expect(dead).toEqual([]);
  });
});
