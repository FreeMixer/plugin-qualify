// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * The LV2 fixture instrument: a MIDI input (an atom sequence of midi:MidiEvent), no audio input, a
 * stereo output and one gain control. Each MIDI key plays a sine from a fixed bank of voices; a note
 * off, or all notes off (controller 123), lets it go. Every voice costs a sine per sample, so the
 * cost grows with the notes held.
 *
 *   synth.lv2        run() touches only its ports and its voices: the known RT-safe instrument.
 *   synth-alloc.lv2  built with -DFIXTURE_ALLOCATES_ON_NOTE, the same, which also allocates and frees a
 *                    scratch buffer on every note on: quiet and clean until it is played, the known
 *                    RT-unsafe instrument.
 *
 * Nothing else differs but the URI, so a verdict that tells them apart is what the note sweep counted.
 */
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include <lv2/atom/atom.h>
#include <lv2/atom/util.h>
#include <lv2/core/lv2.h>
#include <lv2/midi/midi.h>
#include <lv2/urid/urid.h>

#ifdef FIXTURE_DRUM
#define FIXTURE_URI "urn:plugin-qualify:fixture:lv2-synth-drum"
#elif defined FIXTURE_ALLOCATES_ON_NOTE
#define FIXTURE_URI "urn:plugin-qualify:fixture:lv2-synth-alloc"
/* through a volatile pointer, so the compiler cannot pair the malloc with the free and drop both */
static void *(*volatile fixture_malloc)(size_t) = malloc;
static void (*volatile fixture_free)(void *) = free;
#else
#define FIXTURE_URI "urn:plugin-qualify:fixture:lv2-synth"
#endif

#define VOICES 32

enum { PORT_MIDI, PORT_OUT_L, PORT_OUT_R, PORT_GAIN };

#ifdef FIXTURE_DRUM
/* a drum kit: only these keys are mapped, and each hit lasts 20 ms */
#define FIXTURE_DRUM_LOW 36
#define FIXTURE_DRUM_HIGH 40
#define FIXTURE_DRUM_HIT_S 0.02
#endif

struct voice { int key; double phase, step; long left; };

struct synth {
  const LV2_Atom_Sequence *midi;
  float *out[2];
  const float *gain;
  LV2_URID midi_event;
  double rate;
  struct voice voice[VOICES];
};

static LV2_Handle instantiate(const LV2_Descriptor *d, double rate, const char *path, const LV2_Feature *const *features) {
  (void)d; (void)path;
  const LV2_URID_Map *map = NULL;
  for (int i = 0; features && features[i]; i++)
    if (!strcmp(features[i]->URI, LV2_URID__map)) map = features[i]->data;
  if (!map) return NULL;
  struct synth *s = calloc(1, sizeof *s);
  if (!s) return NULL;
  s->rate = rate;
  s->midi_event = map->map(map->handle, LV2_MIDI__MidiEvent);
  for (int v = 0; v < VOICES; v++) s->voice[v].key = -1;
  return s;
}

static void connect_port(LV2_Handle h, uint32_t port, void *data) {
  struct synth *s = h;
  switch (port) {
  case PORT_MIDI: s->midi = data; break;
  case PORT_OUT_L: s->out[0] = data; break;
  case PORT_OUT_R: s->out[1] = data; break;
  case PORT_GAIN: s->gain = data; break;
  default: break;
  }
}

static void activate(LV2_Handle h) {
  struct synth *s = h;
  for (int v = 0; v < VOICES; v++) s->voice[v].key = -1;
}

static void note_on(struct synth *s, int key) {
#ifdef FIXTURE_DRUM
  if (key < FIXTURE_DRUM_LOW || key > FIXTURE_DRUM_HIGH) return;
#endif
#ifdef FIXTURE_ALLOCATES_ON_NOTE
  fixture_free(fixture_malloc(256 * sizeof(double)));
#endif
  for (int v = 0; v < VOICES; v++)
    if (s->voice[v].key < 0) {
      s->voice[v].key = key;
      s->voice[v].phase = 0.0;
      s->voice[v].step = 2.0 * M_PI * 440.0 * pow(2.0, (key - 69) / 12.0) / s->rate;
#ifdef FIXTURE_DRUM
      s->voice[v].left = (long)(s->rate * FIXTURE_DRUM_HIT_S);
#endif
      return;
    }
}

static void note_off(struct synth *s, int key) {
  for (int v = 0; v < VOICES; v++)
    if (key < 0 || s->voice[v].key == key) s->voice[v].key = -1;
}

static void midi_message(struct synth *s, const uint8_t *m, uint32_t size) {
  if (size < 3) return;
  const uint8_t kind = m[0] & 0xf0;
  if (kind == 0x90 && m[2] > 0) note_on(s, m[1]);
  else if (kind == 0x80 || kind == 0x90) note_off(s, m[1]);
  else if (kind == 0xb0 && m[1] == 123) note_off(s, -1);
}

static void render(struct synth *s, uint32_t from, uint32_t to) {
  const float k = s->gain ? *s->gain : 1.0f;
  for (uint32_t i = from; i < to; i++) {
    double y = 0.0;
    for (int v = 0; v < VOICES; v++)
      if (s->voice[v].key >= 0) {
        y += sin(s->voice[v].phase) * 0.05;
        s->voice[v].phase += s->voice[v].step;
#ifdef FIXTURE_DRUM
        if (--s->voice[v].left <= 0) s->voice[v].key = -1;
#endif
      }
    s->out[0][i] = s->out[1][i] = (float)y * k;
  }
}

static void run(LV2_Handle h, uint32_t frames) {
  struct synth *s = h;
  uint32_t done = 0;
  if (s->midi) {
    LV2_ATOM_SEQUENCE_FOREACH (s->midi, ev) {
      const uint32_t at = ev->time.frames < 0 ? 0 : ev->time.frames > frames ? frames : (uint32_t)ev->time.frames;
      if (at > done) {
        render(s, done, at);
        done = at;
      }
      if (ev->body.type == s->midi_event) midi_message(s, (const uint8_t *)LV2_ATOM_BODY_CONST(&ev->body), ev->body.size);
    }
  }
  render(s, done, frames);
}

static void deactivate(LV2_Handle h) { (void)h; }
static void cleanup(LV2_Handle h) { free(h); }
static const void *extension_data(const char *uri) { (void)uri; return NULL; }

static const LV2_Descriptor descriptor = { FIXTURE_URI, instantiate, connect_port, activate, run, deactivate, cleanup, extension_data };

LV2_SYMBOL_EXPORT const LV2_Descriptor *lv2_descriptor(uint32_t index) { return index == 0 ? &descriptor : NULL; }
