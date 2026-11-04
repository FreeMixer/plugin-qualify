// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * mod-host is a comparison host, never a dependency: it runs only when `--host-profile` names it, and a machine
 * without it qualifies plugins as well as one with it, the mod-host verdict reading `mod-host.not-installed`.
 * So the packages only suggest it, each with the reason, and a qualification with no mod-host on the PATH runs
 * to the end. A machine that runs a published comparison or benchmark installs mod-host (and jalv) itself.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SPAWNED_ADMISSIONS, type AdmissionRuns } from "./host-admission.js";
import { MOD_HOST_PROFILE, OPENMIXER_CONSOLE_PROFILE } from "./host-profiles.js";
import { fixtureJson, withoutMemoryBudget } from "./probe-output-fixtures.js";
import { qualifyTargets, type ProbeRun } from "./probe-runner.js";
import { parseQualifyArgs } from "./qualify-cli.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p: string[]): string => readFileSync(join(PKG, ...p), "utf8");

/** The field lines of one package's stanza that name mod-host, and the comment lines right above each. */
function modHostFields(text: string): { field: string; comment: string }[] {
  const lines = text.split("\n");
  const out: { field: string; comment: string }[] = [];
  lines.forEach((l, i) => {
    const m = /^([A-Za-z-]+):.*\bmod-host\b/.exec(l);
    if (m === null) return;
    let j = i - 1;
    const comment: string[] = [];
    while (j >= 0 && lines[j]!.startsWith("#")) comment.unshift(lines[j--]!);
    out.push({ field: m[1]!, comment: comment.join("\n") });
  });
  return out;
}

describe("the packages only suggest mod-host, and say why", () => {
  for (const [name, text] of [["packaging/plugin-qualify.spec", read("packaging", "plugin-qualify.spec").split("\n%changelog")[0]!], ["debian/control", read("debian", "control")]] as const) {
    it(`${name}: Suggests, never Requires, Depends or Recommends, with the comparison and benchmark named`, () => {
      const fields = modHostFields(text);
      expect(fields.map((f) => f.field)).toEqual(["Suggests"]);
      expect(fields[0]!.comment).toMatch(/comparison/);
      expect(fields[0]!.comment).toMatch(/benchmark/);
      expect(fields[0]!.comment).toMatch(/mod-host\.not-installed/);
    });
  }
});

describe("plugin-qualify runs with no mod-host installed", () => {
  it("the default host profile is the console's, so mod-host is run only when asked", () => {
    const a = parseQualifyArgs(["urn:t:good"]);
    expect(a.ok && a.args.hostProfiles).toEqual([OPENMIXER_CONSOLE_PROFILE.id]);
  });

  it("asked for mod-host with none on the PATH, the qualification ends and the verdict reads not installed", () => {
    // a PATH that holds node and nothing else: no mod-host, whatever the machine has installed
    const empty = mkdtempSync(join(tmpdir(), "no-mod-host-"));
    try {
      const uri = "urn:plugin-qualify:test:no-mod-host";
      const doc = fixtureJson("success-msi");
      doc.plugin = { format: "lv2", id: uri };
      const run: ProbeRun = (_tool, args) => {
        writeFileSync(args[args.indexOf("--out") + 1]!, JSON.stringify(doc));
        return { status: 0, signal: null };
      };
      const env = { PATH: `${empty}:${dirname(process.execPath)}` };
      // the real mod-host run (tools/mod-host-admit.mjs, spawned), the adapter's left out: its absence is its own test
      const runs: AdmissionRuns = { modHost: SPAWNED_ADMISSIONS.modHost, jalv: SPAWNED_ADMISSIONS.jalv };
      const pass = qualifyTargets([{ format: "lv2", uri }], {
        rates: [48000],
        run,
        env,
        profiles: [withoutMemoryBudget(OPENMIXER_CONSOLE_PROFILE), MOD_HOST_PROFILE],
        admissions: runs,
      });
      const hosts = pass.runs[0]!.judgment.hosts;
      expect(hosts.find((h) => h.verdict.host === "mod-host")!.verdict).toMatchObject({ measured: false, rating: "unknown", deciding: "mod-host.not-installed" });
      // the console's verdict is the measurement's, as on a machine with mod-host
      expect(hosts.find((h) => h.verdict.host === OPENMIXER_CONSOLE_PROFILE.id)!.verdict).toMatchObject({ qualified: true });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  }, 40_000);
});
