// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * The qualifier's fixture instrument: no audio input, a stereo output, one note input and one
 * gain parameter. Each key plays a sine from a fixed bank of voices; a note off, or a note off on
 * every key, lets it go. Built three times:
 *
 *   synth.clap             reads CLAP's note dialect (and MIDI's): the known RT-safe instrument.
 *   synth-alloc.clap       built with -DFIXTURE_ALLOCATES_ON_NOTE, the same, which also allocates a
 *                          scratch buffer on every note on and frees it: an instrument that is quiet
 *                          and clean until it is played, the known RT-unsafe one.
 *   synth-midi.clap        built with -DFIXTURE_MIDI_ONLY, the safe one reading MIDI's dialect alone.
 *   synth-voices.clap      built with -DFIXTURE_VOICE_CAPACITY=8, the safe one declaring through voice-info
 *                          that 8 voices sound at most: the cost arm holds 8 notes, basis declared. It also
 *                          prints a line to stdout on init, as Six Sines does, which must never reach the
 *                          prober's lines.
 *   synth-no-voices.clap   built with -DFIXTURE_VOICE_CAPACITY=0, the safe one declaring a capacity of 0.
 *   synth-input.clap       built with -DFIXTURE_AUDIO_INPUT, the safe one with a stereo main audio input too,
 *                          mixed into its output: still an instrument by its feature, so it is timed with
 *                          notes held.
 *   synth-strict.clap      built with -DFIXTURE_NO_WILDCARDS, the safe one aborting on a CLAP note event whose
 *                          key or channel is the wildcard -1, as Surge XT 1.3.4 and Six Sines 1.2.1 do: its port
 *                          reads MIDI too, so a host sends it all notes off as controller 123, never a wildcard.
 *                          It also has a stepped parameter (a mode, 0 to 3) and aborts on a value between two
 *                          steps, which no host sends.
 *
 * Each voice costs a sine per sample, so the cost grows with the notes held.
 *
 * Nothing else differs, so a verdict that tells them apart is what the note sweep counted.
 */
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include <clap/clap.h>

#if defined FIXTURE_ALLOCATES_ON_NOTE
#define FIXTURE_ID "org.freemixer.plugin-qualify.fixture.synth-alloc"
#define FIXTURE_NAME "synth that allocates on note on"
/* through a volatile pointer, so the compiler cannot pair the malloc with the free and drop both */
static void *(*volatile fixture_malloc)(size_t) = malloc;
static void (*volatile fixture_free)(void *) = free;
#elif defined FIXTURE_MIDI_ONLY
#define FIXTURE_ID "org.freemixer.plugin-qualify.fixture.synth-midi"
#define FIXTURE_NAME "synth reading MIDI"
#elif defined FIXTURE_AUDIO_INPUT
#define FIXTURE_ID "org.freemixer.plugin-qualify.fixture.synth-input"
#define FIXTURE_NAME "synth with an audio input"
#elif defined FIXTURE_NO_WILDCARDS
#define FIXTURE_ID "org.freemixer.plugin-qualify.fixture.synth-strict"
#define FIXTURE_NAME "synth refusing wildcard notes"
#elif defined FIXTURE_VOICE_CAPACITY && FIXTURE_VOICE_CAPACITY == 0
#define FIXTURE_ID "org.freemixer.plugin-qualify.fixture.synth-no-voices"
#define FIXTURE_NAME "synth declaring no voices"
#elif defined FIXTURE_VOICE_CAPACITY
#define FIXTURE_ID "org.freemixer.plugin-qualify.fixture.synth-voices"
#define FIXTURE_NAME "synth declaring its voices"
#else
#define FIXTURE_ID "org.freemixer.plugin-qualify.fixture.synth"
#define FIXTURE_NAME "synth"
#endif

#define VOICES 16
#define GAIN_ID 0u
#define MODE_ID 1u

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

struct voice { int key; double phase, step; };

struct synth {
  clap_plugin_t plugin;
  double rate, gain;
  struct voice voice[VOICES];
};

