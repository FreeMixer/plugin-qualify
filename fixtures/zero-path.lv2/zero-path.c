// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/* Evaluation fixture: an audio
 * pass-through that emits, on its notify port, a patch:Set whose value is an atom:Path of body
 * size ZERO — what NAM does with no model loaded (mod-host PR #98, 7e1f143). Emitted on the first
 * cycle after activate and then every 32 cycles, so a racked instance keeps feeding mod-host's
 * feedback relay (RunPostPonedEvents, POSTPONED_PROCESS_OUTPUT_BUFFER).
 *
 * The #98 bug is NAM's own: it keeps a copy of the model path it last told the host about, sized
 * to that path, and rereads that copy's first byte every block to decide whether a model is
 * loaded, never checking the copy is non-empty first. `path_copy` reproduces exactly that — one
 * byte read past a zero-length allocation, every block, with no model ever loaded. Fixing it
 * (bounds-check `path_len` before the read) is the sabotage arm: the overread, and the crash a
 * sanitizer build catches it with, both disappear. */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <lv2/core/lv2.h>
#include <lv2/atom/atom.h>
#include <lv2/atom/forge.h>
#include <lv2/atom/util.h>
#include <lv2/patch/patch.h>
#include <lv2/urid/urid.h>

#define ZP_URI "urn:openmixer:eval:zero-path"
enum { P_CONTROL = 0, P_NOTIFY = 1, P_IN = 2, P_OUT = 3 };

typedef struct {
    const LV2_Atom_Sequence *control;
    LV2_Atom_Sequence *notify;
    const float *in;
    float *out;
    LV2_Atom_Forge forge;
    LV2_URID patch_Set, patch_property, patch_value, atom_Path, model;
    unsigned cycle;
    uint8_t *path_copy; /* NAM's own cache of the model path; never loaded, so always zero-length */
    uint32_t path_len;
} Z;

static LV2_Handle instantiate(const LV2_Descriptor *d, double rate, const char *path,
                              const LV2_Feature *const *features)
{
    LV2_URID_Map *map = NULL;
    for (int i = 0; features[i]; i++)
        if (!strcmp(features[i]->URI, LV2_URID__map)) map = features[i]->data;
    if (!map) return NULL;
    Z *z = calloc(1, sizeof(Z));
    lv2_atom_forge_init(&z->forge, map);
    z->patch_Set = map->map(map->handle, LV2_PATCH__Set);
    z->patch_property = map->map(map->handle, LV2_PATCH__property);
    z->patch_value = map->map(map->handle, LV2_PATCH__value);
    z->atom_Path = map->map(map->handle, LV2_ATOM__Path);
    z->model = map->map(map->handle, ZP_URI "#model");
    z->path_len = 0; /* no model loaded */
    z->path_copy = malloc(z->path_len);
    (void)d; (void)rate; (void)path;
    return z;
}

static void connect_port(LV2_Handle h, uint32_t port, void *data)
{
    Z *z = h;
    switch (port) {
    case P_CONTROL: z->control = data; break;
    case P_NOTIFY: z->notify = data; break;
    case P_IN: z->in = data; break;
    case P_OUT: z->out = data; break;
    }
}

static void activate(LV2_Handle h) { ((Z *)h)->cycle = 0; }

static void run(LV2_Handle h, uint32_t n)
{
    Z *z = h;
    if (z->in && z->out) memmove(z->out, z->in, n * sizeof(float));
    /* the #98 overread: read the cached model path's first byte with no length check. */
    volatile uint8_t probe = z->path_copy[0];
    (void)probe;
    if (!z->notify) return;
    const uint32_t cap = z->notify->atom.size;
    lv2_atom_forge_set_buffer(&z->forge, (uint8_t *)z->notify, cap);
    LV2_Atom_Forge_Frame seq, obj;
    lv2_atom_forge_sequence_head(&z->forge, &seq, 0);
    if (z->cycle++ % 32 == 0) {
        lv2_atom_forge_frame_time(&z->forge, 0);
        lv2_atom_forge_object(&z->forge, &obj, 0, z->patch_Set);
        lv2_atom_forge_key(&z->forge, z->patch_property);
        lv2_atom_forge_urid(&z->forge, z->model);
        lv2_atom_forge_key(&z->forge, z->patch_value);
        lv2_atom_forge_atom(&z->forge, 0, z->atom_Path);   /* the zero-size body */
        lv2_atom_forge_pop(&z->forge, &obj);
    }
    lv2_atom_forge_pop(&z->forge, &seq);
}

static void cleanup(LV2_Handle h) { free(((Z *)h)->path_copy); free(h); }

static const LV2_Descriptor desc = { ZP_URI, instantiate, connect_port, activate, run, NULL, cleanup, NULL };
LV2_SYMBOL_EXPORT const LV2_Descriptor *lv2_descriptor(uint32_t i) { return i == 0 ? &desc : NULL; }
