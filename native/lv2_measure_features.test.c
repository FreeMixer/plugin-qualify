// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * lv2_measure_features.test.c — the verdict's measurement's LV2 host features and the LV2 binary door
 * (lv2-measure-features.h), openmixer's docs/design/specs/2026-09-29-host-backend-one-contract.md §3
 * "Where the providers live". Built by `make -C native` with the fixture plugins it opens, and run
 * from native/ (src/lv2-measure-native.test.ts runs it):
 *
 *   make -C native && (cd native && build/lv2_measure_features_test)
 *
 * 1. COPIED STRINGS: a URI mapped out of a caller's buffer unmaps to the same text after the
 *    caller overwrites and frees that buffer — the table never keeps a caller's pointer.
 * 2. ONE CAPACITY POLICY: 20000 distinct URIs (past every fixed cap the four former copies had:
 *    64, 1024, 4096) each map to a distinct non-zero URID that unmaps back to its own text; a
 *    second map of each answers the same id; 0 and NULL map/unmap to nothing.
 * 3. FORGET: ids restart at 1 and no old id unmaps.
 * 4. THE MASK: the list -> mask round trip in provider order; a URI with no provider refuses.
 * 5. THE ARRAY: exactly the masked kinds, provider order, NULL-terminated; options and worker
 *    data are the caller's; a mask naming data the caller did not hand over, or a bit past the
 *    kinds, is refused (NULL), never a shorter array.
 * 6. OPTIONS: rate, min 1, max and nominal = the block, typed Float/Int by URID.
 * 7. THE DOOR: the LV2 fixture .so opens to its own URI's descriptor and refuses a foreign URI at
 *    "uri", a missing path at "dlopen" and a CLAP binary at "lv2_descriptor". (openmixer's copy also
 *    drove libomx-clap-core's CLAP binary door here; that door stays in openmixer with its library.)
 */
#include "lv2-measure-features.h"

#include <dlfcn.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <lv2/atom/atom.h>
#include <lv2/buf-size/buf-size.h>
#include <lv2/parameters/parameters.h>
#include <lv2/state/state.h>


/* the RT-safe LV2 fixture's binary and URI, and a CLAP fixture, named by the Makefile */
#if !defined(TEST_LV2_SO) || !defined(TEST_LV2_URI) || !defined(TEST_CLAP)
#error "build through the Makefile: TEST_LV2_SO, TEST_LV2_URI and TEST_CLAP name the fixtures"
#endif
static int failures = 0;
#define CHECK(cond, ...)                                  \
  do {                                                    \
    if (!(cond)) {                                        \
      failures++;                                         \
      fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); \
      fprintf(stderr, __VA_ARGS__);                       \
      fprintf(stderr, "\n");                              \
    }                                                     \
  } while (0)

#define URIS_PAST_EVERY_CAP 20000u

static void test_copied_strings(void) {
  char *buf = malloc(64);
  snprintf(buf, 64, "urn:test:transient#%d", 7);
  const LV2_URID id = omx_lv2_urid_map(buf);
  memset(buf, 'X', 63);
  buf[63] = '\0';
  const char *back = omx_lv2_urid_unmap(id);
  CHECK(id != 0 && back && strcmp(back, "urn:test:transient#7") == 0,
        "a URI mapped from a caller's buffer unmaps to its text after the buffer is overwritten, got %s",
        back ? back : "(null)");
  free(buf);
  CHECK(omx_lv2_urid_map("urn:test:transient#7") == id, "the same text maps to the same id after the buffer is freed");
}

static void test_capacity(void) {
  static LV2_URID ids[URIS_PAST_EVERY_CAP];
  char uri[64];
  uint32_t zero = 0, wrong = 0, unstable = 0;
  for (uint32_t i = 0; i < URIS_PAST_EVERY_CAP; i++) {
    snprintf(uri, sizeof uri, "urn:test:cap#%u", i);
    ids[i] = omx_lv2_urid_map(uri);
    zero += ids[i] == 0;
  }
  for (uint32_t i = 0; i < URIS_PAST_EVERY_CAP; i++) {
    snprintf(uri, sizeof uri, "urn:test:cap#%u", i);
    const char *back = omx_lv2_urid_unmap(ids[i]);
    wrong += !back || strcmp(back, uri) != 0;
    unstable += omx_lv2_urid_map(uri) != ids[i];
  }
  CHECK(zero == 0, "%u URIs: every one maps to a non-zero URID, %u answered 0", URIS_PAST_EVERY_CAP, zero);
  CHECK(wrong == 0, "%u URIs: every id unmaps to its own text, %u did not", URIS_PAST_EVERY_CAP, wrong);
  CHECK(unstable == 0, "%u URIs: a second map answers the same id, %u did not", URIS_PAST_EVERY_CAP, unstable);
  CHECK(omx_lv2_urid_map(NULL) == 0, "NULL maps to 0");
  CHECK(omx_lv2_urid_unmap(0) == NULL, "0 unmaps to nothing");
}

