// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * rt-interpose — counts the things a plugin must never do on the audio thread.
 *
 * The rtSafety dimension is `allocationsInRun = syscallsInRun =
 * locksInRun = 0`, measured INSIDE process() and across a parameter sweep. A plugin that
 * allocates once per block is fine in a mod-host process, where the damage is one
 * process's xrun; on the console's RT thread the same malloc is the whole desk
 * dropping out. So the figure has to come from a counter, not from reading source.
 *
 * WHY LD_PRELOAD AND NOT A WRAPPER. The calls we care about happen inside the
 * plugin's .so, which we do not compile and cannot instrument. Interposing the libc
 * symbols is the only way to see what the plugin actually does rather than what its
 * documentation claims. The counters are armed only between omx_rt_begin() and
 * omx_rt_end(), so the host's own setup allocations — the plugin's activation, port
 * buffers, the sweep's own bookkeeping — are never counted against the plugin.
 *
 * THE WINDOW IS THE MEASUREMENT. Arming around the whole render would count the
 * host; arming around one process() call counts the plugin. The host arms per block and
 * accumulates, so a plugin that allocates on its FIRST block only (a lazy table
 * build) is still caught, and the warm-up blocks the host discards are the reason a
 * lazy allocation does not read as a per-block one.
 *
 * Deliberately single-threaded in its accounting: `armed` is a plain int, not an
 * atomic, because the audio thread is the only thread that arms it. A plugin's
 * worker thread allocating while the audio thread is armed WILL be counted — that is
 * correct, not a race: a worker allocation during process() is exactly the "spawns a
 * thread that fights the RT thread" caution that keeps a plugin isolated.
 *
 *   make -C native                      (builds native/build/rt_interpose.so)
 *   LD_PRELOAD=$PWD/native/build/rt_interpose.so native/build/clap-qualify ...
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <pthread.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>
#include <execinfo.h>
#include "rt-interpose.h"

/* Counters. Read by the host through dlsym after the render. */
static uint64_t n_alloc, n_lock, n_syscall;
static int armed;

/* The first events, with their backtraces, so a count becomes a fact. backtrace() can
 * allocate on its first use (the unwinder's lazy init), so omx_rt_reset() warms it OUTSIDE
 * any armed window, and in_record keeps the unwinder's own calls out of both the counters
 * and the ring while a record is being taken. */
static struct omx_rt_event events[OMX_RT_EV_MAX];
static int n_events;
static int in_record;

static void record(int kind) {
  if (!armed || in_record || n_events >= OMX_RT_EV_MAX) return;
  in_record = 1;
  struct omx_rt_event *e = &events[n_events];
  e->kind = kind;
  e->depth = backtrace(e->frames, OMX_RT_EV_DEPTH);
  n_events++;
  in_record = 0;
}

/* The real symbols, resolved once, lazily. */
static void *(*real_malloc)(size_t);
static void *(*real_calloc)(size_t, size_t);
static void *(*real_realloc)(void *, size_t);
static void (*real_free)(void *);
static int (*real_mutex_lock)(pthread_mutex_t *);
static int (*real_mutex_trylock)(pthread_mutex_t *);

/*
 * calloc during dlsym bootstrap: dlsym itself may call calloc before real_calloc is
 * resolved, which would recurse forever. A small static arena answers those few
 * early allocations. This is the standard interposer bootstrap, not a workaround for
 * anything in the plugins.
 */
static char boot_arena[65536];
static size_t boot_used;
static int in_dlsym;

static void *boot_alloc(size_t n) {
  size_t aligned = (n + 15u) & ~(size_t)15u;
  if (boot_used + aligned > sizeof boot_arena) return NULL;
  void *p = boot_arena + boot_used;
  boot_used += aligned;
  return p;
}

static int from_boot_arena(const void *p) {
  return (const char *)p >= boot_arena && (const char *)p < boot_arena + sizeof boot_arena;
}

static void resolve(void) {
  if (real_malloc != NULL || in_dlsym) return;
  in_dlsym = 1;
  real_malloc = dlsym(RTLD_NEXT, "malloc");
  real_calloc = dlsym(RTLD_NEXT, "calloc");
  real_realloc = dlsym(RTLD_NEXT, "realloc");
  real_free = dlsym(RTLD_NEXT, "free");
  real_mutex_lock = dlsym(RTLD_NEXT, "pthread_mutex_lock");
  real_mutex_trylock = dlsym(RTLD_NEXT, "pthread_mutex_trylock");
  in_dlsym = 0;
}

