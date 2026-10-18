// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
// lv2-measure-path.h: the LV2 search path made absolute before lilv reads it.
#include "lv2-measure-path.h"

#include <errno.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

char *lv2_path_absolute(const char *list, const char *cwd) {
  const size_t cwd_len = strlen(cwd);
  /* worst case: every segment relative and one character long, each gaining the working directory and a slash */
  size_t segments = 1;
  for (const char *p = list; *p; p++) segments += *p == ':';
  char *out = malloc(strlen(list) + segments * (cwd_len + 1) + 1);
  if (!out) return NULL;
  char *w = out;
  for (const char *seg = list;;) {
    const char *end = strchr(seg, ':');
    const size_t len = end ? (size_t)(end - seg) : strlen(seg);
    const int own = len == 0 || seg[0] == '/' || seg[0] == '~' || seg[0] == '$';
    if (!own) {
      memcpy(w, cwd, cwd_len);
      w += cwd_len;
      if (!(len == 1 && seg[0] == '.')) {
        *w++ = '/';
        memcpy(w, seg, len);
        w += len;
      }
    } else {
      memcpy(w, seg, len);
      w += len;
    }
    if (!end) break;
    *w++ = ':';
    seg = end + 1;
  }
  *w = '\0';
  return out;
}

int lv2_path_resolve_env(void) {
  const char *list = getenv("LV2_PATH");
  if (!list || !*list) return 0;
  char cwd[PATH_MAX];
  if (!getcwd(cwd, sizeof cwd)) return -1;
  char *abs = lv2_path_absolute(list, cwd);
  if (!abs) {
    errno = ENOMEM;
    return -1;
  }
  const int rc = setenv("LV2_PATH", abs, 1);
  free(abs);
  return rc;
}
