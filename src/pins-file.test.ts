// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The pins file `--pins` writes. The pure tests need no binary: the line is plugin-hostd's `pin_set` line, read back
 * with the daemon's own rules, and the worse verdict wins. The live test qualifies a fixture plugin into a pins file
 * (the native build, as `clap-qualify.test.ts`). The daemon test starts plugin-hostd on that file with `pin_file` and
 * require_pins on, adds the plugin with no `pin_set`, and corrupts one hash to get -509; it needs `PLUGIN_HOSTD` and
 * `PLUGIN_HOSTD_FAKE_HOST` (plugin-hostd's `tests/fake-host`) and skips visibly without them off CI; under CI their absence fails the test (the workflow installs plugin-hostd and plugin-hostd-tests).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import type { RtSafetyDocument } from "./clap-qualify.js";
import { qualifyClapTargets } from "./direct-prober.support.js";
import { OPENMIXER_CONSOLE_PROFILE } from "./host-profiles.js";
import {
  clapPinEntries,
  clapPinUri,
  measuredPinEntries,
  parsePinLine,
  pinLine,
  pinVerdictOf,
  pinsFile,
  type PinEntry,
} from "./pins-file.js";
import { parseQualifyArgs, type QualifyVerdict } from "./qualify-cli.js";
import { QUALIFY_OPTIONS } from "./qualify-options.js";
import { clapQualifyToolPath, rtInterposePath } from "./tool-paths.js";
import { QUALIFY_RATES } from "./qualify-declarations.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(PKG, "native", "build", "fixtures");
const SAFE = join(FIXTURES, "rt-safe.clap");
const UNSAFE = join(FIXTURES, "rt-unsafe.clap");
const SAFE_ID = "org.freemixer.plugin-qualify.fixture.rt-safe";
const BUILT = [clapQualifyToolPath(), rtInterposePath(), SAFE, UNSAFE].every((p) => existsSync(p));
const HOSTD = process.env["PLUGIN_HOSTD"];
const FAKE_HOST = process.env["PLUGIN_HOSTD_FAKE_HOST"];

const scratch = mkdtempSync(join(tmpdir(), "pins-file-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

function entry(uri: string, extra: Partial<PinEntry> = {}): PinEntry {
  return {
    uri,
    integrity: { version: "1", files: [{ path: "x.clap", sha256: A }], layout: { scheme: "omx-layout/1", sha256: B } },
    ...extra,
  };
}

describe("pinLine — hostd's pin_set line", () => {
  it("is the verb, the uri, path=digest joined by commas, scheme:digest and the verdict", () => {
    const line = pinLine(
      entry("clap:/p/x.clap#id", {
        integrity: {
          files: [
            { path: "a/y.bin", sha256: C },
            { path: "x.clap", sha256: A },
          ],
          layout: { scheme: "omx-layout/1", sha256: B },
        },
        verdict: "in-process",
      }),
    );
    expect(line).toBe(`pin_set clap:/p/x.clap#id a/y.bin=${C},x.clap=${A} omx-layout/1:${B} verdict=in-process`);
  });

  it("has no verdict word when the run has no opinion, and no line at all for a block that is no whole pin", () => {
    expect(pinLine(entry("u"))).toBe(`pin_set u x.clap=${A} omx-layout/1:${B}`);
    expect(pinLine({ uri: "u", integrity: { unmeasuredReason: "probe-error" } })).toBeUndefined();
    expect(pinLine({ uri: "u", integrity: { files: [], layout: { scheme: "s", sha256: B } } })).toBeUndefined();
    expect(pinLine({ uri: "u", integrity: { files: [{ path: "x", sha256: A }] } })).toBeUndefined();
  });

  it("is read back by the daemon's grammar to the same pin", () => {
    const p = parsePinLine(pinLine(entry("clap:/p/x.clap#id", { verdict: "isolated" }))!);
    expect(p).toEqual({
      uri: "clap:/p/x.clap#id",
      files: [{ path: "x.clap", sha256: A }],
      layout: { scheme: "omx-layout/1", sha256: B },
      verdict: "isolated",
    });
  });
});

describe("a word with whitespace in it", () => {
  it("is refused by name in pinLine, and left out (and named) by pinsFile", () => {
    expect(() => pinLine(entry("clap:/p/My Plugins/x.clap#id"))).toThrow(/clap:\/p\/My Plugins\/x\.clap#id/);
    expect(() => pinLine({ uri: "u", integrity: { files: [{ path: "a b.clap", sha256: A }], layout: { scheme: "omx-layout/1", sha256: B } } })).toThrow(/whitespace/);
    const file = pinsFile([entry("clap:/p/My Plugins/x.clap#id"), entry("clap:/p/x.clap#id")]);
    expect(file.written).toEqual(["clap:/p/x.clap#id"]);
    expect(file.refused.map((r) => r.uri)).toEqual(["clap:/p/My Plugins/x.clap#id"]);
    expect(file.text).not.toContain("My Plugins");
  });

  it("every line written round-trips through parsePinLine to the entry it came from", () => {
    const entries = [entry("a"), entry("clap:/p/x.clap#id", { verdict: "isolated" }), entry("urn:b", { verdict: "refused" }), entry("c", { verdict: "in-process" })];
    for (const e of entries) {
      const line = pinLine(e)!;
      const p = parsePinLine(line)!;
      expect(p.uri).toBe(e.uri);
      expect(p.files).toEqual(e.integrity.files);
      expect(p.layout).toEqual(e.integrity.layout);
      expect(p.verdict).toBe(e.verdict);
    }
    for (const line of pinsFile(entries).text.split("\n")) if (!line.startsWith("#") && line !== "") expect(() => parsePinLine(line)).not.toThrow();
  });
});

describe("parsePinLine — the daemon's grammar, so a drifting writer is a red test", () => {
  const ok = `u x.clap=${A} omx-layout/1:${B}`;
  it("takes the verb or not, skips comments and blanks", () => {
    expect(parsePinLine(`pin_set ${ok}`)).toEqual(parsePinLine(ok));
    expect(parsePinLine("# a comment")).toBeUndefined();
    expect(parsePinLine("   ")).toBeUndefined();
  });
  it.each([
    ["a digest that is not hex", `u x.clap=${"g".repeat(64)} omx-layout/1:${B}`],
    ["an upper-case digest", `u x.clap=${"A".repeat(64)} omx-layout/1:${B}`],
    ["a path out of the bundle", `u ../x.clap=${A} omx-layout/1:${B}`],
    ["an absolute path", `u /x.clap=${A} omx-layout/1:${B}`],
    ["a path named twice", `u x.clap=${A},x.clap=${B} omx-layout/1:${B}`],
    ["a layout without a scheme", `u x.clap=${A} ${B}`],
    ["a verdict outside the vocabulary", `u x.clap=${A} omx-layout/1:${B} verdict=fine`],
    ["a fifth word", `u x.clap=${A} omx-layout/1:${B} verdict=refused extra`],
  ])("refuses %s", (_what, line) => {
    expect(() => parsePinLine(line)).toThrow();
  });
});

describe("pinVerdictOf — what a rating says about where the plugin may run", () => {
  it("suitable is in-process, conditional isolated, unsuitable refused, unknown no word", () => {
    expect(pinVerdictOf("suitable")).toBe("in-process");
    expect(pinVerdictOf("conditional")).toBe("isolated");
    expect(pinVerdictOf("unsuitable")).toBe("refused");
    expect(pinVerdictOf("unknown")).toBeUndefined();
  });
});

describe("pinsFile — one line per plugin, sorted, the worst verdict kept", () => {
  it("sorts by uri, names the plugins it skipped, and never writes a partial pin", () => {
    const f = pinsFile([entry("b", { verdict: "in-process" }), { uri: "c", integrity: { unmeasuredReason: "probe-error" } }, entry("a")]);
    expect(f.written).toEqual(["a", "b"]);
    expect(f.skipped).toEqual(["c"]);
    const lines = f.text.split("\n").filter((l) => l !== "" && !l.startsWith("#"));
    expect(lines.map((l) => parsePinLine(l)!.uri)).toEqual(["a", "b"]);
    expect(f.text.endsWith("\n")).toBe(true);
  });

  it("a plugin found twice is pinned with its worst verdict, and one with no word is the worst of all", () => {
    const once = (...v: PinEntry["verdict"][]) => pinsFile(v.map((verdict) => entry("u", verdict === undefined ? {} : { verdict })));
    const verdict = (f: ReturnType<typeof pinsFile>) => parsePinLine(f.text.split("\n")[1]!)!.verdict;
    expect(verdict(once("in-process", "isolated"))).toBe("isolated");
    expect(verdict(once("isolated", "refused", "in-process"))).toBe("refused");
    expect(verdict(once("in-process", undefined))).toBeUndefined();
  });
});

describe("the entries of a run", () => {
  const doc = (host: string, rating: RtSafetyDocument["verdict"]["rating"], pinned = true): RtSafetyDocument =>
    ({
      schema: "plugin-qualify/rt-safety/1",
      plugin: { uri: `urn:clap:${SAFE_ID}`, format: "clap", binary: { path: "rel/x.clap", sha256: A } },
      console: host,
      verdict: { rating, rtSafe: rating === "suitable", reasons: [] },
      measured: {
        hostExtensions: [],
        clap: {} as RtSafetyDocument["measured"]["clap"],
        rtSafety: { interposer: true },
        integrity: pinned ? entry("x").integrity : { unmeasuredReason: "probe-error" },
      },
    }) as unknown as RtSafetyDocument;

  it("a CLAP document is pinned by its file and id, with the verdict of the host asked about only", () => {
    const entries = clapPinEntries([doc("console", "suitable"), doc("jalv", "unsuitable")], "console");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.uri).toBe(clapPinUri("rel/x.clap", `urn:clap:${SAFE_ID}`));
    expect(entries[0]!.uri).toMatch(new RegExp(`^clap:/.*/rel/x\\.clap#${SAFE_ID}$`));
    expect(entries[0]!.verdict).toBe("in-process");
  });

  it("an LV2 plugin is pinned by its own uri, with the verdict row of the host, and none when it was not measured", () => {
    const plugin = { uri: "urn:p", topology: {}, integrity: entry("x").integrity } as never;
    const row = (measured: boolean, rating: QualifyVerdict["rating"]): QualifyVerdict => ({
      uri: "urn:p",
      host: "console",
      measured,
      rating,
      qualified: rating === "suitable",
    });
    expect(measuredPinEntries([plugin], [row(true, "conditional")], "console")[0]).toMatchObject({ uri: "urn:p", verdict: "isolated" });
    expect(measuredPinEntries([plugin], [row(false, "unknown")], "console")[0]!.verdict).toBeUndefined();
    expect(measuredPinEntries([plugin], [], "console")[0]!.verdict).toBeUndefined();
  });
});

describe("--pins on the command line", () => {
  it("is a declared option that takes a file, with --all or with named targets", () => {
    expect(QUALIFY_OPTIONS.find((o) => o.flag === "--pins")?.value).toBe("file");
    const all = parseQualifyArgs(["--all", "--pins", "out/pins.txt"]);
    expect(all.ok && all.args.pins).toBe("out/pins.txt");
    const named = parseQualifyArgs(["--pins", "p", "x:y"]);
    expect(named.ok && named.args.pins).toBe("p");
    expect(parseQualifyArgs(["--all"]).ok && (parseQualifyArgs(["--all"]) as { args: { pins?: string } }).args.pins).toBeFalsy();
    expect(parseQualifyArgs(["--all", "--pins"]).ok).toBe(false);
    expect(parseQualifyArgs(["--all", "--pins", "--rates"]).ok).toBe(false);
  });
});

function live(name: string, body: () => void | Promise<void>): void {
  it(name, async (ctx) => {
    if (!BUILT) {
      if (process.env["CI"]) throw new Error("native/build is missing: CI builds it with make -C native deps all");
      ctx.skip("native/build is missing: make -C native deps all");
    }
    await body();
  });
}

function pinsOf(clap: string, id: string | undefined): { text: string; entries: PinEntry[] } {
  const pass = qualifyClapTargets([{ format: "clap", uri: `urn:clap:${id ?? SAFE_ID}`, binaryPath: clap }], {
    rates: QUALIFY_RATES,
    profiles: [OPENMIXER_CONSOLE_PROFILE],
  });
  expect(pass.failures).toEqual([]);
  const entries = clapPinEntries(pass.documents, OPENMIXER_CONSOLE_PROFILE.id);
  return { text: pinsFile(entries).text, entries };
}

describe("a fixture plugin qualified into a pins file", () => {
  live("the RT-safe fixture is pinned by its file's digest and qualified in-process", () => {
    const { text } = pinsOf(SAFE, SAFE_ID);
    const lines = text.split("\n").filter((l) => l !== "" && !l.startsWith("#"));
    expect(lines).toHaveLength(1);
    const pin = parsePinLine(lines[0]!)!;
    expect(pin.uri).toBe(clapPinUri(SAFE, `urn:clap:${SAFE_ID}`));
    expect(pin.files).toContainEqual({ path: "rt-safe.clap", sha256: sha256(SAFE) });
    expect(pin.layout.scheme).toBe("omx-layout/1");
    expect(pin.verdict).toBe("in-process");
  });

  live("the RT-unsafe fixture is pinned and refused", () => {
    const unsafeId = "org.freemixer.plugin-qualify.fixture.rt-unsafe";
    const { text } = pinsOf(UNSAFE, unsafeId);
    expect(parsePinLine(text.split("\n")[1]!)!.verdict).toBe("refused");
  });
});

// --- plugin-hostd, loading the file ----------------------------------------------------------------

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/** One command on a NUL-framed socket, and the reply. */
class Controller {
  private buffer = "";
  private waiting: ((reply: string) => void) | undefined;
  constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (d: string) => {
      this.buffer += d;
      const nul = this.buffer.indexOf("\0");
      if (nul >= 0 && this.waiting !== undefined) {
        const reply = this.buffer.slice(0, nul);
        this.buffer = this.buffer.slice(nul + 1);
        const w = this.waiting;
        this.waiting = undefined;
        w(reply);
      }
    });
  }
  send(command: string): Promise<string> {
    return new Promise((resolve) => {
      this.waiting = resolve;
      this.socket.write(`${command}\0`);
    });
  }
}

async function daemon(conf: Record<string, string | number>): Promise<{ proc: ChildProcess; control: Controller; close: () => void }> {
  const [cmd, fb] = [await freePort(), await freePort()];
  const dir = mkdtempSync(join(scratch, "hostd-"));
  const file = join(dir, "plugin-hostd.conf");
  writeFileSync(file, Object.entries(conf).map(([k, v]) => `${k} ${v}`).join("\n") + "\n");
  const proc = spawn(HOSTD!, ["-n", "-p", String(cmd), "-f", String(fb), "-c", file], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("exit", (code) => reject(new Error(`plugin-hostd exited ${String(code)} before it was ready`)));
    proc.stdout!.on("data", (d: Buffer) => {
      if (d.toString().includes("plugin-hostd ready!")) resolve();
    });
  });
  const sockets = [createConnection(fb, "127.0.0.1"), createConnection(cmd, "127.0.0.1")];
  await Promise.all(sockets.map((s) => new Promise<void>((resolve) => s.once("connect", () => resolve()))));
  return {
    proc,
    control: new Controller(sockets[1]!),
    close: () => {
      for (const s of sockets) s.destroy();
      proc.removeAllListeners("exit");
      proc.kill("SIGTERM");
    },
  };
}

