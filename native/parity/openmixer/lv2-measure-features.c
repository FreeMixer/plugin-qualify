// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * lv2-measure-features.c — the LV2 host features of the verdict's measurement (lv2-measure-features.h;
 * tools/lv2-measure.c). Control and worker threads; a plugin that maps inside run() takes the lock, which
 * the verdict's rtSafety interposer counts.
 */
#include "lv2-measure-features.h"

#include <dlfcn.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>

#include <lv2/atom/atom.h>
#include <lv2/buf-size/buf-size.h>
#include <lv2/parameters/parameters.h>
#include <lv2/state/state.h>

const char *const OMX_LV2_FEATURE_URIS[OMX_LV2_FEATURE_KINDS] = {
  [OMX_LV2_F_MAP] = LV2_URID__map,
  [OMX_LV2_F_UNMAP] = LV2_URID__unmap,
  [OMX_LV2_F_OPTIONS] = LV2_OPTIONS__options,
  [OMX_LV2_F_BOUNDED] = LV2_BUF_SIZE__boundedBlockLength,
  [OMX_LV2_F_WORKER] = LV2_WORKER__schedule,
  [OMX_LV2_F_DEFAULT_STATE] = LV2_STATE__loadDefaultState,
  [OMX_LV2_F_LOG] = LV2_LOG__log,
};

int omx_lv2_feature_kind(const char *uri) {
  for (int k = 0; uri && k < OMX_LV2_FEATURE_KINDS; k++)
    if (strcmp(OMX_LV2_FEATURE_URIS[k], uri) == 0) return k;
  return -1;
}

int omx_lv2_feature_mask(const char *const *uris, uint32_t *mask) {
  uint32_t m = 0;
  for (uint32_t i = 0; uris && uris[i]; i++) {
    const int k = omx_lv2_feature_kind(uris[i]);
    if (k < 0) return -1;
    m |= OMX_LV2_FEATURE_BIT(k);
  }
  *mask = m;
  return 0;
}

/* ---- the URI table: a URID is the index + 1 (0 is "no URID") ---- */

static struct {
  pthread_mutex_t lock;
  char **uris;
  uint32_t n, cap;
} g_urid = {PTHREAD_MUTEX_INITIALIZER, NULL, 0, 0};

LV2_URID omx_lv2_urid_map(const char *uri) {
  if (!uri) return 0;
  LV2_URID id = 0;
  pthread_mutex_lock(&g_urid.lock);
  for (uint32_t i = 0; i < g_urid.n && !id; i++)
    if (strcmp(g_urid.uris[i], uri) == 0) id = i + 1;
  if (!id) {
    if (g_urid.n == g_urid.cap && g_urid.cap <= UINT32_MAX / 2u) {
      const uint32_t cap = g_urid.cap ? 2u * g_urid.cap : 64u;
      char **grown = realloc(g_urid.uris, (size_t)cap * sizeof *grown);
      if (grown) g_urid.uris = grown, g_urid.cap = cap;
    }
    char *copy = g_urid.n < g_urid.cap ? strdup(uri) : NULL;
    if (copy) {
      g_urid.uris[g_urid.n++] = copy;
      id = g_urid.n;
    }
  }
  pthread_mutex_unlock(&g_urid.lock);
  return id;
}

const char *omx_lv2_urid_unmap(LV2_URID id) {
  pthread_mutex_lock(&g_urid.lock);
  const char *uri = id >= 1 && id <= g_urid.n ? g_urid.uris[id - 1] : NULL;
  pthread_mutex_unlock(&g_urid.lock);
  return uri;
}

void omx_lv2_urid_forget(void) {
  pthread_mutex_lock(&g_urid.lock);
  for (uint32_t i = 0; i < g_urid.n; i++) free(g_urid.uris[i]);
  free(g_urid.uris);
  g_urid.uris = NULL;
  g_urid.n = g_urid.cap = 0;
  pthread_mutex_unlock(&g_urid.lock);
}

static LV2_URID feature_map(LV2_URID_Map_Handle h, const char *uri) {
  (void)h;
  return omx_lv2_urid_map(uri);
}
static const char *feature_unmap(LV2_URID_Unmap_Handle h, LV2_URID id) {
  (void)h;
  return omx_lv2_urid_unmap(id);
}

