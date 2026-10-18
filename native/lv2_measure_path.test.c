// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * lv2_measure_path.test.c — the LV2 search path the measurer hands lilv (lv2-measure-path.h). Built by
 * `make -C native`; src/lv2-measure-native.test.ts runs it. Every relative segment becomes absolute
 * under the working directory, and nothing else changes: an absolute segment, the segments lilv expands
 * itself (~, $), an empty one, the order and the separators.
 */
#include "lv2-measure-path.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int failures = 0;
static void is(const char *list, const char *want) {
  char *got = lv2_path_absolute(list, "/work/dir");
  if (!got || strcmp(got, want)) {
    failures++;
    fprintf(stderr, "FAIL \"%s\": got \"%s\", want \"%s\"\n", list, got ? got : "(null)", want);
  }
  free(got);
}

int main(void) {
  is("", "");
  is("/usr/lib/lv2", "/usr/lib/lv2");
  is("lv2", "/work/dir/lv2");
  is("build/fixtures/lv2", "/work/dir/build/fixtures/lv2");
  is("../lv2", "/work/dir/../lv2");
  is(".", "/work/dir");
  is("./lv2", "/work/dir/./lv2");
  is("/a:b:/c:d/e", "/a:/work/dir/b:/c:/work/dir/d/e");
  is("a:b", "/work/dir/a:/work/dir/b");
  is("~/.lv2:$HOME/lv2", "~/.lv2:$HOME/lv2");
  is(":x:", ":/work/dir/x:");
  is("a::b", "/work/dir/a::/work/dir/b");
  is("x", "/work/dir/x");

  /* the environment: unset stays unset, a relative path is rewritten against the real working directory */
  unsetenv("LV2_PATH");
  if (lv2_path_resolve_env() != 0 || getenv("LV2_PATH")) { failures++; fprintf(stderr, "FAIL unset LV2_PATH changed\n"); }
  char cwd[4096];
  if (!getcwd(cwd, sizeof cwd)) return 2;
  setenv("LV2_PATH", "rel:/abs", 1);
  if (lv2_path_resolve_env() != 0) { failures++; fprintf(stderr, "FAIL resolve_env failed\n"); }
  char want[8192];
  snprintf(want, sizeof want, "%s/rel:/abs", cwd);
  if (!getenv("LV2_PATH") || strcmp(getenv("LV2_PATH"), want)) { failures++; fprintf(stderr, "FAIL LV2_PATH is \"%s\", want \"%s\"\n", getenv("LV2_PATH") ? getenv("LV2_PATH") : "(null)", want); }
  if (failures) return 1;
  printf("PASS lv2-measure-path\n");
  return 0;
}
