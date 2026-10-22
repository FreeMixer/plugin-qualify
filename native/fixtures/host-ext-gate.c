// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * The rt-safe gain (see gain.c), whose `init()` also requires one host extension the prober did not
 * offer before #133 — the known headless-failed effect before the host offered it, the known
 * suitable one after. Built three times:
 *
 *   requires-voice-info.clap    -DFIXTURE_REQUIRES=REQ_VOICE_INFO
 *                                init() requires clap.voice-info: a host offering only the original
 *                                six fails it here, headless.
 *   requires-timer.clap         -DFIXTURE_REQUIRES=REQ_TIMER
 *                                init() requires clap.timer-support, and registers and unregisters
 *                                one timer there: a host that offers the extension but answers
 *                                register or unregister wrong fails init() the same as one offering
 *                                nothing.
 *   requires-thread-pool.clap   -DFIXTURE_REQUIRES=REQ_THREAD_POOL
 *                                init() requires clap.thread-pool; process() asks it to run two
 *                                tasks through request_exec and returns CLAP_PROCESS_ERROR unless
 *                                both landed in its own exec() callback: a host that offers the
 *                                extension but never calls back is unsuitable on the process-error
 *                                count the same as a thread violation would be.
 *
 * Otherwise the known RT-safe gain: one stereo pass-through, one gain parameter, no allocation.
 */
#include <stdlib.h>
#include <string.h>

#include <clap/clap.h>

#define REQ_VOICE_INFO 1
#define REQ_TIMER 2
#define REQ_THREAD_POOL 3

#if FIXTURE_REQUIRES == REQ_VOICE_INFO
#define FIXTURE_ID "org.freemixer.plugin-qualify.fixture.requires-voice-info"
#define FIXTURE_NAME "gain requiring clap.voice-info"
#elif FIXTURE_REQUIRES == REQ_TIMER
#define FIXTURE_ID "org.freemixer.plugin-qualify.fixture.requires-timer"
#define FIXTURE_NAME "gain requiring clap.timer-support"
#elif FIXTURE_REQUIRES == REQ_THREAD_POOL
#define FIXTURE_ID "org.freemixer.plugin-qualify.fixture.requires-thread-pool"
#define FIXTURE_NAME "gain requiring clap.thread-pool"
#else
#error "FIXTURE_REQUIRES must be REQ_VOICE_INFO, REQ_TIMER or REQ_THREAD_POOL"
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
  const clap_host_t *host;
  double gain;
#if FIXTURE_REQUIRES == REQ_THREAD_POOL
  const clap_plugin_thread_pool_t *self_thread_pool;
  uint32_t tasks_run;
#endif
};

static bool gain_init(const clap_plugin_t *p) {
  struct gain *g = p->plugin_data;
#if FIXTURE_REQUIRES == REQ_VOICE_INFO
  return g->host->get_extension(g->host, CLAP_EXT_VOICE_INFO) != NULL;
#elif FIXTURE_REQUIRES == REQ_TIMER
  const clap_host_timer_support_t *timer = g->host->get_extension(g->host, CLAP_EXT_TIMER_SUPPORT);
  clap_id id;
  if (!timer || !timer->register_timer || !timer->unregister_timer) return false;
  if (!timer->register_timer(g->host, 30, &id)) return false;
  return timer->unregister_timer(g->host, id);
#elif FIXTURE_REQUIRES == REQ_THREAD_POOL
  return g->host->get_extension(g->host, CLAP_EXT_THREAD_POOL) != NULL;
#endif
}
static void gain_destroy(const clap_plugin_t *p) { free(p->plugin_data); }
static bool gain_activate(const clap_plugin_t *p, double rate, uint32_t min, uint32_t max) {
  (void)p; (void)rate; (void)min; (void)max;
  return true;
}
static void gain_deactivate(const clap_plugin_t *p) { (void)p; }
static bool gain_start(const clap_plugin_t *p) { (void)p; return true; }
static void gain_stop(const clap_plugin_t *p) { (void)p; }
static void gain_reset(const clap_plugin_t *p) { (void)p; }

static void gain_event(struct gain *g, const clap_event_header_t *e) {
  if (e->space_id != CLAP_CORE_EVENT_SPACE_ID || e->type != CLAP_EVENT_PARAM_VALUE) return;
  const clap_event_param_value_t *v = (const clap_event_param_value_t *)e;
  if (v->param_id == GAIN_ID) g->gain = v->value;
}

#if FIXTURE_REQUIRES == REQ_THREAD_POOL
static void gain_exec(const clap_plugin_t *p, uint32_t task_index) {
  (void)task_index;
  ((struct gain *)p->plugin_data)->tasks_run++;
}
static const clap_plugin_thread_pool_t self_thread_pool_vtable = { gain_exec };
#define THREAD_POOL_TASKS 2u
#endif

static clap_process_status gain_process(const clap_plugin_t *p, const clap_process_t *proc) {
  struct gain *g = p->plugin_data;
  const uint32_t n = proc->in_events->size(proc->in_events);
  for (uint32_t i = 0; i < n; i++) gain_event(g, proc->in_events->get(proc->in_events, i));
  if (proc->audio_inputs_count < 1 || proc->audio_outputs_count < 1) return CLAP_PROCESS_ERROR;
  const clap_audio_buffer_t *in = &proc->audio_inputs[0];
  const clap_audio_buffer_t *out = &proc->audio_outputs[0];
#if FIXTURE_REQUIRES == REQ_THREAD_POOL
  g->tasks_run = 0;
  const clap_host_thread_pool_t *pool = g->host->get_extension(g->host, CLAP_EXT_THREAD_POOL);
  if (!pool || !pool->request_exec(g->host, THREAD_POOL_TASKS) || g->tasks_run != THREAD_POOL_TASKS) return CLAP_PROCESS_ERROR;
#endif
  for (uint32_t c = 0; c < out->channel_count && c < in->channel_count; c++)
    for (uint32_t i = 0; i < proc->frames_count; i++) out->data32[c][i] = (float)(in->data32[c][i] * g->gain);
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

static uint32_t params_count(const clap_plugin_t *p) { (void)p; return 1; }
static bool params_info(const clap_plugin_t *p, uint32_t index, clap_param_info_t *info) {
  (void)p;
  if (index != 0) return false;
  memset(info, 0, sizeof *info);
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

static const void *gain_extension(const clap_plugin_t *p, const char *id) {
  (void)p;
  if (!strcmp(id, CLAP_EXT_AUDIO_PORTS)) return &audio_ports;
  if (!strcmp(id, CLAP_EXT_PARAMS)) return &params;
#if FIXTURE_REQUIRES == REQ_THREAD_POOL
  if (!strcmp(id, CLAP_EXT_THREAD_POOL)) return &self_thread_pool_vtable;
#endif
  return NULL;
}
static void gain_main_thread(const clap_plugin_t *p) { (void)p; }

static uint32_t factory_count(const clap_plugin_factory_t *f) { (void)f; return 1; }
static const clap_plugin_descriptor_t *factory_descriptor(const clap_plugin_factory_t *f, uint32_t index) {
  (void)f;
  return index == 0 ? &descriptor : NULL;
}
static const clap_plugin_t *factory_create(const clap_plugin_factory_t *f, const clap_host_t *host, const char *id) {
  (void)f;
  if (strcmp(id, descriptor.id)) return NULL;
  struct gain *g = calloc(1, sizeof *g);
  if (!g) return NULL;
  g->host = host;
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
