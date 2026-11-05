// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * The pool step's fixture instrument: no audio input, a stereo output, one note input, and a voice for each held note
 * that costs a fixed slice of CPU. With two or more voices sounding and a host that offers clap.thread-pool, process()
 * calls request_exec once and each sounding voice is one task; with no pool, or one that refuses, the voices run one
 * after another on the calling thread. Each voice writes only its own buffer and the buffers are summed in voice order
 * afterwards, so the output is the same bits whichever thread ran a task.
 *
 *   pool-synth.clap        asks for the pool and renders well with it: the pool is faster and safe.
 *   pool-synth-slow.clap   built with -DFIXTURE_POOL_SLOW, the same, whose tasks all take one lock for their whole
 *                          slice: the pool's threads wait on one another and the block is no faster, so it asks and
 *                          gains nothing.
 *   pool-synth-quiet.clap  built with -DFIXTURE_POOL_QUIET, the same with a twentieth of the CPU per voice: asks, and has
 *                          too little to run in parallel to be worth a pool.
 *   pool-synth-helper.clap built with -DFIXTURE_POOL_HELPER_ALLOC, the same which allocates a scratch buffer on a thread
 *                          that is not the audio thread: clean when the tasks run serial, not when a pool runs them.
 *   pool-synth-serial.clap built with -DFIXTURE_NO_POOL, the same which never offers the extension: never asked.
 *
 * Events are taken at the start of their block. The load changes no sample: it is a dependent multiply-add chain
 * into a volatile sink, the same cost on whichever thread runs it.
 */
#include <math.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>

#include <clap/clap.h>

#if defined FIXTURE_POOL_SLOW
#define FIXTURE_ID "org.freemixer.plugin-qualify.fixture.pool-synth-slow"
#define FIXTURE_NAME "pool synth whose tasks fight over a lock"
#elif defined FIXTURE_POOL_QUIET
#define FIXTURE_ID "org.freemixer.plugin-qualify.fixture.pool-synth-quiet"
#define FIXTURE_NAME "pool synth with almost nothing to do"
#elif defined FIXTURE_POOL_HELPER_ALLOC
#define FIXTURE_ID "org.freemixer.plugin-qualify.fixture.pool-synth-helper"
#define FIXTURE_NAME "pool synth that allocates on its helper threads"
#elif defined FIXTURE_NO_POOL
#define FIXTURE_ID "org.freemixer.plugin-qualify.fixture.pool-synth-serial"
#define FIXTURE_NAME "synth that never asks for the pool"
#else
#define FIXTURE_ID "org.freemixer.plugin-qualify.fixture.pool-synth"
#define FIXTURE_NAME "pool synth"
#endif

#define VOICES 8
#define MAXFRAMES 4096u
#ifdef FIXTURE_POOL_QUIET
#define LOAD_ITERS 20
#else
#define LOAD_ITERS 900
#endif

static const char *const features[] = { CLAP_PLUGIN_FEATURE_INSTRUMENT, CLAP_PLUGIN_FEATURE_STEREO, NULL };

static const clap_plugin_descriptor_t descriptor = {
  .clap_version = CLAP_VERSION_INIT,
  .id = FIXTURE_ID,
  .name = FIXTURE_NAME,
  .vendor = "plugin-qualify",
  .url = "",
  .manual_url = "",
  .support_url = "",
  .version = "1",
  .description = "plugin-qualify fixture",
  .features = features,
};

struct voice {
  int key;
  double phase, step;
  volatile double sink;
  float buf[MAXFRAMES];
};

struct synth {
  clap_plugin_t plugin;
  const clap_host_t *host;
  const clap_host_thread_pool_t *pool;
  double rate;
  uint32_t frames;
  pthread_t audio_thread;
  uint32_t act[VOICES];
  struct voice voice[VOICES];
};

#ifdef FIXTURE_POOL_SLOW
/* every task takes the same lock for the whole of its slice: with helpers they wait on one another and the block takes
 * longer than the voices one after another, whose lock is never contended */
static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
#endif

