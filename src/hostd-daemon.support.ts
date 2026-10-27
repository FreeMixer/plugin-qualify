// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * A real plugin-hostd for the tests: started on free ports with a settings file of the test's own, both its ports
 * connected as a controller connects them, and one command answered at a time on the NUL-framed command socket.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";

export function freePort(): Promise<number> {
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
export class Controller {
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

export interface RunningDaemon {
  readonly proc: ChildProcess;
  readonly control: Controller;
  readonly port: number;
  readonly feedbackPort: number;
  readonly close: () => void;
}

/** A daemon no controller is connected to yet: `connect` connects one. */
export interface StartedDaemon {
  readonly proc: ChildProcess;
  readonly port: number;
  readonly feedbackPort: number;
  readonly connect: () => Promise<RunningDaemon>;
  readonly close: () => void;
}

/** plugin-hostd at `binary`, its settings `conf` written into a directory of its own under `scratch`, a controller connected. */
export async function startDaemon(
  binary: string,
  scratch: string,
  conf: Record<string, string | number>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RunningDaemon> {
  return (await launchDaemon(binary, scratch, conf, env)).connect();
}

/** plugin-hostd started and ready, with no controller on its ports. */
export async function launchDaemon(
  binary: string,
  scratch: string,
  conf: Record<string, string | number>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<StartedDaemon> {
  const [cmd, fb] = [await freePort(), await freePort()];
  const dir = mkdtempSync(join(scratch, "hostd-"));
  const file = join(dir, "plugin-hostd.conf");
  writeFileSync(file, Object.entries(conf).map(([k, v]) => `${k} ${v}`).join("\n") + "\n");
  const proc = spawn(binary, ["-n", "-p", String(cmd), "-f", String(fb), "-c", file], { stdio: ["ignore", "pipe", "inherit"], env: { ...env } });
  await new Promise<void>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("exit", (code) => reject(new Error(`plugin-hostd exited ${String(code)} before it was ready`)));
    proc.stdout!.on("data", (d: Buffer) => {
      if (d.toString().includes("plugin-hostd ready!")) resolve();
    });
  });
  const sockets: Socket[] = [];
  const close = (): void => {
    for (const s of sockets) s.destroy();
    proc.removeAllListeners("exit");
    proc.kill("SIGTERM");
  };
  const connect = async (): Promise<RunningDaemon> => {
    sockets.push(createConnection(fb, "127.0.0.1"), createConnection(cmd, "127.0.0.1"));
    await Promise.all(sockets.map((s) => new Promise<void>((resolve) => s.once("connect", () => resolve()))));
    return { proc, control: new Controller(sockets[1]!), port: cmd, feedbackPort: fb, close };
  };
  return { proc, port: cmd, feedbackPort: fb, connect, close };
}