static void test_forget(void) {
  const LV2_URID before = omx_lv2_urid_map("urn:test:cap#100");
  omx_lv2_urid_forget();
  CHECK(omx_lv2_urid_unmap(before) == NULL, "after forget, an old id unmaps to nothing");
  CHECK(omx_lv2_urid_map("urn:test:after-forget") == 1, "after forget, ids restart at 1");
}

static void test_mask(void) {
  const char *const all[] = {LV2_LOG__log, LV2_URID__map, LV2_STATE__loadDefaultState, LV2_URID__unmap,
                             LV2_BUF_SIZE__boundedBlockLength, LV2_WORKER__schedule, LV2_OPTIONS__options, NULL};
  uint32_t m = 99;
  CHECK(omx_lv2_feature_mask(all, &m) == 0 && m == (1u << OMX_LV2_FEATURE_KINDS) - 1u,
        "the seven URIs make the full mask, got %#x", m);
  CHECK(omx_lv2_feature_mask(NULL, &m) == 0 && m == 0, "the empty list is the empty mask");
  const char *const foreign[] = {LV2_URID__map, "http://example.org/ns#not-a-feature", NULL};
  m = 7;
  CHECK(omx_lv2_feature_mask(foreign, &m) == -1 && m == 7, "a listed URI with no provider refuses, mask untouched");
  for (int k = 0; k < OMX_LV2_FEATURE_KINDS; k++)
    CHECK(omx_lv2_feature_kind(OMX_LV2_FEATURE_URIS[k]) == k, "kind %d round-trips through its URI", k);
  CHECK(omx_lv2_feature_kind(NULL) == -1, "NULL has no kind");
}

static void test_array(void) {
  struct omx_lv2_options opts;
  omx_lv2_options_build(&opts, 48000.0, 256);
  LV2_Worker_Schedule sched = {NULL, NULL};
  struct omx_lv2_feature_block b;
  const uint32_t all = (1u << OMX_LV2_FEATURE_KINDS) - 1u;
  const LV2_Feature *const *f = omx_lv2_features_build(&b, all, &opts, &sched);
  CHECK(f != NULL, "the full mask builds with options and a schedule");
  for (int k = 0; f && k < OMX_LV2_FEATURE_KINDS; k++)
    CHECK(f[k] && strcmp(f[k]->URI, OMX_LV2_FEATURE_URIS[k]) == 0, "entry %d is kind %d's URI (provider order)", k, k);
  if (f) {
    CHECK(f[OMX_LV2_FEATURE_KINDS] == NULL, "NULL-terminated after the seven");
    CHECK(f[OMX_LV2_F_OPTIONS]->data == opts.opts, "options:options carries the caller's options");
    CHECK(f[OMX_LV2_F_WORKER]->data == &sched, "worker:schedule carries the caller's schedule");
    CHECK(f[OMX_LV2_F_BOUNDED]->data == NULL && f[OMX_LV2_F_DEFAULT_STATE]->data == NULL, "the flags carry no data");
    const LV2_URID_Map *map = f[OMX_LV2_F_MAP]->data;
    const LV2_URID_Unmap *unmap = f[OMX_LV2_F_UNMAP]->data;
    const LV2_URID id = map->map(map->handle, "urn:test:through-the-feature");
    CHECK(id == omx_lv2_urid_map("urn:test:through-the-feature"), "the map feature is the one table");
    const char *back = unmap->unmap(unmap->handle, id);
    CHECK(back && strcmp(back, "urn:test:through-the-feature") == 0, "the unmap feature is the one table");
    const LV2_Log_Log *log = f[OMX_LV2_F_LOG]->data;
    CHECK(log->printf(log->handle, 0, "%s", "nothing") == 0, "the log feature writes nothing");
  }
  const uint32_t probe = OMX_LV2_FEATURE_BIT(OMX_LV2_F_MAP) | OMX_LV2_FEATURE_BIT(OMX_LV2_F_OPTIONS) |
                         OMX_LV2_FEATURE_BIT(OMX_LV2_F_BOUNDED);
  f = omx_lv2_features_build(&b, probe, &opts, NULL);
  CHECK(f && f[0] && f[1] && f[2] && !f[3] && strcmp(f[0]->URI, LV2_URID__map) == 0 &&
          strcmp(f[1]->URI, LV2_OPTIONS__options) == 0 && strcmp(f[2]->URI, LV2_BUF_SIZE__boundedBlockLength) == 0,
        "a three-kind mask builds exactly those three, in provider order");
  CHECK(omx_lv2_features_build(&b, all, &opts, NULL) == NULL, "worker:schedule masked with no schedule: refused");
  CHECK(omx_lv2_features_build(&b, all, NULL, &sched) == NULL, "options:options masked with no options: refused");
  CHECK(omx_lv2_features_build(&b, 1u << OMX_LV2_FEATURE_KINDS, &opts, &sched) == NULL, "a bit past the kinds: refused");
  f = omx_lv2_features_build(&b, 0, NULL, NULL);
  CHECK(f && f[0] == NULL, "the empty mask is the empty array");
}

