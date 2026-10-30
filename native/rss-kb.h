/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com> */
/* The resident set of this process in KB, -1 when it cannot be read: the one reading the two measurers take memory by. */
#ifndef OMX_NATIVE_RSS_KB_H
#define OMX_NATIVE_RSS_KB_H

#include <stdio.h>
#include <unistd.h>

static long rss_kb(void) {
  FILE *f = fopen("/proc/self/statm", "r");
  if (f == NULL) return -1;
  long total = 0, res = 0;
  if (fscanf(f, "%ld %ld", &total, &res) != 2) res = -1;
  fclose(f);
  return res > 0 ? res * (sysconf(_SC_PAGESIZE) / 1024) : -1;
}

/* How many blocks each step of a footprint runs before its reading. */
#define FOOTPRINT_BLOCKS 64
/* How long a footprint's child may take, in seconds, before it is killed and the rate is unmeasured. */
#define FOOTPRINT_TIMEOUT_S 60

#endif
