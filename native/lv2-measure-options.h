// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * lv2-measure-options.h — the feature options the LV2 measurer runs under (lv2-measure.c).
 *
 * The features themselves are omx-clap-core's provider (<omx-clap-lv2/omx_lv2_features.h>, linked from
 * libomx-clap-lv2): the one URI table, options:options, the buf-size declarations, the worker's slot
 * and the log, the same code the console's LV2 host builds every instance's features with. This unit
 * holds what is the measurer's own: its defaults, the run flags that change them, and the object the
 * record names them in.
 *
 * THE DEFAULTS ARE THE MEASUREMENT AS IT HAS ALWAYS BEEN, so a verdict reached under them is the
 * verdict reached before the provider was shared:
 *
 *   features   every kind but state:loadDefaultState, which in the console is the registration's
 *              hook and under lilv is lilv-state's
 *   strict     off: the measurer hands a plugin to its own instantiate whatever it requires, so a
 *              refusal is the plugin's, never the host's
 *   block      bufsz:boundedBlockLength declared; minBlockLength 1, maxBlockLength and
 *              nominalBlockLength the run's block
 *   log        silent: a line from run() formats nothing and reaches no system call
 */
#ifndef LV2_MEASURE_OPTIONS_H
#define LV2_MEASURE_OPTIONS_H

#include <stddef.h>
#include <stdio.h>

#include <omx-clap-lv2/omx_lv2_features.h>

/* The capture buffer's bytes when --log capture names none. */
#define LV2_MEASURE_CAPTURE_BYTES_DEFAULT 4096u

struct lv2_measure_options {
  struct omx_lv2_feature_options feature;
  size_t capture_bytes; /* --log-capture-bytes: the buffer --log capture appends to, its NUL included */
};

/* The flag names of each kind, in the kinds' order, and of each buf-size declaration, in its bit's. */
extern const char *const LV2_MEASURE_FEATURE_NAMES[OMX_LV2_FEATURE_KINDS];
extern const char *const LV2_MEASURE_DECLARATION_NAMES[3];

/* The --help lines of the flags below. */
extern const char LV2_MEASURE_OPTIONS_HELP[];

/* `o` filled with the measurer's defaults. */
void lv2_measure_options_init(struct lv2_measure_options *o);

/* One run flag at argv[*i], its value at argv[*i + 1]: 1 taken (`*i` past its value), 0 not one of
 * these flags (`*i` untouched), -1 refused with `*why` (a static string) saying what was wrong.
 *
 *   --features LIST        the kinds offered, comma-separated (map, unmap, options, bounded, worker,
 *                          default-state, log, rtmempool); empty offers none
 *   --strict, --no-strict  refuse a plugin requiring a feature not offered, or hand it over without
 *   --block-declares LIST  the buf-size declarations made when bounded is offered: bounded, fixed,
 *                          pow2; empty makes none
 *   --block-min N, --block-max N, --block-nominal N
 *                          the block lengths reported; 0 is the run's block (the nominal: the maximum)
 *   --log MODE             silent, route (each line to stderr) or capture (into the record)
 *   --log-capture-bytes N  the capture buffer, its NUL included */
int lv2_measure_option_parse(struct lv2_measure_options *o, int argc, char **argv, int *i, const char **why);

/* `,"featureOptions":{...}`: the options a record was measured under. With the log captured, the
 * lines `capture` holds (NULL: none). */
void lv2_measure_options_print(FILE *out, const struct lv2_measure_options *o, const char *capture);

#endif