describe("plugin-hostd on the file, with require_pins on and no pin_set", () => {
  it("adds the qualified plugin, and refuses it with -509 when one hash of the file is corrupt", async (ctx) => {
    if (!BUILT && process.env["CI"]) throw new Error("native/build is needed and CI builds it");
    if (HOSTD === undefined || FAKE_HOST === undefined) {
      if (process.env["CI"]) throw new Error("PLUGIN_HOSTD and PLUGIN_HOSTD_FAKE_HOST are needed: CI installs plugin-hostd and plugin-hostd-tests");
      // a visible skip, never a pass, off CI
      ctx.skip("needs plugin-hostd with pin_file and its fake worker: PLUGIN_HOSTD, PLUGIN_HOSTD_FAKE_HOST (plugin-hostd-tests)");
    }
    if (!BUILT) ctx.skip("native/build is missing: make -C native deps all");
    const { entries } = pinsOf(SAFE, SAFE_ID);
    // The fake worker's layout is not the fixture's: the daemon is tested on the file it loads and the files it hashes;
    // that a prober and a host agree on a layout is the real workers' test (plugin-hostd's tests/jack_e2e.sh)
    const fakeLayout = spawnSync(FAKE_HOST!, ["-L"], { encoding: "utf8" }).stdout.trim();
    const [scheme, layoutSha] = [fakeLayout.slice(0, fakeLayout.lastIndexOf(":")), fakeLayout.slice(fakeLayout.lastIndexOf(":") + 1)];
    const forFake: PinEntry[] = entries.map((e) => ({ ...e, integrity: { ...e.integrity, layout: { scheme, sha256: layoutSha } } }));
    const good = join(scratch, "pins.good");
    writeFileSync(good, pinsFile(forFake).text);
    const bad = join(scratch, "pins.bad");
    writeFileSync(bad, readFileSync(good, "utf8").replace(sha256(SAFE).slice(0, 4), sha256(SAFE).startsWith("0000") ? "ffff" : "0000"));
    const uri = clapPinUri(SAFE, `urn:clap:${SAFE_ID}`);
    const base = { mod_host: FAKE_HOST!, clap_host: FAKE_HOST!, state_root: scratch, require_pins: 1, pin_mode: "strict", pin_store: join(scratch, "no-store") };

    const withGood = await daemon({ ...base, pin_file: good });
    try {
      expect(await withGood.control.send(`add ${uri} 0`)).toBe("resp 0");
    } finally {
      withGood.close();
    }
    const withBad = await daemon({ ...base, pin_file: bad });
    try {
      expect(await withBad.control.send(`add ${uri} 0`)).toBe("resp -509");
    } finally {
      withBad.close();
    }
    const withNone = await daemon(base);
    try {
      expect(await withNone.control.send(`add ${uri} 0`)).toBe("resp -508");
    } finally {
      withNone.close();
    }
  });
});
