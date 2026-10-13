// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * lv2-measure-features.h — THE LV2 host features of the verdict's measurement (tools/lv2-measure.c;
 * docs/design/specs/2026-09-29-host-backend-one-contract.md §3, "Where the providers live"). The
 * engine hosts LV2 only through libomx-clap-lv2, whose providers serve the same kinds of the
 * verdict's OMX_INPROCESS_FEATURES; this unit is the measurement's own host, built on the same
 * kinds.
 *
 * WHICH features a host serves is the host's list; this unit only says how each is BUILT, and
 * builds an array of exactly the kinds a mask names.
 *
 * The URI table is ONE per process (a URID is a process fact atoms carry between instances),
 * mutex-guarded for the control and worker threads. ONE capacity policy: it grows until an
 * allocation fails, then `map` answers 0 (the LV2 "no URID"). It COPIES every string it keeps —
 * a caller's pointer is never stored. Strings live until omx_lv2_urid_forget.
 *
 * It is also the ONE door that opens an LV2 binary by path (omx_lv2_open): a CLAP binary opens
 * through libomx-clap-core (omx_clap_host_binary_open, omx_clap_host_open), never here.
 */
#ifndef LV2_MEASURE_FEATURES_H
#define LV2_MEASURE_FEATURES_H

#include <stdint.h>

#include <lv2/core/lv2.h>
#include <lv2/log/log.h>
#include <lv2/options/options.h>
#include <lv2/urid/urid.h>
#include <lv2/worker/worker.h>

/* The provider order: an array is built in this order, whatever order a list names them in. */
enum omx_lv2_feature_kind {
  OMX_LV2_F_MAP,
  OMX_LV2_F_UNMAP,
  OMX_LV2_F_OPTIONS,
  OMX_LV2_F_BOUNDED,
  OMX_LV2_F_WORKER,
  OMX_LV2_F_DEFAULT_STATE,
  OMX_LV2_F_LOG,
  OMX_LV2_FEATURE_KINDS
};
#define OMX_LV2_FEATURE_BIT(k) (1u << (k))

/* What a lilv-based tool host serves (lv2-measure.c): every kind but
 * loadDefaultState, which in-process is the registration's hook and under lilv is lilv-state's. */
#define OMX_LV2_LILV_HOST_FEATURES                                                           \
  (OMX_LV2_FEATURE_BIT(OMX_LV2_F_MAP) | OMX_LV2_FEATURE_BIT(OMX_LV2_F_UNMAP) |              \
   OMX_LV2_FEATURE_BIT(OMX_LV2_F_OPTIONS) | OMX_LV2_FEATURE_BIT(OMX_LV2_F_BOUNDED) |        \
   OMX_LV2_FEATURE_BIT(OMX_LV2_F_WORKER) | OMX_LV2_FEATURE_BIT(OMX_LV2_F_LOG))

/* The URI of each kind's feature. */
extern const char *const OMX_LV2_FEATURE_URIS[OMX_LV2_FEATURE_KINDS];

/* The kind serving `uri`, or -1 when this unit has no provider for it. */
int omx_lv2_feature_kind(const char *uri);

/* The mask of a NULL-terminated URI list (NULL: the empty list). -1 when the list names a feature
 * with no provider — never deliver less than the list. */
int omx_lv2_feature_mask(const char *const *uris, uint32_t *mask);

/* ---- urid:map / urid:unmap: the one URI table ---- */
LV2_URID omx_lv2_urid_map(const char *uri); /* 0 for NULL or when the table cannot grow */
const char *omx_lv2_urid_unmap(LV2_URID id); /* NULL for 0 or an id never handed out */
void omx_lv2_urid_forget(void);              /* frees every kept string; ids restart at 1 */

/* ---- options:options: param:sampleRate (Float), bufsz:minBlockLength 1, bufsz:maxBlockLength and
 * bufsz:nominalBlockLength (Int, the block). The options point INTO the struct: build it where it
 * stays. ---- */
struct omx_lv2_options {
  float rate;
  int32_t min_block, max_block;
  LV2_Options_Option opts[5];
};
void omx_lv2_options_build(struct omx_lv2_options *o, double rate, uint32_t max_block);

/* ---- the feature array ---- */
struct omx_lv2_feature_block {
  LV2_Feature features[OMX_LV2_FEATURE_KINDS];
  const LV2_Feature *ptrs[OMX_LV2_FEATURE_KINDS + 1];
};

/* Fill `b` with exactly the kinds `mask` names, in provider order, NULL-terminated, and return the
 * array `instantiate` takes. `options` serves OMX_LV2_F_OPTIONS, `schedule` OMX_LV2_F_WORKER (the
 * instance's own); boundedBlockLength and loadDefaultState are flags, their presence the promise.
 * NULL — nothing built — when the mask names a kind whose data the caller did not hand over, or a
 * bit outside the kinds: refused, never a shorter array. */
const LV2_Feature *const *omx_lv2_features_build(struct omx_lv2_feature_block *b, uint32_t mask,
                                                 struct omx_lv2_options *options,
                                                 LV2_Worker_Schedule *schedule);

/* ---- the door: open the LV2 `.so` at `path` and walk `lv2_descriptor` to `uri`. Control thread.
 * The descriptor, `*so` holding the handle to dlclose after the last instance; NULL refused (`*so`
 * NULL, nothing loaded) with `*why` the step: "dlopen", "lv2_descriptor" or "uri" (a static
 * string). ---- */
const LV2_Descriptor *omx_lv2_open(void **so, const char *path, const char *uri, const char **why);

#endif
