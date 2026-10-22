// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * lv2_measure_options.test.c — the feature options the LV2 measurer runs under (lv2-measure-options.h),
 * over omx-clap-core's provider. Built by `make -C native`; src/lv2-measure-native.test.ts runs it:
 *
 *   make -C native && native/build/lv2_measure_options_test
 *
 * 1. THE DEFAULTS BUILD THE ARRAY THE MEASURER HAS ALWAYS HANDED A PLUGIN: urid:map, urid:unmap,
 *    options:options, bufsz:boundedBlockLength, worker:schedule, log:log, in that order and nothing
 *    else; the options param:sampleRate (Float), minBlockLength 1, maxBlockLength and
 *    nominalBlockLength the block (Int); the log silent; no plugin refused for what it requires.
 * 2. EVERY FLAG SETS ITS OPTION, and the array the provider builds from it shows it.
 * 3. A BAD VALUE IS REFUSED, a word that is not one of these flags is left for the caller.
 * 4. THE RECORD NAMES THE OPTIONS: featureOptions, exactly, under the defaults and with a capture.
 */
#include "lv2-measure-options.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <lv2/atom/atom.h>
#include <lv2/buf-size/buf-size.h>
#include <lv2/parameters/parameters.h>
#include <lv2/state/state.h>

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

static size_t count(const LV2_Feature *const *f) {
  size_t n = 0;
  while (f && f[n]) n++;
  return n;
}

static const LV2_Feature *find(const LV2_Feature *const *f, const char *uri) {
  for (size_t i = 0; f && f[i]; i++)
    if (!strcmp(f[i]->URI, uri)) return f[i];
  return NULL;
}

/* the value of the option keyed `key`, as a double; NAN-free: -1 when absent or of another type */
static double option(const LV2_Feature *const *f, const char *key, const char *type) {
  const LV2_Feature *o = find(f, LV2_OPTIONS__options);
  if (!o) return -1;
  for (const LV2_Options_Option *op = o->data; op->key; op++) {
    if (op->key != omx_lv2_urid_map(key)) continue;
    if (op->type != omx_lv2_urid_map(type)) return -1;
    return op->type == omx_lv2_urid_map(LV2_ATOM__Float) ? *(const float *)op->value : *(const int32_t *)op->value;
  }
  return -1;
}

static int parse(struct lv2_measure_options *o, const char *flag, const char *value, const char **why) {
  char *argv[] = {(char *)flag, (char *)value, NULL};
  int i = 0;
  return lv2_measure_option_parse(o, value ? 2 : 1, argv, &i, why);
}

static void test_defaults_build_the_former_array(void) {
  struct lv2_measure_options o;
  lv2_measure_options_init(&o);
  LV2_Worker_Schedule sched = {NULL, NULL};
  struct omx_lv2_feature_block b;
  const LV2_Feature *const *f = omx_lv2_features_build(&b, &o.feature, 96000.0, 512, 512, &sched);
  static const char *const former[] = {LV2_URID__map, LV2_URID__unmap, LV2_OPTIONS__options,
                                       LV2_BUF_SIZE__boundedBlockLength, LV2_WORKER__schedule, LV2_LOG__log};
  CHECK(f != NULL, "the defaults build");
  CHECK(count(f) == 9, "the defaults build the six former features and the three rtmempool entries, got %zu", count(f));
  for (size_t k = 0; f && k < 6 && k < count(f); k++)
    CHECK(!strcmp(f[k]->URI, former[k]), "entry %zu is %s, got %s", k, former[k], f[k]->URI);
  CHECK(find(f, LV2_STATE__loadDefaultState) == NULL, "state:loadDefaultState is not offered");
  CHECK(find(f, LV2_BUF_SIZE__fixedBlockLength) == NULL && find(f, LV2_BUF_SIZE__powerOf2BlockLength) == NULL,
        "neither fixed nor power-of-2 blocks are declared");
  const LV2_Feature *w = find(f, LV2_WORKER__schedule), *bd = find(f, LV2_BUF_SIZE__boundedBlockLength);
  CHECK(w && w->data == &sched, "worker:schedule carries the instance's schedule");
  CHECK(bd && bd->data == NULL, "boundedBlockLength is a flag");
  CHECK(option(f, LV2_PARAMETERS__sampleRate, LV2_ATOM__Float) == 96000.0, "sampleRate 96000 as a Float");
  CHECK(option(f, LV2_BUF_SIZE__minBlockLength, LV2_ATOM__Int) == 1, "minBlockLength 1");
  CHECK(option(f, LV2_BUF_SIZE__maxBlockLength, LV2_ATOM__Int) == 512, "maxBlockLength the block");
  CHECK(option(f, LV2_BUF_SIZE__nominalBlockLength, LV2_ATOM__Int) == 512, "nominalBlockLength the block");
  const LV2_Feature *lf = find(f, LV2_LOG__log);
  const LV2_Log_Log *log = lf ? lf->data : NULL;
  CHECK(log && log->printf(log->handle, 0, "%s", "nothing") == 0, "the log formats nothing");
  const char *const needs_state[] = {LV2_URID__map, LV2_STATE__loadDefaultState, "http://lv2plug.in/ns/lv2core#inPlaceBroken",
                                     NULL};
  const char *missing = NULL;
  CHECK(omx_lv2_features_admit(&o.feature, needs_state, &missing) == 0 && missing &&
          !strcmp(missing, LV2_STATE__loadDefaultState),
        "not strict: a plugin requiring what is not offered is handed over, the first missing named");
  CHECK(o.feature.log.mode == OMX_LV2_LOG_SILENT && o.capture_bytes == LV2_MEASURE_CAPTURE_BYTES_DEFAULT,
        "silent, the capture's default size kept");
}

