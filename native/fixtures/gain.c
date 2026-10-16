// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * The qualifier's fixture plugin: a stereo gain with one parameter, built twice.
 *
 *   rt-safe.clap    process() touches only its buffers: the known RT-safe plugin.
 *   rt-unsafe.clap  built with -DFIXTURE_ALLOCATES, process() also allocates and frees a scratch
 *                   buffer every block: the known RT-unsafe plugin.
 *   params-<n>.clap built with -DFIXTURE_PARAMS=<n>, the rt-safe gain followed by n - 1 hidden
 *                   read-only parameters: the layout around the host's parameter cap.
 *   info-fails.clap built with -DFIXTURE_INFO_FAILS, the rt-safe gain whose one parameter's get_info
 *                   fails.
 *   leaky-delay.clap built with -DFIXTURE_DELAY=<d>, the gain delayed by d frames the way a
 *                   fractional-delay read lands a whole-frame delay: the arrival at d, and a leak of
 *                   FIXTURE_LEAK one frame ahead of it (omx-pitch's tap at 44.1 kHz).
 *                   It declares d through the latency extension.
 *   undeclared-delay.clap the same, built with -DFIXTURE_UNDECLARED too: it declares no latency.
 *
 * Nothing else differs, so a verdict that tells them apart is the interposer's count and nothing else.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <clap/clap.h>

#define FIXTURE_STR_(x) #x
#define FIXTURE_STR(x) FIXTURE_STR_(x)

#if defined FIXTURE_DELAY && defined FIXTURE_UNDECLARED
#define FIXTURE_ID "org.freemixer.plugin-qualify.fixture.undeclared-delay"
#define FIXTURE_NAME "delay that declares no latency"
#elif defined FIXTURE_DELAY
#define FIXTURE_ID "org.freemixer.plugin-qualify.fixture.leaky-delay"
#define FIXTURE_NAME "delay with a leak ahead of its arrival"
#elif defined FIXTURE_INFO_FAILS
#define FIXTURE_ID "org.freemixer.plugin-qualify.fixture.info-fails"
#define FIXTURE_NAME "gain whose get_info fails"
#elif defined FIXTURE_PARAMS
#define FIXTURE_ID "org.freemixer.plugin-qualify.fixture.params-" FIXTURE_STR(FIXTURE_PARAMS)
#define FIXTURE_NAME "gain with " FIXTURE_STR(FIXTURE_PARAMS) " parameters"
#elif defined FIXTURE_ALLOCATES
#define FIXTURE_ID "org.freemixer.plugin-qualify.fixture.rt-unsafe"
#define FIXTURE_NAME "rt-unsafe gain"
/* through a volatile pointer, so the compiler cannot pair the malloc with the free and drop both */
static void *(*volatile fixture_malloc)(size_t) = malloc;
static void (*volatile fixture_free)(void *) = free;
#else
#define FIXTURE_ID "org.freemixer.plugin-qualify.fixture.rt-safe"
#define FIXTURE_NAME "rt-safe gain"
#endif

#define GAIN_ID 0u

static const char *const features[] = { CLAP_PLUGIN_FEATURE_AUDIO_EFFECT, CLAP_PLUGIN_FEATURE_STEREO, NULL };

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

struct gain {
  clap_plugin_t plugin;
  double gain;
#ifdef FIXTURE_DELAY
  /* the last FIXTURE_DELAY + 1 input frames per channel, newest at `at` */
  float line[2][FIXTURE_DELAY + 1];
  uint32_t at;
#endif
};

#ifdef FIXTURE_DELAY
/* what omx-pitch's order-3 Lagrange read puts one frame ahead of a tap at 882.99999 frames */
#define FIXTURE_LEAK -2.1e-5f
#endif

static bool gain_init(const clap_plugin_t *p) { (void)p; return true; }
static void gain_destroy(const clap_plugin_t *p) { free(p->plugin_data); }
static bool gain_activate(const clap_plugin_t *p, double rate, uint32_t min, uint32_t max) {
  (void)p; (void)rate; (void)min; (void)max;
  return true;
}
static void gain_deactivate(const clap_plugin_t *p) { (void)p; }
static bool gain_start(const clap_plugin_t *p) { (void)p; return true; }
static void gain_stop(const clap_plugin_t *p) { (void)p; }
static void gain_reset(const clap_plugin_t *p) {
#ifdef FIXTURE_DELAY
  struct gain *g = p->plugin_data;
  memset(g->line, 0, sizeof g->line);
  g->at = 0;
#else
  (void)p;
#endif
}

static void gain_event(struct gain *g, const clap_event_header_t *e) {
  if (e->space_id != CLAP_CORE_EVENT_SPACE_ID || e->type != CLAP_EVENT_PARAM_VALUE) return;
  const clap_event_param_value_t *v = (const clap_event_param_value_t *)e;
  if (v->param_id == GAIN_ID) g->gain = v->value;
}

static clap_process_status gain_process(const clap_plugin_t *p, const clap_process_t *proc) {
  struct gain *g = p->plugin_data;
  const uint32_t n = proc->in_events->size(proc->in_events);
  for (uint32_t i = 0; i < n; i++) gain_event(g, proc->in_events->get(proc->in_events, i));
  if (proc->audio_inputs_count < 1 || proc->audio_outputs_count < 1) return CLAP_PROCESS_ERROR;
  const clap_audio_buffer_t *in = &proc->audio_inputs[0];
  const clap_audio_buffer_t *out = &proc->audio_outputs[0];
#ifdef FIXTURE_ALLOCATES
  float *scratch = fixture_malloc(proc->frames_count * sizeof(float));
  if (!scratch) return CLAP_PROCESS_ERROR;
#endif
#ifdef FIXTURE_DELAY
  const uint32_t len = FIXTURE_DELAY + 1u;
  for (uint32_t i = 0; i < proc->frames_count; i++) {
    g->at = (g->at + 1u) % len;
    for (uint32_t c = 0; c < 2; c++) {
      g->line[c][g->at] = c < in->channel_count ? in->data32[c][i] : 0.0f;
      /* x[n - d] at full weight, x[n - d + 1] at the leak: the leak arrives one frame early */
      const float y = g->line[c][(g->at + 1u) % len] + FIXTURE_LEAK * g->line[c][(g->at + 2u) % len];
      if (c < out->channel_count) out->data32[c][i] = (float)(y * g->gain);
    }
  }
#else
  for (uint32_t c = 0; c < out->channel_count && c < in->channel_count; c++)
    for (uint32_t i = 0; i < proc->frames_count; i++) out->data32[c][i] = (float)(in->data32[c][i] * g->gain);
#endif
#ifdef FIXTURE_ALLOCATES
  memcpy(scratch, out->data32[0], proc->frames_count * sizeof(float));
  fixture_free(scratch);
#endif
  return CLAP_PROCESS_CONTINUE;
}

static uint32_t ports_count(const clap_plugin_t *p, bool is_input) { (void)p; (void)is_input; return 1; }
static bool ports_get(const clap_plugin_t *p, uint32_t index, bool is_input, clap_audio_port_info_t *info) {
  (void)p;
  if (index != 0) return false;
  memset(info, 0, sizeof *info);
  info->id = 0;
  strcpy(info->name, is_input ? "in" : "out");
  info->flags = CLAP_AUDIO_PORT_IS_MAIN;
  info->channel_count = 2;
  info->port_type = CLAP_PORT_STEREO;
  info->in_place_pair = CLAP_INVALID_ID;
  return true;
}
static const clap_plugin_audio_ports_t audio_ports = { ports_count, ports_get };

#ifndef FIXTURE_PARAMS
#define FIXTURE_PARAMS 1
#endif

static uint32_t params_count(const clap_plugin_t *p) { (void)p; return FIXTURE_PARAMS; }
static bool params_info(const clap_plugin_t *p, uint32_t index, clap_param_info_t *info) {
  (void)p;
#ifdef FIXTURE_INFO_FAILS
  (void)index;
  return false;
#endif
  if (index >= FIXTURE_PARAMS) return false;
  memset(info, 0, sizeof *info);
  if (index > 0) {
    info->id = index;
    info->flags = CLAP_PARAM_IS_HIDDEN | CLAP_PARAM_IS_READONLY;
    snprintf(info->name, sizeof info->name, "p%u", index);
    info->max_value = 1.0;
    return true;
  }
  info->id = GAIN_ID;
  info->flags = CLAP_PARAM_IS_AUTOMATABLE;
  strcpy(info->name, "gain");
  info->min_value = 0.0;
  info->max_value = 2.0;
  info->default_value = 1.0;
  return true;
}
static bool params_value(const clap_plugin_t *p, clap_id id, double *value) {
  if (id != GAIN_ID) return false;
  *value = ((struct gain *)p->plugin_data)->gain;
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
  for (uint32_t i = 0; i < n; i++) gain_event(p->plugin_data, in->get(in, i));
}
static const clap_plugin_params_t params = { params_count, params_info, params_value, params_to_text, params_from_text, params_flush };

#if defined FIXTURE_DELAY && !defined FIXTURE_UNDECLARED
static uint32_t latency_get(const clap_plugin_t *p) { (void)p; return FIXTURE_DELAY; }
static const clap_plugin_latency_t latency = { latency_get };
#endif

static const void *gain_extension(const clap_plugin_t *p, const char *id) {
  (void)p;
#if defined FIXTURE_DELAY && !defined FIXTURE_UNDECLARED
  if (!strcmp(id, CLAP_EXT_LATENCY)) return &latency;
#endif
  if (!strcmp(id, CLAP_EXT_AUDIO_PORTS)) return &audio_ports;
  if (!strcmp(id, CLAP_EXT_PARAMS)) return &params;
  return NULL;
}
static void gain_main_thread(const clap_plugin_t *p) { (void)p; }

static uint32_t factory_count(const clap_plugin_factory_t *f) { (void)f; return 1; }
static const clap_plugin_descriptor_t *factory_descriptor(const clap_plugin_factory_t *f, uint32_t index) {
  (void)f;
  return index == 0 ? &descriptor : NULL;
}
static const clap_plugin_t *factory_create(const clap_plugin_factory_t *f, const clap_host_t *host, const char *id) {
  (void)f; (void)host;
  if (strcmp(id, descriptor.id)) return NULL;
  struct gain *g = calloc(1, sizeof *g);
  if (!g) return NULL;
  g->gain = 1.0;
  g->plugin = (clap_plugin_t){
    .desc = &descriptor,
    .plugin_data = g,
    .init = gain_init,
    .destroy = gain_destroy,
    .activate = gain_activate,
    .deactivate = gain_deactivate,
    .start_processing = gain_start,
    .stop_processing = gain_stop,
    .reset = gain_reset,
    .process = gain_process,
    .get_extension = gain_extension,
    .on_main_thread = gain_main_thread,
  };
  return &g->plugin;
}
static const clap_plugin_factory_t factory = { factory_count, factory_descriptor, factory_create };

static bool entry_init(const char *path) { (void)path; return true; }
static void entry_deinit(void) {}
static const void *entry_factory(const char *id) { return strcmp(id, CLAP_PLUGIN_FACTORY_ID) ? NULL : &factory; }

CLAP_EXPORT const clap_plugin_entry_t clap_entry = { CLAP_VERSION_INIT, entry_init, entry_deinit, entry_factory };
