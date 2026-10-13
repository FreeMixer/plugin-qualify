// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/* The event record rt-interpose.so keeps for the host: what a plugin did inside run(), and
 * from where. A count says that something happened; this says what, which is what a ruling
 * on a count of 1 needs. Shared by the interposer and lv2-measure, identical on both sides. */
#pragma once
#define OMX_RT_EV_MAX 16
#define OMX_RT_EV_DEPTH 12
enum omx_rt_kind {
  OMX_RT_MALLOC = 1, OMX_RT_CALLOC, OMX_RT_REALLOC, OMX_RT_FREE,
  OMX_RT_MUTEX_LOCK, OMX_RT_MUTEX_TRYLOCK,
  OMX_RT_OPEN, OMX_RT_NANOSLEEP, OMX_RT_WRITE, OMX_RT_READ,
};
struct omx_rt_event { int kind; int depth; void *frames[OMX_RT_EV_DEPTH]; };
