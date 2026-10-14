// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * A test preload that makes one allocation fail, so the prober's out-of-memory paths can be driven:
 *
 *   FAIL_CALLOC_NMEMB=<n>  calloc(n, ...) returns NULL
 *   FAIL_MALLOC_SIZE=<n>   malloc(n) returns NULL
 *
 * Every other call goes to glibc's own allocator. Never installed.
 */
#include <stdlib.h>

extern void *__libc_calloc(size_t, size_t);
extern void *__libc_malloc(size_t);

static size_t setting(const char *name) {
  const char *v = getenv(name);
  return v ? strtoul(v, NULL, 10) : 0;
}

__attribute__((visibility("default"))) void *calloc(size_t n, size_t size) {
  if (n && n == setting("FAIL_CALLOC_NMEMB")) return NULL;
  return __libc_calloc(n, size);
}

__attribute__((visibility("default"))) void *malloc(size_t size) {
  if (size && size == setting("FAIL_MALLOC_SIZE")) return NULL;
  return __libc_malloc(size);
}
