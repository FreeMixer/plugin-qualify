// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * The LV2 measurer's latency fixtures: four mono effects in one library, each with a delay it is known to
 * have, so a measurement can be told from a declaration.
 *
 *   declared      delays the signal by 10 ms (a whole number of frames at each rate: 441 at 44.1 kHz, 480 at
 *                 48 kHz, ..., 1920 at 192 kHz) and reports it on its latency port (lv2:designation lv2:latency).
 *   undeclared    delays it by 883 frames at every rate and has no latency port.
 *   misdeclared   delays it by 883 frames and reports 128 on a port marked the older way (lv2:reportsLatency).
 *   mute          has no latency port and outputs silence whatever it is given: no latency can be measured.
 *
 * The port is written in run(), as a plugin that derives its latency from the rate does.
 */
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include <lv2/core/lv2.h>

#define URI_PREFIX "urn:plugin-qualify:fixture:lv2-latency-"
#define RING 4096u

enum kind { DECLARED, UNDECLARED, MISDECLARED, MUTE, KINDS };

enum { PORT_IN, PORT_OUT, PORT_LATENCY };

struct delay {
  enum kind kind;
  double rate;
  const float *in;
  float *out;
  float *latency;
  float ring[RING];
  uint32_t head;
};

static uint32_t delay_frames(const struct delay *d) {
  return d->kind == DECLARED ? (uint32_t)lround(d->rate * 0.010) : 883u;
}

static LV2_Handle make(enum kind kind, double rate) {
  struct delay *d = calloc(1, sizeof *d);
  if (d) {
    d->kind = kind;
    d->rate = rate;
  }
  return d;
}

static LV2_Handle instantiate_declared(const LV2_Descriptor *s, double rate, const char *p, const LV2_Feature *const *f) { (void)s; (void)p; (void)f; return make(DECLARED, rate); }
static LV2_Handle instantiate_undeclared(const LV2_Descriptor *s, double rate, const char *p, const LV2_Feature *const *f) { (void)s; (void)p; (void)f; return make(UNDECLARED, rate); }
static LV2_Handle instantiate_misdeclared(const LV2_Descriptor *s, double rate, const char *p, const LV2_Feature *const *f) { (void)s; (void)p; (void)f; return make(MISDECLARED, rate); }
static LV2_Handle instantiate_mute(const LV2_Descriptor *s, double rate, const char *p, const LV2_Feature *const *f) { (void)s; (void)p; (void)f; return make(MUTE, rate); }

static void connect_port(LV2_Handle h, uint32_t port, void *data) {
  struct delay *d = h;
  switch (port) {
  case PORT_IN: d->in = data; break;
  case PORT_OUT: d->out = data; break;
  case PORT_LATENCY: d->latency = data; break;
  default: break;
  }
}

static void activate(LV2_Handle h) {
  struct delay *d = h;
  memset(d->ring, 0, sizeof d->ring);
  d->head = 0;
}

static void run(LV2_Handle h, uint32_t frames) {
  struct delay *d = h;
  const uint32_t n = delay_frames(d);
  if (d->latency) *d->latency = d->kind == MISDECLARED ? 128.0f : (float)n;
  for (uint32_t i = 0; i < frames; i++) {
    d->ring[d->head % RING] = d->in[i];
    d->out[i] = d->kind == MUTE ? 0.0f : (d->head >= n ? d->ring[(d->head - n) % RING] : 0.0f);
    d->head++;
  }
}

static void deactivate(LV2_Handle h) { (void)h; }
static void cleanup(LV2_Handle h) { free(h); }
static const void *extension_data(const char *uri) { (void)uri; return NULL; }

static const LV2_Descriptor descriptors[KINDS] = {
  { URI_PREFIX "declared", instantiate_declared, connect_port, activate, run, deactivate, cleanup, extension_data },
  { URI_PREFIX "undeclared", instantiate_undeclared, connect_port, activate, run, deactivate, cleanup, extension_data },
  { URI_PREFIX "misdeclared", instantiate_misdeclared, connect_port, activate, run, deactivate, cleanup, extension_data },
  { URI_PREFIX "mute", instantiate_mute, connect_port, activate, run, deactivate, cleanup, extension_data },
};

LV2_SYMBOL_EXPORT const LV2_Descriptor *lv2_descriptor(uint32_t index) { return index < KINDS ? &descriptors[index] : NULL; }