/* The host's control surface. Looked up with dlsym(RTLD_DEFAULT, ...). */
void omx_rt_begin(void) { armed = 1; }
void omx_rt_end(void) { armed = 0; }
void omx_rt_reset(void) {
  n_alloc = 0;
  n_lock = 0;
  n_syscall = 0;
  n_events = 0;
  void *warm[4];
  backtrace(warm, 4); /* the unwinder's lazy init lands here, never inside a window */
}
int omx_rt_events(struct omx_rt_event *out, int max) {
  int n = n_events < max ? n_events : max;
  memcpy(out, events, (size_t)n * sizeof *out);
  return n;
}
void omx_rt_counts(uint64_t *alloc, uint64_t *lock, uint64_t *sys) {
  if (alloc) *alloc = n_alloc;
  if (lock) *lock = n_lock;
  if (sys) *sys = n_syscall;
}
/* Present-and-loaded witness: without this the host cannot tell a clean plugin from
 * an interposer that never loaded, which is the difference between a measurement and
 * an absence. An unloadable interposer is `no-interposer`, never a pass. */
int omx_rt_present(void) { return 1; }

void *malloc(size_t n) {
  resolve();
  if (real_malloc == NULL) return boot_alloc(n);
  if (armed && !in_record) { n_alloc++; record(OMX_RT_MALLOC); }
  return real_malloc(n);
}

void *calloc(size_t nmemb, size_t size) {
  resolve();
  if (real_calloc == NULL) {
    void *p = boot_alloc(nmemb * size);
    if (p) memset(p, 0, nmemb * size);
    return p;
  }
  if (armed && !in_record) { n_alloc++; record(OMX_RT_CALLOC); }
  return real_calloc(nmemb, size);
}

void *realloc(void *p, size_t n) {
  resolve();
  if (real_realloc == NULL) return boot_alloc(n);
  if (armed && !in_record) { n_alloc++; record(OMX_RT_REALLOC); }
  return real_realloc(p, n);
}

void free(void *p) {
  resolve();
  /* Never hand the arena to libc free: it did not come from libc. */
  if (from_boot_arena(p)) return;
  if (armed && !in_record) { n_alloc++; record(OMX_RT_FREE); }
  if (real_free != NULL) real_free(p);
}

int pthread_mutex_lock(pthread_mutex_t *m) {
  resolve();
  if (armed && !in_record) { n_lock++; record(OMX_RT_MUTEX_LOCK); }
  return real_mutex_lock ? real_mutex_lock(m) : 0;
}

int pthread_mutex_trylock(pthread_mutex_t *m) {
  resolve();
  if (armed && !in_record) { n_lock++; record(OMX_RT_MUTEX_TRYLOCK); }
  return real_mutex_trylock ? real_mutex_trylock(m) : 0;
}

/*
 * Syscalls that block or touch the filesystem. Not exhaustive by design — these are
 * the ones a plugin plausibly reaches for inside process() (reading a table, logging,
 * sleeping) and each is unambiguously wrong there. A plugin doing something exotic
 * enough to miss this list will almost certainly also allocate or lock.
 */
#define COUNTED_SYSCALL(ret, name, kind, params, args, fallback)                       \
  ret name params {                                                                    \
    static ret (*real)params;                                                          \
    if (real == NULL) real = dlsym(RTLD_NEXT, #name);                                  \
    if (armed && !in_record) { n_syscall++; record(kind); }                            \
    return real ? real args : fallback;                                                \
  }

COUNTED_SYSCALL(int, open, OMX_RT_OPEN, (const char *p, int f, ...), (p, f), -1)
COUNTED_SYSCALL(int, nanosleep, OMX_RT_NANOSLEEP, (const struct timespec *a, struct timespec *b), (a, b), 0)
COUNTED_SYSCALL(ssize_t, write, OMX_RT_WRITE, (int fd, const void *b, size_t n), (fd, b, n), -1)
COUNTED_SYSCALL(ssize_t, read, OMX_RT_READ, (int fd, void *b, size_t n), (fd, b, n), -1)
