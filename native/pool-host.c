// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/* The pool of helper threads of pool-host.h. */
#define _GNU_SOURCE
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>

#include "pool-host.h"

static struct {
  pthread_t thread[POOL_HELPERS_MAX];
  uint32_t helpers;
  atomic_int stop;
  _Atomic uint64_t word; /* generation (32 bits) | task count (16) | next index (16) */
  pool_task_fn fn;       /* the request's, set before the word is published */
  void *ctx;
  atomic_uint done;
  uint32_t generation;
  atomic_ullong requests, tasks_on_helpers, tasks_total;
} g_pool;

#define POOL_WORD(gen, count, next) (((uint64_t)(gen) << 32) | ((uint64_t)(count) << 16) | (uint64_t)(next))

/* takes tasks of the request the word names until none is left */
static void pool_take(uint32_t gen, int helper) {
  for (;;) {
    uint64_t w = atomic_load_explicit(&g_pool.word, memory_order_acquire);
    const uint32_t count = (uint32_t)((w >> 16) & 0xffff), next = (uint32_t)(w & 0xffff);
    if ((uint32_t)(w >> 32) != gen || next >= count) return;
    if (!atomic_compare_exchange_weak_explicit(&g_pool.word, &w, w + 1, memory_order_acq_rel, memory_order_acquire)) continue;
    g_pool.fn(g_pool.ctx, next);
    atomic_fetch_add_explicit(&g_pool.done, 1, memory_order_release);
    atomic_fetch_add_explicit(&g_pool.tasks_total, 1, memory_order_relaxed);
    if (helper) atomic_fetch_add_explicit(&g_pool.tasks_on_helpers, 1, memory_order_relaxed);
  }
}

static void *pool_helper(void *arg) {
  (void)arg;
  uint32_t seen = 0;
  while (!atomic_load_explicit(&g_pool.stop, memory_order_acquire)) {
    const uint32_t gen = (uint32_t)(atomic_load_explicit(&g_pool.word, memory_order_acquire) >> 32);
    if (gen == seen) {
      sched_yield();
      continue;
    }
    seen = gen;
    pool_take(gen, 1);
  }
  return NULL;
}

void pool_start(uint32_t helpers) {
  if (helpers > POOL_HELPERS_MAX) helpers = POOL_HELPERS_MAX;
  for (uint32_t i = 0; i < helpers; i++)
    if (pthread_create(&g_pool.thread[g_pool.helpers], NULL, pool_helper, NULL) == 0) g_pool.helpers++;
}

void pool_stop(void) {
  atomic_store_explicit(&g_pool.stop, 1, memory_order_release);
  for (uint32_t i = 0; i < g_pool.helpers; i++) pthread_join(g_pool.thread[i], NULL);
  g_pool.helpers = 0;
}

uint32_t pool_helper_count(void) { return g_pool.helpers; }

void pool_run(pool_task_fn fn, void *ctx, uint32_t tasks) {
  g_pool.fn = fn;
  g_pool.ctx = ctx;
  atomic_store_explicit(&g_pool.done, 0, memory_order_relaxed);
  const uint32_t gen = ++g_pool.generation;
  atomic_fetch_add_explicit(&g_pool.requests, 1, memory_order_relaxed);
  atomic_store_explicit(&g_pool.word, POOL_WORD(gen, tasks, 0), memory_order_release);
  pool_take(gen, 0);
  /* a task a helper has begun is waited for, as the extension requires */
  while (atomic_load_explicit(&g_pool.done, memory_order_acquire) < tasks) sched_yield();
}

void pool_stats(unsigned long long *requests, unsigned long long *tasks, unsigned long long *on_helpers) {
  *requests = atomic_load(&g_pool.requests);
  *tasks = atomic_load(&g_pool.tasks_total);
  *on_helpers = atomic_load(&g_pool.tasks_on_helpers);
}