/* log:log — formats nothing, writes nothing: a line from run() must never reach a syscall. */
static int log_vprintf(LV2_Log_Handle h, LV2_URID type, const char *fmt, va_list ap) {
  (void)h, (void)type, (void)fmt, (void)ap;
  return 0;
}
static int log_printf(LV2_Log_Handle h, LV2_URID type, const char *fmt, ...) {
  (void)h, (void)type, (void)fmt;
  return 0;
}

static LV2_URID_Map g_map = {NULL, feature_map};
static LV2_URID_Unmap g_unmap = {NULL, feature_unmap};
static LV2_Log_Log g_log = {NULL, log_printf, log_vprintf};

void omx_lv2_options_build(struct omx_lv2_options *o, double rate, uint32_t max_block) {
  const LV2_URID t_int = omx_lv2_urid_map(LV2_ATOM__Int), t_float = omx_lv2_urid_map(LV2_ATOM__Float);
  o->rate = (float)rate;
  o->min_block = 1;
  o->max_block = (int32_t)max_block;
  const LV2_Options_Option opts[5] = {
    {LV2_OPTIONS_INSTANCE, 0, omx_lv2_urid_map(LV2_PARAMETERS__sampleRate), sizeof(float), t_float, &o->rate},
    {LV2_OPTIONS_INSTANCE, 0, omx_lv2_urid_map(LV2_BUF_SIZE__minBlockLength), sizeof(int32_t), t_int, &o->min_block},
    {LV2_OPTIONS_INSTANCE, 0, omx_lv2_urid_map(LV2_BUF_SIZE__maxBlockLength), sizeof(int32_t), t_int, &o->max_block},
    {LV2_OPTIONS_INSTANCE, 0, omx_lv2_urid_map(LV2_BUF_SIZE__nominalBlockLength), sizeof(int32_t), t_int, &o->max_block},
    {LV2_OPTIONS_INSTANCE, 0, 0, 0, 0, NULL},
  };
  memcpy(o->opts, opts, sizeof opts);
}

const LV2_Feature *const *omx_lv2_features_build(struct omx_lv2_feature_block *b, uint32_t mask,
                                                 struct omx_lv2_options *options,
                                                 LV2_Worker_Schedule *schedule) {
  if (mask >> OMX_LV2_FEATURE_KINDS) return NULL;
  uint32_t n = 0;
  for (int k = 0; k < OMX_LV2_FEATURE_KINDS; k++) {
    if (!(mask & OMX_LV2_FEATURE_BIT(k))) continue;
    void *data = NULL;
    switch ((enum omx_lv2_feature_kind)k) {
      case OMX_LV2_F_MAP: data = &g_map; break;
      case OMX_LV2_F_UNMAP: data = &g_unmap; break;
      case OMX_LV2_F_LOG: data = &g_log; break;
      case OMX_LV2_F_OPTIONS:
        if (!options) return NULL;
        data = options->opts;
        break;
      case OMX_LV2_F_WORKER:
        if (!schedule) return NULL;
        data = schedule;
        break;
      case OMX_LV2_F_BOUNDED:
      case OMX_LV2_F_DEFAULT_STATE:
      case OMX_LV2_FEATURE_KINDS: break; /* flags: the promise is the presence */
    }
    b->features[n] = (LV2_Feature){OMX_LV2_FEATURE_URIS[k], data};
    b->ptrs[n] = &b->features[n];
    n++;
  }
  b->ptrs[n] = NULL;
  return b->ptrs;
}

static const LV2_Descriptor *lv2_refuse(const char **why, const char *step) {
  if (why) *why = step;
  return NULL;
}

const LV2_Descriptor *omx_lv2_open(void **so, const char *path, const char *uri, const char **why) {
  *so = dlopen(path, RTLD_NOW | RTLD_LOCAL);
  if (!*so) return lv2_refuse(why, "dlopen");
  LV2_Descriptor_Function fn;
  *(void **)&fn = dlsym(*so, "lv2_descriptor");
  const LV2_Descriptor *d = NULL;
  for (uint32_t i = 0; fn && (d = fn(i)) != NULL; i++)
    if (strcmp(d->URI, uri) == 0) return d;
  dlclose(*so);
  *so = NULL;
  return lv2_refuse(why, fn ? "uri" : "lv2_descriptor");
}
