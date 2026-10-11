// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * The scan's fixture plugin: a stereo passthrough whose controls carry what the scan must keep.
 *
 *   shape   an ENUM parameter (0..2) whose labels exist only through value_to_text: Sine, Square, Saw
 *   cutoff  a parameter in the module "Filter/Envelope"
 *   one remote-control page, "Performance" in the section "Main": cutoff, then shape, six empty slots
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <clap/clap.h>

#define SHAPE_ID 3u
#define CUTOFF_ID 5u
#define PAGE_ID 7u

static const char *const SHAPES[] = { "Sine", "Square", "Saw" };

static const char *const features[] = { CLAP_PLUGIN_FEATURE_AUDIO_EFFECT, NULL };

static const clap_plugin_descriptor_t descriptor = {
  .clap_version = CLAP_VERSION_INIT,
  .id = "org.freemixer.plugin-qualify.fixture.controls",
  .name = "controls",
  .vendor = "plugin-qualify",
  .url = "",
  .manual_url = "",
  .support_url = "",
  .version = "1",
  .description = "plugin-qualify fixture",
  .features = features,
};

static bool p_init(const clap_plugin_t *p) { (void)p; return true; }
static void p_destroy(const clap_plugin_t *p) { free((void *)p); }
static bool p_activate(const clap_plugin_t *p, double rate, uint32_t min, uint32_t max) {
  (void)p; (void)rate; (void)min; (void)max;
  return true;
}
static void p_deactivate(const clap_plugin_t *p) { (void)p; }
static bool p_start(const clap_plugin_t *p) { (void)p; return true; }
static void p_stop(const clap_plugin_t *p) { (void)p; }
static void p_reset(const clap_plugin_t *p) { (void)p; }
static clap_process_status p_process(const clap_plugin_t *p, const clap_process_t *proc) {
  (void)p;
  const clap_audio_buffer_t *in = &proc->audio_inputs[0];
  const clap_audio_buffer_t *out = &proc->audio_outputs[0];
  for (uint32_t c = 0; c < out->channel_count && c < in->channel_count; c++)
    memcpy(out->data32[c], in->data32[c], proc->frames_count * sizeof(float));
  return CLAP_PROCESS_CONTINUE;
}

static uint32_t ports_count(const clap_plugin_t *p, bool is_input) { (void)p; (void)is_input; return 1; }
static bool ports_get(const clap_plugin_t *p, uint32_t index, bool is_input, clap_audio_port_info_t *info) {
  (void)p;
  if (index != 0) return false;
  memset(info, 0, sizeof *info);
  strcpy(info->name, is_input ? "in" : "out");
  info->flags = CLAP_AUDIO_PORT_IS_MAIN;
  info->channel_count = 2;
  info->port_type = CLAP_PORT_STEREO;
  info->in_place_pair = CLAP_INVALID_ID;
  return true;
}
static const clap_plugin_audio_ports_t audio_ports = { ports_count, ports_get };

