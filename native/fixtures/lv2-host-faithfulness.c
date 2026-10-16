// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/* Measuring-host fixtures. Five plugins, each faithful
 * to ONE thing a real plugin demands of its host and unable to hide when the host is not:
 *   needs-options  instantiate FAILS without the sampleRate and maxBlockLength options (JUCE)
 *   worker-engine  output is -6 dB once its work() ran and work_response() was delivered
 *   patch-gain     its only parameter is a patch:writable Float, driven by patch:Set
 *   wide-gain      one linear gain control port, 1/64 .. 64, default 1
 *   banner         prints into stdout while instantiating, like Guitarix */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <lv2/core/lv2.h>
#include <lv2/atom/atom.h>
#include <lv2/atom/util.h>
#include <lv2/buf-size/buf-size.h>
#include <lv2/options/options.h>
#include <lv2/parameters/parameters.h>
#include <lv2/patch/patch.h>
#include <lv2/urid/urid.h>
#include <lv2/worker/worker.h>

#define NS "urn:plugin-qualify:fixture:"

typedef struct {
    int kind;
    const float *in;
    float *out;
    const float *gain;               /* wide-gain: control port */
    const LV2_Atom_Sequence *ctl;    /* patch-gain: its only parameter arrives here */
    float param;
    LV2_URID patch_Set, patch_property, patch_value, atom_Float, p_gain;
    const LV2_Worker_Schedule *sched; /* worker-engine */
    int built, asked;
} F;

enum { NEEDS_OPTIONS, WORKER, PATCH, WIDE, BANNER };

static const LV2_Descriptor descs[];

static int kind_of(const LV2_Descriptor *d) { return (int)(d - descs); }

static LV2_Handle instantiate(const LV2_Descriptor *d, double rate, const char *path,
                              const LV2_Feature *const *features)
{
    (void)path;
    LV2_URID_Map *map = NULL;
    const LV2_Options_Option *opts = NULL;
    const LV2_Worker_Schedule *sched = NULL;
    for (int i = 0; features[i]; i++) {
        if (!strcmp(features[i]->URI, LV2_URID__map)) map = features[i]->data;
        else if (!strcmp(features[i]->URI, LV2_OPTIONS__options)) opts = features[i]->data;
        else if (!strcmp(features[i]->URI, LV2_WORKER__schedule)) sched = features[i]->data;
    }
    if (!map) return NULL;
    const int kind = kind_of(d);
    if (kind == NEEDS_OPTIONS) {
        /* What JUCE does: refuse unless the host says how big a block can get. */
        const LV2_URID sr = map->map(map->handle, LV2_PARAMETERS__sampleRate);
        const LV2_URID mx = map->map(map->handle, LV2_BUF_SIZE__maxBlockLength);
        int have_sr = 0, have_mx = 0;
        for (; opts && (opts->key || opts->value); opts++) {
            if (opts->key == sr && opts->value && *(const float *)opts->value > 0.0f &&
                (double)*(const float *)opts->value == rate) have_sr = 1;
            if (opts->key == mx && opts->value && *(const int32_t *)opts->value > 0) have_mx = 1;
        }
        if (!(have_sr && have_mx)) return NULL;
    }
    if (kind == WORKER && !sched) return NULL;
    if (kind == BANNER) {
        /* Guitarix: printed by the plugin, into the process's stdout, mid-line of the host's. */
        printf("using block size: 0\nconvolver disabled\n");
    }
    F *f = calloc(1, sizeof(F));
    f->kind = kind;
    f->sched = sched;
    f->param = 0.5f;
    f->patch_Set = map->map(map->handle, LV2_PATCH__Set);
    f->patch_property = map->map(map->handle, LV2_PATCH__property);
    f->patch_value = map->map(map->handle, LV2_PATCH__value);
    f->atom_Float = map->map(map->handle, LV2_ATOM__Float);
    f->p_gain = map->map(map->handle, NS "patch-gain#gain");
    return f;
}

static void connect_port(LV2_Handle h, uint32_t port, void *data)
{
    F *f = h;
    switch (f->kind) {
    case PATCH:
        if (port == 0) f->ctl = data; else if (port == 1) f->in = data; else f->out = data;
        break;
    case WIDE:
        if (port == 0) f->gain = data; else if (port == 1) f->in = data; else f->out = data;
        break;
    default:
        if (port == 0) f->in = data; else f->out = data;
    }
}

static void activate(LV2_Handle h) { (void)h; }

static void run(LV2_Handle h, uint32_t n)
{
    F *f = h;
    float g = 1.0f;
    if (f->kind == WIDE) g = *f->gain;
    if (f->kind == WORKER) {
        if (!f->asked && f->sched) {
            f->asked = 1;
            f->sched->schedule_work(f->sched->handle, 4, "buil");
        }
        g = f->built ? 0.5f : 1.0f;
    }
    if (f->kind == PATCH) {
        LV2_ATOM_SEQUENCE_FOREACH(f->ctl, ev) {
            const LV2_Atom_Object *o = (const LV2_Atom_Object *)&ev->body;
            if (ev->body.type != 0 && o->body.otype == f->patch_Set) {
                const LV2_Atom *prop = NULL, *val = NULL;
                lv2_atom_object_get(o, f->patch_property, &prop, f->patch_value, &val, 0);
                if (prop && val && ((const LV2_Atom_URID *)prop)->body == f->p_gain &&
                    val->type == f->atom_Float)
                    f->param = ((const LV2_Atom_Float *)val)->body;
            }
        }
        g = f->param;
    }
    for (uint32_t i = 0; i < n; i++) f->out[i] = f->in[i] * g;
}

static void deactivate(LV2_Handle h) { (void)h; }
static void cleanup(LV2_Handle h) { free(h); }

static LV2_Worker_Status work(LV2_Handle h, LV2_Worker_Respond_Function respond,
                              LV2_Worker_Respond_Handle rh, uint32_t size, const void *data)
{
    (void)h; (void)size; (void)data;
    return respond(rh, 4, "done");
}

static LV2_Worker_Status work_response(LV2_Handle h, uint32_t size, const void *data)
{
    (void)size; (void)data;
    ((F *)h)->built = 1;
    return LV2_WORKER_SUCCESS;
}

static const LV2_Worker_Interface worker_iface = {work, work_response, NULL};

static const void *extension_data(const char *uri)
{
    return !strcmp(uri, LV2_WORKER__interface) ? &worker_iface : NULL;
}

#define D(u) {NS u, instantiate, connect_port, activate, run, deactivate, cleanup, extension_data}
static const LV2_Descriptor descs[] = {D("needs-options"), D("worker-engine"), D("patch-gain"),
                                       D("wide-gain"), D("banner")};

LV2_SYMBOL_EXPORT const LV2_Descriptor *lv2_descriptor(uint32_t i)
{
    return i < sizeof descs / sizeof descs[0] ? &descs[i] : NULL;
}