static void test_options(void) {
  struct omx_lv2_options o;
  omx_lv2_options_build(&o, 96000.0, 512);
  const LV2_URID t_int = omx_lv2_urid_map(LV2_ATOM__Int), t_float = omx_lv2_urid_map(LV2_ATOM__Float);
  const struct { const char *key; LV2_URID type; double value; } want[] = {
    {LV2_PARAMETERS__sampleRate, t_float, 96000.0},
    {LV2_BUF_SIZE__minBlockLength, t_int, 1},
    {LV2_BUF_SIZE__maxBlockLength, t_int, 512},
    {LV2_BUF_SIZE__nominalBlockLength, t_int, 512},
  };
  for (unsigned i = 0; i < 4; i++) {
    const LV2_Options_Option *op = &o.opts[i];
    const double v = op->type == t_float ? *(const float *)op->value : *(const int32_t *)op->value;
    CHECK(op->key == omx_lv2_urid_map(want[i].key) && op->type == want[i].type && v == want[i].value,
          "option %u is %s = %g", i, want[i].key, want[i].value);
  }
  CHECK(o.opts[4].key == 0 && o.opts[4].value == NULL, "the options end in the zero option");
}

static void test_door(void) {
  const char *why = NULL;
  void *so = NULL;
  const LV2_Descriptor *d = omx_lv2_open(&so, TEST_LV2_SO, TEST_LV2_URI, &why);
  CHECK(d && so && strcmp(d->URI, TEST_LV2_URI) == 0, "the fixture's .so opens to its own descriptor (refused at %s)",
        why ? why : "-");
  if (so) dlclose(so);
  why = NULL;
  d = omx_lv2_open(&so, TEST_LV2_SO, "urn:plugin-qualify:not-here", &why);
  CHECK(!d && !so && why && strcmp(why, "uri") == 0, "a foreign URI refuses at uri, got %s", why ? why : "-");
  why = NULL;
  d = omx_lv2_open(&so, TEST_CLAP, TEST_LV2_URI, &why);
  CHECK(!d && !so && why && strcmp(why, "lv2_descriptor") == 0, "a CLAP binary refuses as LV2 at lv2_descriptor, got %s",
        why ? why : "-");
  why = NULL;
  d = omx_lv2_open(&so, "build/no-such.so", TEST_LV2_URI, &why);
  CHECK(!d && !so && why && strcmp(why, "dlopen") == 0, "a missing path refuses as LV2 at dlopen, got %s", why ? why : "-");
}

int main(void) {
  test_copied_strings();
  test_capacity();
  test_forget();
  test_mask();
  test_array();
  test_options();
  test_door();
  if (failures) {
    fprintf(stderr, "lv2_measure_features: %d FAILED\n", failures);
    return 1;
  }
  printf("lv2_measure_features: all checks passed (%u URIs past every former cap)\n", URIS_PAST_EVERY_CAP);
  return 0;
}
