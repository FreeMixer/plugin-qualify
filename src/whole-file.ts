// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * A file written whole or not at all: the bytes go to `<path>.new` beside it, are flushed to the disk, and the name is
 * moved over the old file, then the directory is flushed so the rename itself survives a power cut. A reader of
 * `path`, plugin-hostd at start among them, sees the old file or the whole new one, never a half.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** The bytes one write call takes; a large file goes out in pieces of this size. */
const PIECE_BYTES = 1 << 16;

/** The name the new bytes are written under before the rename. */
export const pendingPath = (path: string): string => `${path}.new`;

export function writeFileWhole(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const pending = pendingPath(path);
  const fd = openSync(pending, "w", 0o644);
  try {
    for (let at = 0; at < bytes.length; at += PIECE_BYTES) writeSync(fd, bytes, at, Math.min(PIECE_BYTES, bytes.length - at));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(pending, path);
  const dir = openSync(dirname(path), "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