static void test_flags_reach_the_array(void) {
  struct lv2_measure_options o;
  const char *why = NULL;
  LV2_Worker_Schedule sched = {NULL, NULL};
  struct omx_lv2_feature_block b;

  lv2_measure_options_init(&o);
  CHECK(parse(&o, "--features", "map,options,bounded", &why) == 1, "--features takes a list");
  const LV2_Feature *const *f = omx_lv2_features_build(&b, &o.feature, 48000.0, 64, 64, NULL);
  CHECK(count(f) == 3 && find(f, LV2_URID__map) && find(f, LV2_OPTIONS__options) &&
          find(f, LV2_BUF_SIZE__boundedBlockLength),
        "--features map,options,bounded builds exactly those three");
  CHECK(parse(&o, "--features", "", &why) == 1 && o.feature.features == 0, "--features '' offers none");
  CHECK(parse(&o, "--features", "map,unmap,options,bounded,worker,default-state,log,rtmempool", &why) == 1 &&
          o.feature.features == OMX_LV2_FEATURES_ALL,
        "every kind by name");

  lv2_measure_options_init(&o);
  CHECK(parse(&o, "--block-declares", "bounded,fixed,pow2", &why) == 1, "--block-declares takes a list");
  f = omx_lv2_features_build(&b, &o.feature, 48000.0, 64, 64, &sched);
  CHECK(count(f) == 11 && !strcmp(f[7]->URI, LV2_BUF_SIZE__fixedBlockLength) &&
          !strcmp(f[8]->URI, LV2_BUF_SIZE__powerOf2BlockLength),
        "fixed and power-of-2 are declared after the first rtmempool entry, the other two spellings last");
  CHECK(parse(&o, "--block-declares", "", &why) == 1, "--block-declares '' makes none");
  f = omx_lv2_features_build(&b, &o.feature, 48000.0, 64, 64, &sched);
  CHECK(count(f) == 8 && find(f, LV2_BUF_SIZE__boundedBlockLength) == NULL, "no declaration, no bounded");

  lv2_measure_options_init(&o);
  CHECK(parse(&o, "--block-min", "16", &why) == 1 && parse(&o, "--block-max", "2048", &why) == 1 &&
          parse(&o, "--block-nominal", "256", &why) == 1,
        "the three block lengths");
  f = omx_lv2_features_build(&b, &o.feature, 48000.0, 64, 64, &sched);
  CHECK(option(f, LV2_BUF_SIZE__minBlockLength, LV2_ATOM__Int) == 16 &&
          option(f, LV2_BUF_SIZE__maxBlockLength, LV2_ATOM__Int) == 2048 &&
          option(f, LV2_BUF_SIZE__nominalBlockLength, LV2_ATOM__Int) == 256,
        "the block lengths reported are the flags'");
  CHECK(parse(&o, "--block-min", "0", &why) == 1 && parse(&o, "--block-max", "0", &why) == 1 &&
          parse(&o, "--block-nominal", "0", &why) == 1,
        "0 is the run's");
  f = omx_lv2_features_build(&b, &o.feature, 48000.0, 64, 64, &sched);
  CHECK(option(f, LV2_BUF_SIZE__minBlockLength, LV2_ATOM__Int) == 64 &&
          option(f, LV2_BUF_SIZE__nominalBlockLength, LV2_ATOM__Int) == 64,
        "0: the run's block, and the nominal the maximum");

  lv2_measure_options_init(&o);
  CHECK(parse(&o, "--strict", NULL, &why) == 1 && o.feature.strict == 1, "--strict");
  {
    char *argv[] = {"--strict", "urn:x", NULL};
    int i = 0;
    CHECK(lv2_measure_option_parse(&o, 2, argv, &i, &why) == 1 && i == 1, "a switch is taken alone, past it");
    argv[0] = "--block-max";
    i = 0;
    CHECK(lv2_measure_option_parse(&o, 2, argv, &i, &why) == -1, "a valued flag's value must be a length");
    argv[1] = "64";
    i = 0;
    CHECK(lv2_measure_option_parse(&o, 2, argv, &i, &why) == 1 && i == 2, "a valued flag is taken with its value");
    o.feature.block.max = 0;
  }
  const char *const needs_state[] = {LV2_STATE__loadDefaultState, NULL};
  const char *missing = NULL;
  CHECK(omx_lv2_features_admit(&o.feature, needs_state, &missing) == -1 && missing &&
          !strcmp(missing, LV2_STATE__loadDefaultState),
        "strict: a plugin requiring loadDefaultState is refused, named");
  CHECK(parse(&o, "--no-strict", NULL, &why) == 1 && o.feature.strict == 0, "--no-strict");

  CHECK(parse(&o, "--log", "route", &why) == 1 && o.feature.log.mode == OMX_LV2_LOG_ROUTE, "--log route");
  CHECK(parse(&o, "--log", "capture", &why) == 1 && o.feature.log.mode == OMX_LV2_LOG_CAPTURE, "--log capture");
  CHECK(parse(&o, "--log-capture-bytes", "64", &why) == 1 && o.capture_bytes == 64, "--log-capture-bytes");
  char buf[64] = "";
  o.feature.log.capture = buf;
  o.feature.log.capture_size = sizeof buf;
  f = omx_lv2_features_build(&b, &o.feature, 48000.0, 64, 64, &sched);
  const LV2_Feature *lf = find(f, LV2_LOG__log);
  const LV2_Log_Log *log = lf ? lf->data : NULL;
  if (log) log->printf(log->handle, omx_lv2_urid_map(LV2_LOG__Note), "gain %d", 3);
  CHECK(!strcmp(buf, "gain 3\n"), "--log capture: the line in the buffer, got \"%s\"", buf);
}

