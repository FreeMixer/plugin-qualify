/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com> */
/* The scheduling the timing runs under, read on the thread that times: the policy and priority the two measurers print
 * beside each cost figure (#214). plugin-hostd's probe records realtime.observed from the measured child's main thread
 * after exec; this is the same reading taken where the clock is, so a record says what its figures were taken at. The
 * policy names are plugin-hostd's PHD_PROBE_SCHED_POLICIES, the words realtime.observed.policy uses. */
#ifndef OMX_NATIVE_TIMING_SCHED_H
#define OMX_NATIVE_TIMING_SCHED_H

#include <sched.h>
#include <plugin-hostd/protocol.h>

/* the kernel's values for the policies glibc names only under _GNU_SOURCE, or (DEADLINE) only since 2.41 */
#ifndef SCHED_BATCH
#define SCHED_BATCH 3
#endif
#ifndef SCHED_IDLE
#define SCHED_IDLE 5
#endif
#ifndef SCHED_DEADLINE
#define SCHED_DEADLINE 6
#endif
struct timing_sched {
  const char *policy; /* a PHD_PROBE_SCHED_POLICIES name, NULL when the kernel would not say */
  int priority;
};

static const char *timing_sched_policy_name(int policy) {
  switch (policy) {
#define TIMING_SCHED_CASE(id, name, meaning) \
  case SCHED_##id:                           \
    return name;
    PHD_PROBE_SCHED_POLICIES(TIMING_SCHED_CASE)
#undef TIMING_SCHED_CASE
  default:
    return NULL;
  }
}

/* the calling thread's policy and priority: call it on the thread that runs the clock */
static struct timing_sched timing_sched_read(void) {
  struct timing_sched s = { NULL, 0 };
  struct sched_param p;
  s.policy = timing_sched_policy_name(sched_getscheduler(0));
  if (s.policy != NULL && sched_getparam(0, &p) == 0) s.priority = p.sched_priority;
  return s;
}

#endif
