/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com> */
/* A pool of helper threads for a host's clap.thread-pool, so that the interposer counts what a plugin's tasks do on a
 * thread that is not the audio thread (clap-qualify --pool, the pool step of src/qualify-pool.ts). The shape is
 * omx-clap-core's (docs/thread-pool.md): a request is one 64-bit word, a generation, the task count and the next index,
 * taken with a compare-and-swap by the helpers and by the calling thread, which takes tasks too and returns when every
 * one has ended. After the helpers are made nothing here allocates, locks or makes a call the interposer counts: a
 * helper that waits spins and yields. The threads are created with the creator's attributes, so they inherit its
 * scheduling; the measuring tools create none themselves (src/native-sched-conformance.test.ts). */
#ifndef OMX_NATIVE_POOL_HOST_H
#define OMX_NATIVE_POOL_HOST_H

#include <stdint.h>

#define POOL_HELPERS_MAX 7
#define POOL_TASKS_MAX 65535u

typedef void (*pool_task_fn)(void *ctx, uint32_t task);

/* makes up to `helpers` helper threads (at most POOL_HELPERS_MAX); how many were made is pool_helper_count() */
void pool_start(uint32_t helpers);
/* ends and joins the helpers */
void pool_stop(void);
uint32_t pool_helper_count(void);
/* runs fn(ctx, 0) to fn(ctx, tasks - 1), each once, on the helpers and the calling thread; returns when every one has
 * ended. `tasks` is at least 2 and at most POOL_TASKS_MAX, and there is at least one helper */
void pool_run(pool_task_fn fn, void *ctx, uint32_t tasks);
/* the requests made, the tasks run, and of them the ones a helper ran */
void pool_stats(unsigned long long *requests, unsigned long long *tasks, unsigned long long *on_helpers);

#endif
