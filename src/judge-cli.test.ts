// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { OMX_CLAP_HOST_PROFILE, OPENMIXER_CONSOLE_PROFILE } from "./host-profiles.js";
import { defaultQualificationDir, judgeExitCode, judgeFiles, parseJudgeArgs } from "./judge-cli.js";
import { fixtureJson, fixtureText } from "./probe-output-fixtures.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "judge-cli-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const put = (name: string, text: string): string => {
  const p = join(scratch, name);
  writeFileSync(p, text);
  return p;
};

describe("parseJudgeArgs", () => {
  it("reads files, profiles (repeated or comma-separated, once each), the directory and the format", () => {
    const r = parseJudgeArgs(["--host-profile", "omx-clap-host,jalv", "--host-profile", "jalv", "--qualification-dir", "q", "--format", "json", "a.json", "b.json"]);
    expect(r).toEqual({ ok: true, args: { files: ["a.json", "b.json"], hostProfiles: ["omx-clap-host", "jalv"], qualificationDir: "q", format: "json", help: false } });
    const d = parseJudgeArgs(["a.json"]);
    expect(d.ok && d.args.hostProfiles).toEqual(["openmixer-console"]);
  });

  it("refuses an unknown option, a missing value, a bad format and no file", () => {
    expect(parseJudgeArgs(["--nope", "a"])).toEqual({ ok: false, error: "unknown option --nope" });
    expect(parseJudgeArgs(["a", "--qualification-dir"])).toEqual({ ok: false, error: "--qualification-dir needs a value" });
    expect(parseJudgeArgs(["a", "--format", "xml"]).ok).toBe(false);
    expect(parseJudgeArgs([]).ok).toBe(false);
    expect(parseJudgeArgs(["--help"]).ok).toBe(true);
  });
});

describe("defaultQualificationDir", () => {
  it("is the XDG state directory, else the home's", () => {
    expect(defaultQualificationDir({ XDG_STATE_HOME: "/s" }, "/h")).toBe("/s/omx/qualification");
    expect(defaultQualificationDir({ XDG_STATE_HOME: "" }, "/h")).toBe("/h/.local/state/omx/qualification");
    expect(defaultQualificationDir({}, "/h")).toBe("/h/.local/state/omx/qualification");
  });
});

describe("judgeFiles", () => {
  const profiles = [OMX_CLAP_HOST_PROFILE, OPENMIXER_CONSOLE_PROFILE];

  it("writes a record and a byte copy per file, and the exit code follows the verdicts", () => {
    const dir = join(scratch, "q1");
    const ok = put("ok.probe.json", fixtureText("success-msi"));
    const r = judgeFiles([ok], { profiles: [OMX_CLAP_HOST_PROFILE], dir });
    expect(r.failures).toEqual([]);
    expect(r.verdicts.map((v) => [v.host, v.rating])).toEqual([["omx-clap-host", "suitable"]]);
    expect(judgeExitCode(r)).toBe(0);
    expect(readdirSync(dir)).toHaveLength(2);
    const record = JSON.parse(readFileSync(r.records[0]!.recordPath, "utf8"));
    expect(record.probe.sha256).toBe(createHash("sha256").update(readFileSync(ok)).digest("hex"));
    const mixed = judgeFiles([ok], { profiles, dir });
    expect(judgeExitCode(mixed)).toBe(1);
  });

  it("a refused file is named with its code and exits 2, and the files after it are still judged", () => {
    const bad = fixtureJson("success-msi");
    bad.formatVersion = "2.0";
    const badPath = put("bad.json", JSON.stringify(bad));
    const dir = join(scratch, "q2");
    const r = judgeFiles([badPath, join(scratch, "missing.json"), put("good.json", fixtureText("success-msi"))], { profiles: [OMX_CLAP_HOST_PROFILE], dir });
    expect(r.failures.map((f) => f.problem.split(":")[0])).toEqual(["probe.format.major-unknown", "cannot read"]);
    expect(r.verdicts).toHaveLength(1);
    expect(judgeExitCode(r)).toBe(2);
  });

  it("a run that crashed exits 2, its record kept", () => {
    const r = judgeFiles([put("crash.json", fixtureText("plugin-crash"))], { profiles: [OPENMIXER_CONSOLE_PROFILE], dir: join(scratch, "q3") });
    expect(r.verdicts[0]).toMatchObject({ measured: false, deciding: "probe.crashed" });
    expect(judgeExitCode(r)).toBe(2);
    expect(r.records).toHaveLength(1);
  });
});

describe("plugin-qualify judge, the command", () => {
  const bin = join(PKG, "bin", "plugin-qualify.mjs");
  it("prints the verdict table, writes the pair and exits by the verdicts", (ctx) => {
    if (!readdirSync(PKG).includes("dist")) ctx.skip("dist is not built");
    const dir = join(scratch, "cli");
    const r = spawnSync(process.execPath, [bin, "judge", "--host-profile", "omx-clap-host", "--qualification-dir", dir, put("cli.probe.json", fixtureText("success-msi"))], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/org\.example\.plate\s+suitable\s+-\s+omx-clap-host/);
    expect(readdirSync(dir).sort().map((f) => f.replace(/^.*\.omx-clap-host\./, ""))).toEqual(["probe.json", "qualification.json"]);
    const bad = spawnSync(process.execPath, [bin, "judge", "--qualification-dir", dir, join(scratch, "none.json")], { encoding: "utf8" });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("cannot read");
  });
});
