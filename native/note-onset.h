/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com> */
/*
 * An instrument's latency, the one rule the two measurers read it by: the frames from the note on to the FIRST output
 * sample above digital silence, the floor each measurer already names for a response that never came (SILENCE in
 * clap-qualify.c, LATENCY_SILENCE in lv2-measure.c: 1e-6, -120 dBFS). An attack is the patch's envelope, a musical
 * decision and not a processing delay: a slow attack starts its ramp at once, so its first sample past the floor comes
 * at the true processing delay. The onset is never read against the response's own peak (the impulse's rule, which
 * reads an attack's ramp as late as its -60 dB point), nor as an RMS or a level rising past a threshold.
 */
#ifndef OMX_NATIVE_NOTE_ONSET_H
#define OMX_NATIVE_NOTE_ONSET_H

#include <stdint.h>

/* the first of n frames' magnitudes above silence, UINT32_MAX when none is: the note never sounded */
static uint32_t note_onset_at(const float *mag, uint32_t n, float silence) {
  for (uint32_t i = 0; i < n; i++)
    if (mag[i] > silence) return i;
  return UINT32_MAX;
}

#endif
