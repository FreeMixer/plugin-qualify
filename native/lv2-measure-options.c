// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * lv2-measure-options.c — the feature options the LV2 measurer runs under (lv2-measure-options.h).
 */
#include "lv2-measure-options.h"

#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

const char *const LV2_MEASURE_FEATURE_NAMES[OMX_LV2_FEATURE_KINDS] = {
  [OMX_LV2_F_MAP] = "map",
  [OMX_LV2_F_UNMAP] = "unmap",
  [OMX_LV2_F_OPTIONS] = "options",
  [OMX_LV2_F_BOUNDED] = "bounded",
  [OMX_LV2_F_WORKER] = "worker",
  [OMX_LV2_F_DEFAULT_STATE] = "default-state",
  [OMX_LV2_F_LOG] = "log",
  [OMX_LV2_F_RTMEMPOOL] = "rtmempool",
};

/* bit d of block.declares */
const char *const LV2_MEASURE_DECLARATION_NAMES[3] = {"bounded", "fixed", "pow2"};

static const char *const LOG_MODE_NAMES[] = {
  [OMX_LV2_LOG_SILENT] = "silent",
  [OMX_LV2_LOG_ROUTE] = "route",
  [OMX_LV2_LOG_CAPTURE] = "capture",
};

const char LV2_MEASURE_OPTIONS_HELP[] =
  "feature options (omx-clap-core's LV2 feature provider; the record's featureOptions names them):\n"
  "  --features LIST        kinds offered: map,unmap,options,bounded,worker,default-state,log,rtmempool\n"
  "                         (default: all but default-state; empty: none)\n"
  "  --strict               refuse a plugin requiring a feature not offered\n"
  "  --no-strict            hand it to its own instantiate without it (default)\n"
  "  --block-declares LIST  buf-size declarations when bounded is offered: bounded,fixed,pow2\n"
  "                         (default: bounded; empty: none)\n"
  "  --block-min N          bufsz:minBlockLength (default: 1; 0: the run's block)\n"
  "  --block-max N          bufsz:maxBlockLength (default: 0, the run's block)\n"
  "  --block-nominal N      bufsz:nominalBlockLength (default: 0, the maximum)\n"
  "  --log MODE             log:log lines: silent, route (to stderr) or capture (into the record)\n"
  "                         (default: silent)\n"
  "  --log-capture-bytes N  the capture buffer, its NUL included (default: 4096)\n";

void lv2_measure_options_init(struct lv2_measure_options *o) {
  omx_lv2_feature_options_init(&o->feature);
  o->feature.features &= ~OMX_LV2_FEATURE_BIT(OMX_LV2_F_DEFAULT_STATE);
  o->feature.strict = 0;
  o->feature.block.min = 1;
  o->capture_bytes = LV2_MEASURE_CAPTURE_BYTES_DEFAULT;
}

/* The bits of a comma-separated list of `names`; -1 for a name not among them or an empty item. */
static int name_bits(const char *list, const char *const *names, unsigned n, uint32_t *bits) {
  uint32_t m = 0;
  const char *p = list;
  if (*p == '\0') {
    *bits = 0;
    return 0;
  }
  for (;;) {
    const char *end = strchr(p, ',');
    const size_t len = end ? (size_t)(end - p) : strlen(p);
    unsigned k = 0;
    while (k < n && !(strlen(names[k]) == len && strncmp(names[k], p, len) == 0)) k++;
    if (k == n) return -1;
    m |= 1u << k;
    if (!end) break;
    p = end + 1;
  }
  *bits = m;
  return 0;
}

static int length_of(const char *text, uint32_t *v) {
  char *end = NULL;
  errno = 0;
  const unsigned long n = strtoul(text, &end, 10);
  if (errno || end == text || *end != '\0' || text[0] == '-' || n > (unsigned long)INT32_MAX) return -1;
  *v = (uint32_t)n;
  return 0;
}

static int refuse(const char **why, const char *what) {
  *why = what;
  return -1;
}

