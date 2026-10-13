// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * The LV2 measurer's fixture plugin: a mono gain with one control, built twice.
 *
 *   rt-safe.lv2    run() touches only its ports: the known RT-safe plugin.
 *   rt-unsafe.lv2  built with -DFIXTURE_ALLOCATES, run() also allocates and frees a scratch buffer
 *                  every block: the known RT-unsafe plugin.
 *
 * Nothing else differs but the URI, so a measurement that tells them apart is the interposer's count.
 */
#include <stdlib.h>

#include <lv2/core/lv2.h>

#ifdef FIXTURE_ALLOCATES
#define FIXTURE_URI "urn:plugin-qualify:fixture:lv2-rt-unsafe"
/* through a volatile pointer, so the compiler cannot pair the malloc with the free and drop both */
static void *(*volatile fixture_malloc)(size_t) = malloc;
static void (*volatile fixture_free)(void *) = free;
#else
#define FIXTURE_URI "urn:plugin-qualify:fixture:lv2-rt-safe"
#endif

enum { PORT_GAIN, PORT_IN, PORT_OUT };

struct gain {
  const float *gain;
  const float *in;
  float *out;
};

static LV2_Handle instantiate(const LV2_Descriptor *d, double rate, const char *path, const LV2_Feature *const *features) {
  (void)d; (void)rate; (void)path; (void)features;
  return calloc(1, sizeof(struct gain));
}

static void connect_port(LV2_Handle h, uint32_t port, void *data) {
  struct gain *g = h;
  switch (port) {
  case PORT_GAIN: g->gain = data; break;
  case PORT_IN: g->in = data; break;
  case PORT_OUT: g->out = data; break;
  default: break;
  }
}

static void activate(LV2_Handle h) { (void)h; }

static void run(LV2_Handle h, uint32_t frames) {
  struct gain *g = h;
#ifdef FIXTURE_ALLOCATES
  fixture_free(fixture_malloc(frames * sizeof(float)));
#endif
  const float k = *g->gain;
  for (uint32_t i = 0; i < frames; i++) g->out[i] = g->in[i] * k;
}

static void deactivate(LV2_Handle h) { (void)h; }
static void cleanup(LV2_Handle h) { free(h); }
static const void *extension_data(const char *uri) { (void)uri; return NULL; }

static const LV2_Descriptor descriptor = {
  FIXTURE_URI, instantiate, connect_port, activate, run, deactivate, cleanup, extension_data,
};

LV2_SYMBOL_EXPORT const LV2_Descriptor *lv2_descriptor(uint32_t index) { return index == 0 ? &descriptor : NULL; }