static uint32_t params_count(const clap_plugin_t *p) { (void)p; return 2; }
static bool params_info(const clap_plugin_t *p, uint32_t index, clap_param_info_t *info) {
  (void)p;
  memset(info, 0, sizeof *info);
  if (index == 0) {
    info->id = SHAPE_ID;
    info->flags = CLAP_PARAM_IS_STEPPED | CLAP_PARAM_IS_ENUM | CLAP_PARAM_IS_AUTOMATABLE;
    strcpy(info->name, "shape");
    strcpy(info->module, "Oscillator");
    info->min_value = 0.0;
    info->max_value = 2.0;
    return true;
  }
  if (index == 1) {
    info->id = CUTOFF_ID;
    info->flags = CLAP_PARAM_IS_AUTOMATABLE;
    strcpy(info->name, "cutoff");
    strcpy(info->module, "Filter/Envelope");
    info->min_value = 20.0;
    info->max_value = 20000.0;
    info->default_value = 1000.0;
    return true;
  }
  return false;
}
static bool params_value(const clap_plugin_t *p, clap_id id, double *value) {
  (void)p;
  if (id == SHAPE_ID) *value = 0.0;
  else if (id == CUTOFF_ID) *value = 1000.0;
  else return false;
  return true;
}
static bool params_to_text(const clap_plugin_t *p, clap_id id, double value, char *out, uint32_t size) {
  (void)p;
  if (id == SHAPE_ID) {
    const int i = (int)value;
    if (i < 0 || i > 2 || (double)i != value) return false;
    snprintf(out, size, "%s", SHAPES[i]);
    return true;
  }
  if (id == CUTOFF_ID) {
    snprintf(out, size, "%.0f Hz", value);
    return true;
  }
  return false;
}
static bool params_from_text(const clap_plugin_t *p, clap_id id, const char *text, double *value) {
  (void)p; (void)id; (void)text; (void)value;
  return false;
}
static void params_flush(const clap_plugin_t *p, const clap_input_events_t *in, const clap_output_events_t *out) {
  (void)p; (void)in; (void)out;
}
static const clap_plugin_params_t params = { params_count, params_info, params_value, params_to_text, params_from_text, params_flush };

static uint32_t pages_count(const clap_plugin_t *p) { (void)p; return 1; }
static bool pages_get(const clap_plugin_t *p, uint32_t index, clap_remote_controls_page_t *page) {
  (void)p;
  if (index != 0) return false;
  memset(page, 0, sizeof *page);
  strcpy(page->section_name, "Main");
  strcpy(page->page_name, "Performance");
  page->page_id = PAGE_ID;
  for (uint32_t k = 0; k < CLAP_REMOTE_CONTROLS_COUNT; k++) page->param_ids[k] = CLAP_INVALID_ID;
  page->param_ids[0] = CUTOFF_ID;
  page->param_ids[1] = SHAPE_ID;
  return true;
}
static const clap_plugin_remote_controls_t remote_controls = { pages_count, pages_get };

static const void *p_extension(const clap_plugin_t *p, const char *id) {
  (void)p;
  if (!strcmp(id, CLAP_EXT_AUDIO_PORTS)) return &audio_ports;
  if (!strcmp(id, CLAP_EXT_PARAMS)) return &params;
  if (!strcmp(id, CLAP_EXT_REMOTE_CONTROLS)) return &remote_controls;
  return NULL;
}
static void p_main_thread(const clap_plugin_t *p) { (void)p; }

static uint32_t factory_count(const clap_plugin_factory_t *f) { (void)f; return 1; }
static const clap_plugin_descriptor_t *factory_descriptor(const clap_plugin_factory_t *f, uint32_t index) {
  (void)f;
  return index == 0 ? &descriptor : NULL;
}
static const clap_plugin_t *factory_create(const clap_plugin_factory_t *f, const clap_host_t *host, const char *id) {
  (void)f; (void)host;
  if (strcmp(id, descriptor.id)) return NULL;
  clap_plugin_t *p = malloc(sizeof *p);
  if (!p) return NULL;
  *p = (clap_plugin_t){
    .desc = &descriptor,
    .plugin_data = NULL,
    .init = p_init,
    .destroy = p_destroy,
    .activate = p_activate,
    .deactivate = p_deactivate,
    .start_processing = p_start,
    .stop_processing = p_stop,
    .reset = p_reset,
    .process = p_process,
    .get_extension = p_extension,
    .on_main_thread = p_main_thread,
  };
  return p;
}
static const clap_plugin_factory_t factory = { factory_count, factory_descriptor, factory_create };

static bool entry_init(const char *path) { (void)path; return true; }
static void entry_deinit(void) {}
static const void *entry_factory(const char *id) { return strcmp(id, CLAP_PLUGIN_FACTORY_ID) ? NULL : &factory; }

CLAP_EXPORT const clap_plugin_entry_t clap_entry = { CLAP_VERSION_INIT, entry_init, entry_deinit, entry_factory };