#if defined FIXTURE_VOICE_CAPACITY && FIXTURE_VOICE_CAPACITY > 0
#include <stdio.h>
static bool synth_init(const clap_plugin_t *p) {
  (void)p;
  printf("fixture synth: initialising, on stdout\n");
  fflush(stdout);
  return true;
}
#else
static bool synth_init(const clap_plugin_t *p) { (void)p; return true; }
#endif
static void synth_destroy(const clap_plugin_t *p) { free(p->plugin_data); }
static bool synth_activate(const clap_plugin_t *p, double rate, uint32_t min, uint32_t max) {
  (void)min; (void)max;
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
#ifdef FIXTURE_ALLOCATES_ON_NOTE
  double *scratch = fixture_malloc(256 * sizeof(double));
  if (scratch) {
    scratch[0] = (double)key;
    fixture_free(scratch);
  }
#endif
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
  switch (e->type) {
  case CLAP_EVENT_PARAM_VALUE: {
    const clap_event_param_value_t *v = (const clap_event_param_value_t *)e;
    if (v->param_id == GAIN_ID) s->gain = v->value;
#ifdef FIXTURE_NO_WILDCARDS
    if (v->param_id == MODE_ID && v->value != floor(v->value)) abort();
#endif
    break;
  }
#ifndef FIXTURE_MIDI_ONLY
  case CLAP_EVENT_NOTE_ON:
#ifdef FIXTURE_NO_WILDCARDS
    if (((const clap_event_note_t *)e)->key < 0 || ((const clap_event_note_t *)e)->channel < 0) abort();
#endif
    note_on(s, ((const clap_event_note_t *)e)->key);
    break;
  case CLAP_EVENT_NOTE_OFF:
#ifdef FIXTURE_NO_WILDCARDS
    if (((const clap_event_note_t *)e)->key < 0 || ((const clap_event_note_t *)e)->channel < 0) abort();
#endif
    note_off(s, ((const clap_event_note_t *)e)->key);
    break;
#endif
  case CLAP_EVENT_MIDI: {
    const uint8_t *m = ((const clap_event_midi_t *)e)->data;
    if ((m[0] & 0xf0) == 0x90 && m[2] > 0) note_on(s, m[1]);
    else if ((m[0] & 0xf0) == 0x80 || (m[0] & 0xf0) == 0x90) note_off(s, m[1]);
    else if ((m[0] & 0xf0) == 0xb0 && m[1] == 123) note_off(s, -1);
    break;
  }
  default:
    break;
  }
}

static clap_process_status synth_process(const clap_plugin_t *p, const clap_process_t *proc) {
  struct synth *s = p->plugin_data;
  const uint32_t n = proc->in_events->size(proc->in_events);
  uint32_t next = 0;
  if (proc->audio_outputs_count < 1) return CLAP_PROCESS_ERROR;
  const clap_audio_buffer_t *out = &proc->audio_outputs[0];
  for (uint32_t i = 0; i < proc->frames_count; i++) {
    while (next < n) {
      const clap_event_header_t *e = proc->in_events->get(proc->in_events, next);
      if (e->time > i) break;
      synth_event(s, e);
      next++;
    }
    double y = 0.0;
    for (int v = 0; v < VOICES; v++)
      if (s->voice[v].key >= 0) {
        y += sin(s->voice[v].phase) * 0.1;
        s->voice[v].phase += s->voice[v].step;
      }
    for (uint32_t c = 0; c < out->channel_count; c++) {
      double in = 0.0;
      if (proc->audio_inputs_count > 0 && c < proc->audio_inputs[0].channel_count) in = proc->audio_inputs[0].data32[c][i];
      out->data32[c][i] = (float)((y + in) * s->gain);
    }
  }
  for (; next < n; next++) synth_event(s, proc->in_events->get(proc->in_events, next));
  return CLAP_PROCESS_CONTINUE;
}

#ifdef FIXTURE_AUDIO_INPUT
#define AUDIO_INPUTS 1u
#else
#define AUDIO_INPUTS 0u
#endif
static uint32_t ports_count(const clap_plugin_t *p, bool is_input) { (void)p; return is_input ? AUDIO_INPUTS : 1; }
static bool ports_get(const clap_plugin_t *p, uint32_t index, bool is_input, clap_audio_port_info_t *info) {
  (void)p;
  if (index != 0 || (is_input && AUDIO_INPUTS == 0)) return false;
  memset(info, 0, sizeof *info);
  strcpy(info->name, is_input ? "in" : "out");
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
#ifdef FIXTURE_MIDI_ONLY
  info->supported_dialects = CLAP_NOTE_DIALECT_MIDI;
  info->preferred_dialect = CLAP_NOTE_DIALECT_MIDI;
#else
  info->supported_dialects = CLAP_NOTE_DIALECT_CLAP | CLAP_NOTE_DIALECT_MIDI;
  info->preferred_dialect = CLAP_NOTE_DIALECT_CLAP;
#endif
  return true;
}
static const clap_plugin_note_ports_t note_ports = { notes_count, notes_get };

