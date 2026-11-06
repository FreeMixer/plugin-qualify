// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * lv2-measure-pin.h — the pin `lv2-measure` records for an LV2 plugin, in the measurement record's
 * `integrity` object.
 *
 * The files: the bundle's `manifest.ttl`, the shared object `lv2:binary` names and every file
 * `rdfs:seeAlso` names for the plugin, each by its path relative to the bundle root, hashed over one
 * open descriptor. The layout: every control port, input and output, as the loaded world describes
 * it, in plugin-hostd's omx-layout/1. Both are plugin-hostd's `pin.h` records: this
 * unit only fills its records from lilv. A file name with a space or a separator of `pin_set` is
 * pinned percent-encoded; a plugin whose files cannot be pinned (a manifest using `@base`) prints a
 * reason and no pin, never a partial one.
 */
#ifndef LV2_MEASURE_PIN_H
#define LV2_MEASURE_PIN_H

#include <stdio.h>

#include <lilv/lilv.h>

/** Print `,"version":"<minor>.<micro>"` when the plugin declares one, then `,"integrity":{...}`. */
void omx_lv2_pin_print(FILE *out, LilvWorld *world, const LilvPlugin *plugin);

#endif
