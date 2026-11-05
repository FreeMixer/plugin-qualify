// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * rt-watch — what a JACK host does on its audio thread, counted the same way for every host.
 *
 * The host comparison (`plugin-qualify compare`, tools/compare-host.mjs) runs one plugin under mod-host, jalv,
 * omx-clap-host and plugin-hostd and asks each the same question: while this plugin runs, does the audio thread
 * allocate, take a lock or make a system call? None of those hosts calls the interposer's omx_rt_begin(), so this
 * library puts the window around the one thing every JACK host has: the process callback it gives
 * jack_set_process_callback(). It interposes that function, hands JACK a trampoline that arms the counters of
 * rt-interpose.c (built here with OMX_RT_WATCH: the window is the audio thread's alone) around the host's own callback,
 * and leaves the first OMX_RT_WATCH_WARMUP cycles of each callback unarmed (64 by default), so a plugin that builds a
 * table on its first block is not read as one that allocates on every block. The plugin-qualify prober discards its
 * warm-up blocks for the same reason.
 *
 * What is counted is the host's callback with the plugin in it: the host's own work on its audio thread counts as
 * well as the plugin's. That is the comparison's question (is this plugin, under this host, real-time safe), and the
 * same window for every host keeps it fair.
 *
 *   LD_PRELOAD=rt_watch.so OMX_RT_WATCH_DIR=<dir> <host> ...       then kill -USR2 <pid>
 *
 * On SIGUSR2 (taken by a thread of its own, below) each process that loaded it writes <dir>/rt-<pid>.json:
 *   {"pid":..,"callbacks":<process callbacks wrapped>,"cycles":<calls>,"armedCycles":<calls counted>,
 *    "allocations":..,"locks":..,"trylocks":..,"syscalls":..,"kinds":["malloc",...]}
 * A try-lock is counted apart from a lock: it never waits, so it is reported and not held against the host.
 * A process that registered no callback writes "callbacks":0, which the comparison reads as "not observable" for that
 * process, never as clean. Without OMX_RT_WATCH_DIR it counts and writes nothing.
 */
#define OMX_RT_WATCH 1
#include "rt-interpose.c"

#include <signal.h>
#include <stdio.h>

typedef int (*process_cb)(uint32_t nframes, void *arg);
typedef int (*set_process_fn)(void *client, process_cb cb, void *arg);

#define WATCH_SLOTS 64
struct slot {
  process_cb cb;
  void *arg;
  uint64_t calls;
};
static struct slot slots[WATCH_SLOTS];
static int n_slots;
static uint64_t warmup = 64;
static uint64_t cycles, armed_cycles;
static char report_dir[400];

static int trampoline(uint32_t nframes, void *arg) {
  struct slot *s = arg;
  uint64_t n = s->calls++;
  __atomic_fetch_add(&cycles, 1, __ATOMIC_RELAXED);
  if (n < warmup) return s->cb(nframes, s->arg);
  __atomic_fetch_add(&armed_cycles, 1, __ATOMIC_RELAXED);
  omx_rt_begin();
  int r = s->cb(nframes, s->arg);
  omx_rt_end();
  return r;
}

int jack_set_process_callback(void *client, process_cb cb, void *arg) {
  static set_process_fn real;
  if (real == NULL) real = (set_process_fn)dlsym(RTLD_NEXT, "jack_set_process_callback");
  if (real == NULL) return -1;
  int i = __atomic_fetch_add(&n_slots, 1, __ATOMIC_RELAXED);
  if (cb == NULL || i >= WATCH_SLOTS) return real(client, cb, arg); /* past the table: left unwatched, and said so */
  slots[i].cb = cb;
  slots[i].arg = arg;
  slots[i].calls = 0;
  return real(client, trampoline, &slots[i]);
}

static const char *kind_name(int k) {
  switch (k) {
  case OMX_RT_MALLOC: return "malloc";
  case OMX_RT_CALLOC: return "calloc";
  case OMX_RT_REALLOC: return "realloc";
  case OMX_RT_FREE: return "free";
  case OMX_RT_MUTEX_LOCK: return "pthread_mutex_lock";
  case OMX_RT_MUTEX_TRYLOCK: return "pthread_mutex_trylock";
  case OMX_RT_OPEN: return "open";
  case OMX_RT_NANOSLEEP: return "nanosleep";
  case OMX_RT_WRITE: return "write";
  case OMX_RT_READ: return "read";
  default: return "other";
  }
}

/* The report, written by a thread of its own that waits for SIGUSR2 with sigwait(). The constructor blocks SIGUSR2
 * before the host starts a thread, so every thread the host makes inherits the block and the signal never interrupts
 * one: an audio thread interrupted in its wait on the JACK server can leave the server waiting on it. The writer's own
 * open and write are never counted, since it never arms. */
static void report(void) {
  char buf[1024];
  int callbacks = n_slots < WATCH_SLOTS ? n_slots : WATCH_SLOTS;
  int len = snprintf(buf, sizeof buf,
                     "{\"pid\":%d,\"callbacks\":%d,\"unwatched\":%d,\"warmup\":%llu,\"cycles\":%llu,\"armedCycles\":%llu,"
                     "\"allocations\":%llu,\"locks\":%llu,\"trylocks\":%llu,\"syscalls\":%llu,\"kinds\":[",
                     (int)getpid(), callbacks, n_slots - callbacks, (unsigned long long)warmup,
                     (unsigned long long)__atomic_load_n(&cycles, __ATOMIC_RELAXED),
                     (unsigned long long)__atomic_load_n(&armed_cycles, __ATOMIC_RELAXED),
                     (unsigned long long)__atomic_load_n(&n_alloc, __ATOMIC_RELAXED),
                     (unsigned long long)__atomic_load_n(&n_lock, __ATOMIC_RELAXED),
                     (unsigned long long)__atomic_load_n(&n_trylock, __ATOMIC_RELAXED),
                     (unsigned long long)__atomic_load_n(&n_syscall, __ATOMIC_RELAXED));
  int ne = __atomic_load_n(&n_events, __ATOMIC_RELAXED);
  if (ne > OMX_RT_EV_MAX) ne = OMX_RT_EV_MAX;
  for (int i = 0; i < ne && len < (int)sizeof buf - 40; i++)
    len += snprintf(buf + len, sizeof buf - (size_t)len, "%s\"%s\"", i ? "," : "", kind_name(events[i].kind));
  len += snprintf(buf + len, sizeof buf - (size_t)len, "]}\n");
  char path[512];
  snprintf(path, sizeof path, "%s/rt-%d.json", report_dir, (int)getpid()); /* a forked worker reports as itself */
  /* stdio, not open(2): this file defines open() as the interposer, which <fcntl.h> under _FORTIFY_SOURCE also defines */
  FILE *f = fopen(path, "w");
  if (f) {
    size_t w = fwrite(buf, 1, (size_t)len, f);
    (void)w;
    fclose(f);
  }
}

static void *reporter(void *arg) {
  sigset_t *set = arg;
  for (;;) {
    int sig;
    if (sigwait(set, &sig) == 0 && sig == SIGUSR2) report();
  }
  return NULL;
}

static sigset_t usr2;
static void start_reporter(void) {
  pthread_t t;
  /* default attributes: the reporter inherits the host's scheduling, as every thread of native/ does */
  if (pthread_create(&t, NULL, reporter, &usr2) == 0) pthread_detach(t);
}

__attribute__((constructor)) static void watch_init(void) {
  const char *dir = getenv("OMX_RT_WATCH_DIR");
  const char *w = getenv("OMX_RT_WATCH_WARMUP");
  if (w != NULL && *w) warmup = strtoull(w, NULL, 10);
  if (dir == NULL || !*dir) return;
  snprintf(report_dir, sizeof report_dir, "%s", dir);
  sigemptyset(&usr2);
  sigaddset(&usr2, SIGUSR2);
  pthread_sigmask(SIG_BLOCK, &usr2, NULL);
  start_reporter();
  pthread_atfork(NULL, NULL, start_reporter); /* a child that forks without exec has no reporter of its own otherwise */
}