static bool synth_init(const clap_plugin_t *p) {
  struct synth *s = p->plugin_data;
#ifndef FIXTURE_NO_POOL
  s->pool = s->host->get_extension(s->host, CLAP_EXT_THREAD_POOL);
#endif
  return true;
}
static void synth_destroy(const clap_plugin_t *p) { free(p->plugin_data); }
static bool synth_activate(const clap_plugin_t *p, double rate, uint32_t min, uint32_t max) {
  (void)min;
  if (max > MAXFRAMES) return false;
  ((struct synth *)p->plugin_data)->rate = rate;
  return true;
}
static void synth_deactivate(const clap_plugin_t *p) { (void)p; }
static bool synth_start(const clap_plugin_t *p) { (void)p; return true; }
static void synth_stop(const clap_plugin_t *p) { (void)p; }
static void synth_reset(const clap_plugin_t *p) {
  struct synth *s = p->plugin_data;
  for (int v = 0; v < VOICES; v++) s->voice[v].key = -1;
}

static void note_on(struct synth *s, int key) {
  for (int v = 0; v < VOICES; v++)
    if (s->voice[v].key < 0) {
      s->voice[v].key = key;
      s->voice[v].phase = 0.0;
      s->voice[v].step = 2.0 * M_PI * 440.0 * pow(2.0, (key - 69) / 12.0) / s->rate;
      return;
    }
}

static void note_off(struct synth *s, int key) {
  for (int v = 0; v < VOICES; v++)
    if (key < 0 || s->voice[v].key == key) s->voice[v].key = -1;
}

static void synth_event(struct synth *s, const clap_event_header_t *e) {
  if (e->space_id != CLAP_CORE_EVENT_SPACE_ID) return;
  if (e->type == CLAP_EVENT_NOTE_ON) note_on(s, ((const clap_event_note_t *)e)->key);
  else if (e->type == CLAP_EVENT_NOTE_OFF) note_off(s, ((const clap_event_note_t *)e)->key);
  else if (e->type == CLAP_EVENT_MIDI) {
    const uint8_t *m = ((const clap_event_midi_t *)e)->data;
    if ((m[0] & 0xf0) == 0x90 && m[2] > 0) note_on(s, m[1]);
    else if ((m[0] & 0xf0) == 0x80 || (m[0] & 0xf0) == 0x90) note_off(s, m[1]);
    else if ((m[0] & 0xf0) == 0xb0 && m[1] == 123) note_off(s, -1);
  }
}

#ifdef FIXTURE_POOL_HELPER_ALLOC
/* through volatile pointers, so the compiler cannot pair the malloc with the free and drop both */
static void *(*volatile fixture_malloc)(size_t) = malloc;
static void (*volatile fixture_free)(void *) = free;
#endif

static void render(struct synth *s, struct voice *v) {
  double acc = 1.0;
#ifdef FIXTURE_POOL_HELPER_ALLOC
  if (!pthread_equal(pthread_self(), s->audio_thread)) {
    double *scratch = fixture_malloc(256 * sizeof(double));
    if (scratch) {
      scratch[0] = acc;
      fixture_free(scratch);
    }
  }
#endif
#ifdef FIXTURE_POOL_SLOW
  pthread_mutex_lock(&g_lock);
#endif
  for (uint32_t i = 0; i < s->frames; i++) {
    v->buf[i] = (float)(sin(v->phase) * 0.05);
    v->phase += v->step;
    for (int k = 0; k < LOAD_ITERS; k++) acc = acc * 0.9999999 + 1e-9;
  }
  v->sink = acc;
#ifdef FIXTURE_POOL_SLOW
  pthread_mutex_unlock(&g_lock);
#endif
}

static void pool_exec(const clap_plugin_t *p, uint32_t task) {
  struct synth *s = p->plugin_data;
  render(s, &s->voice[s->act[task]]);
}
static const clap_plugin_thread_pool_t plugin_pool = { pool_exec };

static clap_process_status synth_process(const clap_plugin_t *p, const clap_process_t *proc) {
  struct synth *s = p->plugin_data;
  const uint32_t n = proc->in_events->size(proc->in_events);
  if (proc->audio_outputs_count < 1 || proc->frames_count > MAXFRAMES) return CLAP_PROCESS_ERROR;
  for (uint32_t i = 0; i < n; i++) synth_event(s, proc->in_events->get(proc->in_events, i));
  s->frames = proc->frames_count;
  s->audio_thread = pthread_self();
  uint32_t sounding = 0;
  for (uint32_t v = 0; v < VOICES; v++)
    if (s->voice[v].key >= 0) s->act[sounding++] = v;
  if (sounding >= 2 && s->pool != NULL && s->pool->request_exec(s->host, sounding)) {
    /* the host ran every task before it returned */
  } else {
    for (uint32_t t = 0; t < sounding; t++) render(s, &s->voice[s->act[t]]);
  }
  const clap_audio_buffer_t *out = &proc->audio_outputs[0];
  for (uint32_t c = 0; c < out->channel_count; c++) {
    for (uint32_t i = 0; i < s->frames; i++) {
      float y = 0.0f;
      for (uint32_t t = 0; t < sounding; t++) y += s->voice[s->act[t]].buf[i];
      out->data32[c][i] = y;
    }
  }
  return CLAP_PROCESS_CONTINUE;
}

