// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * lv2-measure-path.h — the LV2 search path the measurer's lilv world is loaded from.
 *
 * lilv takes each `LV2_PATH` segment as a file URI source and refuses a relative one ("attempt to map
 * invalid URI"), leaving the world it then dereferences half built: a SIGSEGV. A relative segment is
 * resolved against the working directory before the world is loaded; the segments lilv itself expands
 * (a leading `~` or `$`) and the absolute ones are left as they are.
 */
#ifndef LV2_MEASURE_PATH_H
#define LV2_MEASURE_PATH_H

/** `list`, a colon-separated LV2 path, with each relative segment made absolute under `cwd`: a malloc'd
 * string for the caller to free, or NULL when memory is out. */
char *lv2_path_absolute(const char *list, const char *cwd);

/** Rewrite `LV2_PATH` in the environment by `lv2_path_absolute` against the working directory. 0 when it
 * is unset or rewritten; -1 (with `errno` set) when the working directory cannot be read or memory is out. */
int lv2_path_resolve_env(void);

#endif