#ifdef FIXTURE_NO_WILDCARDS
#define PARAMS 2u
#else
#define PARAMS 1u
#endif
static uint32_t params_count(const clap_plugin_t *p) { (void)p; return PARAMS; }
static bool params_info(const clap_plugin_t *p, uint32_t index, clap_param_info_t *info) {
  (void)p;
  if (index >= PARAMS) return false;
  memset(info, 0, sizeof *info);
  if (index == 1) {
    info->id = MODE_ID;
    info->flags = CLAP_PARAM_IS_AUTOMATABLE | CLAP_PARAM_IS_STEPPED;
    strcpy(info->name, "mode");
    info->max_value = 3.0;
    return true;
  }
  info->id = GAIN_ID;
  info->flags = CLAP_PARAM_IS_AUTOMATABLE;
  strcpy(info->name, "gain");
  info->max_value = 2.0;
  info->default_value = 1.0;
  return true;
}
static bool params_value(const clap_plugin_t *p, clap_id id, double *value) {
  if (id == MODE_ID && PARAMS > 1) {
    *value = 0.0;
    return true;
  }
  if (id != GAIN_ID) return false;
  *value = ((struct synth *)p->plugin_data)->gain;
  return true;
}
static bool params_to_text(const clap_plugin_t *p, clap_id id, double value, char *out, uint32_t size) {
  (void)p; (void)id; (void)value; (void)out; (void)size;
  return false;
}
static bool params_from_text(const clap_plugin_t *p, clap_id id, const char *text, double *value) {
  (void)p; (void)id; (void)text; (void)value;
  return false;
}
static void params_flush(const clap_plugin_t *p, const clap_input_events_t *in, const clap_output_events_t *out) {
  (void)out;
  const uint32_t n = in->size(in);
  for (uint32_t i = 0; i < n; i++) synth_event(p->plugin_data, in->get(in, i));
}
static const clap_plugin_params_t params = { params_count, params_info, params_value, params_to_text, params_from_text, params_flush };

#ifdef FIXTURE_VOICE_CAPACITY
static bool voices_get(const clap_plugin_t *p, clap_voice_info_t *info) {
  (void)p;
  info->voice_count = FIXTURE_VOICE_CAPACITY;
  info->voice_capacity = FIXTURE_VOICE_CAPACITY;
  info->flags = CLAP_VOICE_INFO_SUPPORTS_OVERLAPPING_NOTES;
  return true;
}
static const clap_plugin_voice_info_t voice_info = { voices_get };
#endif

static const void *synth_extension(const clap_plugin_t *p, const char *id) {
  (void)p;
#ifdef FIXTURE_VOICE_CAPACITY
  if (!strcmp(id, CLAP_EXT_VOICE_INFO)) return &voice_info;
#endif
  if (!strcmp(id, CLAP_EXT_AUDIO_PORTS)) return &audio_ports;
  if (!strcmp(id, CLAP_EXT_NOTE_PORTS)) return &note_ports;
  if (!strcmp(id, CLAP_EXT_PARAMS)) return &params;
  return NULL;
}
static void synth_main_thread(const clap_plugin_t *p) { (void)p; }

static uint32_t factory_count(const clap_plugin_factory_t *f) { (void)f; return 1; }
static const clap_plugin_descriptor_t *factory_descriptor(const clap_plugin_factory_t *f, uint32_t index) {
  (void)f;
  return index == 0 ? &descriptor : NULL;
}
static const clap_plugin_t *factory_create(const clap_plugin_factory_t *f, const clap_host_t *host, const char *id) {
  (void)f; (void)host;
  if (strcmp(id, descriptor.id)) return NULL;
  struct synth *s = calloc(1, sizeof *s);
  if (!s) return NULL;
  s->gain = 1.0;
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
