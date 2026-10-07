// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The ONE plugin-discovery seam (`docs/design/specs/2026-09-25-plugin-qualify.md` §7). A format
 * loader turns a command-line target into the plugins it names. `lv2Loader` and `clapLoader` are
 * its implementations.
 */

/** One plugin a target resolved to. */
export interface PluginTarget {
  readonly format: string;
  /** The plugin's identity in its format (an LV2 URI). */
  readonly uri: string;
  /** The bundle directory it was found in, when resolved from a path. */
  readonly bundle?: string;
  /** Basename of the plugin's own binary, when known — the crash attribution reads it. */
  readonly binary?: string;
  /** The shared object's full path, when the format's loader reads it off the scan (a CLAP). */
  readonly binaryPath?: string;
}

export interface PluginLoader {
  readonly format: string;
  /**
   * The plugins `target` names, or `undefined` when the target is not this format's at all.
   * An empty array is a target that IS this format's and names no plugin — a refusal, never
   * silently nothing.
   */
  resolve(target: string): readonly PluginTarget[] | undefined;
}