static uint32_t ports_count(const clap_plugin_t *p, bool is_input) { (void)p; return is_input ? 0 : 1; }
static bool ports_get(const clap_plugin_t *p, uint32_t index, bool is_input, clap_audio_port_info_t *info) {
  (void)p;
  if (index != 0 || is_input) return false;
  memset(info, 0, sizeof *info);
  strcpy(info->name, "out");
  info->flags = CLAP_AUDIO_PORT_IS_MAIN;
  info->channel_count = 2;
  info->port_type = CLAP_PORT_STEREO;
  info->in_place_pair = CLAP_INVALID_ID;
  return true;
}
static const clap_plugin_audio_ports_t audio_ports = { ports_count, ports_get };

static uint32_t notes_count(const clap_plugin_t *p, bool is_input) { (void)p; return is_input ? 1 : 0; }
static bool notes_get(const clap_plugin_t *p, uint32_t index, bool is_input, clap_note_port_info_t *info) {
  (void)p;
  if (index != 0 || !is_input) return false;
  memset(info, 0, sizeof *info);
  strcpy(info->name, "notes");
  info->supported_dialects = CLAP_NOTE_DIALECT_CLAP | CLAP_NOTE_DIALECT_MIDI;
  info->preferred_dialect = CLAP_NOTE_DIALECT_CLAP;
  return true;
}
static const clap_plugin_note_ports_t note_ports = { notes_count, notes_get };

static const void *synth_extension(const clap_plugin_t *p, const char *id) {
  (void)p;
  if (!strcmp(id, CLAP_EXT_AUDIO_PORTS)) return &audio_ports;
  if (!strcmp(id, CLAP_EXT_NOTE_PORTS)) return &note_ports;
#ifndef FIXTURE_NO_POOL
  if (!strcmp(id, CLAP_EXT_THREAD_POOL)) return &plugin_pool;
#endif
  return NULL;
}
static void synth_main_thread(const clap_plugin_t *p) { (void)p; }

static uint32_t factory_count(const clap_plugin_factory_t *f) { (void)f; return 1; }
static const clap_plugin_descriptor_t *factory_descriptor(const clap_plugin_factory_t *f, uint32_t index) {
  (void)f;
  return index == 0 ? &descriptor : NULL;
}
static const clap_plugin_t *factory_create(const clap_plugin_factory_t *f, const clap_host_t *host, const char *id) {
  (void)f;
  if (strcmp(id, descriptor.id)) return NULL;
  struct synth *s = calloc(1, sizeof *s);
  if (!s) return NULL;
  s->host = host;
  s->rate = 48000.0;
  for (int v = 0; v < VOICES; v++) s->voice[v].key = -1;
  s->plugin = (clap_plugin_t){
    .desc = &descriptor,
    .plugin_data = s,
    .init = synth_init,
    .destroy = synth_destroy,
    .activate = synth_activate,
    .deactivate = synth_deactivate,
    .start_processing = synth_start,
    .stop_processing = synth_stop,
    .reset = synth_reset,
    .process = synth_process,
    .get_extension = synth_extension,
    .on_main_thread = synth_main_thread,
  };
  return &s->plugin;
}
static const clap_plugin_factory_t factory = { factory_count, factory_descriptor, factory_create };

static bool entry_init(const char *path) { (void)path; return true; }
static void entry_deinit(void) {}
static const void *entry_factory(const char *id) { return strcmp(id, CLAP_PLUGIN_FACTORY_ID) ? NULL : &factory; }

CLAP_EXPORT const clap_plugin_entry_t clap_entry = { CLAP_VERSION_INIT, entry_init, entry_deinit, entry_factory };