static void test_refusals(void) {
  struct lv2_measure_options o;
  lv2_measure_options_init(&o);
  const struct lv2_measure_options before = o;
  const char *why = NULL;
  static const char *const bad[][2] = {
    {"--features", "map,midi"}, {"--features", "map,,log"}, {"--block-declares", "variable"},
    {"--block-min", "-1"},      {"--block-max", "12k"},     {"--block-nominal", ""},
    {"--block-max", "4294967296"}, {"--log", "loud"},       {"--log-capture-bytes", "1"},
  };
  for (size_t k = 0; k < sizeof bad / sizeof *bad; k++) {
    why = NULL;
    CHECK(parse(&o, bad[k][0], bad[k][1], &why) == -1 && why, "%s '%s' is refused", bad[k][0], bad[k][1]);
  }
  CHECK(o.feature.features == before.feature.features && o.feature.strict == before.feature.strict &&
          o.feature.block.declares == before.feature.block.declares && o.feature.block.min == before.feature.block.min &&
          o.feature.block.max == before.feature.block.max && o.feature.block.nominal == before.feature.block.nominal &&
          o.feature.log.mode == before.feature.log.mode && o.capture_bytes == before.capture_bytes,
        "a refused value changes nothing");
  CHECK(parse(&o, "--features", NULL, &why) == -1, "a flag with no value is refused");
  char *argv[] = {"--pin", "x", NULL};
  int i = 0;
  CHECK(lv2_measure_option_parse(&o, 2, argv, &i, &why) == 0 && i == 0, "another flag is the caller's, untouched");
}

static char *printed(const struct lv2_measure_options *o, const char *capture) {
  static char out[1024];
  FILE *f = fmemopen(out, sizeof out, "w");
  lv2_measure_options_print(f, o, capture);
  fclose(f);
  return out;
}

static void test_record(void) {
  struct lv2_measure_options o;
  lv2_measure_options_init(&o);
  const char *want = ",\"featureOptions\":{\"features\":[\"map\",\"unmap\",\"options\",\"bounded\",\"worker\",\"log\",\"rtmempool\"],"
                     "\"strict\":false,\"block\":{\"declares\":[\"bounded\"],\"min\":1,\"max\":0,\"nominal\":0},"
                     "\"log\":{\"mode\":\"silent\"}}";
  const char *got = printed(&o, NULL);
  CHECK(!strcmp(got, want), "the defaults' record:\n  want %s\n  got  %s", want, got);
  const char *why = NULL;
  parse(&o, "--features", "", &why);
  parse(&o, "--strict", NULL, &why);
  parse(&o, "--block-declares", "fixed,pow2", &why);
  parse(&o, "--block-max", "1024", &why);
  parse(&o, "--log", "capture", &why);
  parse(&o, "--log-capture-bytes", "128", &why);
  want = ",\"featureOptions\":{\"features\":[],\"strict\":true,\"block\":{\"declares\":[\"fixed\",\"pow2\"],\"min\":1,"
         "\"max\":1024,\"nominal\":0},\"log\":{\"mode\":\"capture\",\"bytes\":128,\"lines\":\"say \\\"hi\\\"\\u000a\"}}";
  got = printed(&o, "say \"hi\"\n");
  CHECK(!strcmp(got, want), "a changed record:\n  want %s\n  got  %s", want, got);
}

int main(void) {
  test_defaults_build_the_former_array();
  test_flags_reach_the_array();
  test_refusals();
  test_record();
  if (failures) {
    fprintf(stderr, "lv2_measure_options: %d FAILED\n", failures);
    return 1;
  }
  printf("lv2_measure_options: all checks passed\n");
  return 0;
}