int lv2_measure_option_parse(struct lv2_measure_options *o, int argc, char **argv, int *i, const char **why) {
  const char *flag = argv[*i];
  if (!strcmp(flag, "--strict") || !strcmp(flag, "--no-strict")) {
    o->feature.strict = flag[2] == 's';
    *i += 1;
    return 1;
  }
  static const char *const valued[] = {"--features", "--block-declares", "--block-min", "--block-max",
                                       "--block-nominal", "--log", "--log-capture-bytes"};
  unsigned f = 0;
  while (f < sizeof valued / sizeof *valued && strcmp(flag, valued[f]) != 0) f++;
  if (f == sizeof valued / sizeof *valued) return 0;
  if (*i + 1 >= argc) return refuse(why, "the flag needs a value");
  const char *v = argv[*i + 1];
  uint32_t n = 0;
  switch (f) {
    case 0:
      if (name_bits(v, LV2_MEASURE_FEATURE_NAMES, OMX_LV2_FEATURE_KINDS, &n) != 0)
        return refuse(why, "--features takes map,unmap,options,bounded,worker,default-state,log,rtmempool");
      o->feature.features = n;
      break;
    case 1:
      if (name_bits(v, LV2_MEASURE_DECLARATION_NAMES, 3, &n) != 0)
        return refuse(why, "--block-declares takes bounded,fixed,pow2");
      o->feature.block.declares = n;
      break;
    case 2:
    case 3:
    case 4:
      if (length_of(v, &n) != 0) return refuse(why, "a block length is a number of frames, 0 the run's");
      if (f == 2) o->feature.block.min = n;
      else if (f == 3) o->feature.block.max = n;
      else o->feature.block.nominal = n;
      break;
    case 5: {
      unsigned m = 0;
      while (m < sizeof LOG_MODE_NAMES / sizeof *LOG_MODE_NAMES && strcmp(v, LOG_MODE_NAMES[m]) != 0) m++;
      if (m == sizeof LOG_MODE_NAMES / sizeof *LOG_MODE_NAMES) return refuse(why, "--log takes silent, route or capture");
      o->feature.log.mode = (enum omx_lv2_log_mode)m;
      break;
    }
    default:
      if (length_of(v, &n) != 0 || n < 2) return refuse(why, "--log-capture-bytes takes a size of at least 2");
      o->capture_bytes = n;
      break;
  }
  *i += 2;
  return 1;
}

static void json_text(FILE *out, const char *s) {
  fputc('"', out);
  for (const unsigned char *p = (const unsigned char *)s; p && *p; p++) {
    if (*p == '"' || *p == '\\') fprintf(out, "\\%c", *p);
    else if (*p < 0x20) fprintf(out, "\\u%04x", *p);
    else fputc(*p, out);
  }
  fputc('"', out);
}

static void json_names(FILE *out, uint32_t bits, const char *const *names, unsigned n) {
  fputc('[', out);
  for (unsigned k = 0, first = 1; k < n; k++) {
    if (!(bits & (1u << k))) continue;
    fprintf(out, "%s\"%s\"", first ? "" : ",", names[k]);
    first = 0;
  }
  fputc(']', out);
}

void lv2_measure_options_print(FILE *out, const struct lv2_measure_options *o, const char *capture) {
  const struct omx_lv2_feature_options *f = &o->feature;
  fputs(",\"featureOptions\":{\"features\":", out);
  json_names(out, f->features, LV2_MEASURE_FEATURE_NAMES, OMX_LV2_FEATURE_KINDS);
  fprintf(out, ",\"strict\":%s,\"block\":{\"declares\":", f->strict ? "true" : "false");
  json_names(out, f->block.declares, LV2_MEASURE_DECLARATION_NAMES, 3);
  fprintf(out, ",\"min\":%u,\"max\":%u,\"nominal\":%u},\"log\":{\"mode\":\"%s\"", f->block.min, f->block.max,
          f->block.nominal, LOG_MODE_NAMES[f->log.mode]);
  if (f->log.mode == OMX_LV2_LOG_CAPTURE) {
    fprintf(out, ",\"bytes\":%zu,\"lines\":", o->capture_bytes);
    json_text(out, capture ? capture : "");
  }
  fputs("}}", out);
}
