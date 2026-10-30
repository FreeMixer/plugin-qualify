// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * lv2-measure — the facts `classifyPluginHosting` refuses to work without.
 *
 * The classifier fails closed: with no measurement every plugin reads `unknown` and
 * stays on the isolated host. That is the correct default and a useless one — it is
 * this program's whole job to replace it with numbers. It reports, per plugin:
 *
 *   features   required/optional LV2 features and CV ports, read from the bundle
 *   latency    at the run's rate, what the plugin reports and what an impulse (or, for an instrument, a note) measures
 *   cost       at the run's rate, nanoseconds per sample with every control swept and noise in
 *   rtSafety   allocations, locks and syscalls counted INSIDE run(), under a sweep; for a plugin
 *              with a MIDI input, the same counted apart while it is played (the note sweep)
 *   stability  instantiate/destroy lifecycles, and threads the plugin leaves behind
 *
 * WHY A REAL HOST. `lv2-host-probe.c` beside this one exists because a plugin's
 * host-facing half — the manifest lilv parses, the ports it binds, instantiate's
 * allocation — can be wrong with the DSP perfectly green. The same argument applies
 * to measurement: reading a plugin's source for mallocs would miss what its
 * dependencies do, and asking the plugin is not measuring it. So this loads the
 * plugin the way mod-host does, through lilv, and watches what it actually does.
 *
 * THE SWEEP IS PART OF THE METHOD, NOT A REFINEMENT. A compressor that allocates
 * when its ratio crosses a threshold is RT-safe at rest and dangerous in use. Every
 * control port is swept across its declared range during the measured window, so the
 * figure describes the plugin as an operator will drive it. rtSafety measured
 * without the sweep is reported as unswept and the classifier treats it as
 * unmeasured.
 *
 * AN INSTRUMENT IS PLAYED. A synth is quiet and clean until a voice plays, so a plugin whose atom
 * input takes midi:MidiEvent is also run through the note sweep, counted apart from the control
 * sweep: the CLAP prober's pattern (native/clap-qualify.c, note_block, in MIDI's dialect) of a
 * chord, the pitch bent and a controller moved across a block, pressure, the chord let go, a burst
 * of 32 note ons in one block and their offs, a note and all notes off, written into the MIDI
 * sequence each block. The record's rtSafety block carries it as `noteSweep`.
 *
 * THE HOST IS THE HOST THAT WILL RUN THE PLUGIN (plugin-qualify spec §2a): the options table
 * (sample rate, block lengths), a REAL worker (work() between blocks, answers
 * through work_response(), end_run()), patch:Set for patch:writable parameters (JUCE 8's only
 * parameters), a soak sweep bounded to sane ranges, and the record written to a private dup of
 * stdout so a plugin's own banner cannot tear it. The "host" object in the record says what the
 * host did, so a test can prove each injection landed.
 *
 * SOAK MODE IS A DIFFERENT PASS. Set `OMX_SOAK_SECONDS` and the program takes neither of the
 * passes above: one instance, run continuously for that many seconds, its controls swept
 * slowly across the same bounded ranges while every one-second window is checked for a
 * finite output, a level that has not decayed from where it started, and process RSS that
 * has not grown. The record carries a `soak` object in place of `rtSafety`/`stability`.
 *
 * WHAT IT LEAVES TO A SCHEDULE. The stability dimension's real question is a continuous run
 * across the whole catalog, at every rate, for as long as the operator's longest show — hours,
 * repeated on a schedule, never once here. Sizing and running that schedule, and folding its
 * output into one line per plugin, is outside this program (`sweep-jsonl.ts` reads the result).
 * A plugin this program measured without `OMX_SOAK_SECONDS` still reads `unknown` for stability
 * until a scheduled soak has measured it.
 *
 *   make -C native              (builds native/build/lv2_measure; the Makefile carries the line)
 *   LD_PRELOAD=$PWD/native/build/rt_interpose.so native/build/lv2_measure [flags] <uri> [rate] [block] [cycles] [repeats]
 *   native/build/lv2_measure --pin <uri>     the pin alone, nothing instantiated
 *   native/build/lv2_measure --help          the flags: the feature options (lv2-measure-options.h)
 *
 * The measurement line also carries the plugin's pin, `integrity` (lv2-measure-pin.h): the
 * SHA-256 of every file the host loads and the parameter-layout fingerprint, through
 * plugin-hostd's pin.h.
 *
 * Emits one JSON object on stdout. Exit 0 measured, 2 could not instantiate, 3 no
 * such plugin — a host that cannot find a plugin and a host that found a broken one
 * are different failures and must not share an exit code.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <dirent.h>
#include <errno.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include <lilv/lilv.h>
#include "rt-interpose.h"
#include "lv2-measure-options.h"
#include "lv2-measure-path.h"
#include "lv2-measure-pin.h"
#include <omxcontract/omx_contract_limits.h>
#include <omxdsp/omx_units.h> /* omx_lin_to_db_d */
#include <lv2/atom/atom.h>

/*
 * THE HOST FEATURES WE PROVIDE ARE THE MEASUREMENT'S DEFINITION.
 *
 * A plugin measured under a host that offers more than ours does would earn a
 * verdict our RT thread cannot honour; measured under one that offers less, a
 * perfectly good plugin fails to instantiate and reads as broken. So the providers
 * are the ones the engine hosts LV2 through: omx-clap-core's feature provider
 * (<omx-clap-lv2/omx_lv2_features.h>, host-backend-one-contract §3) — one URI table, the
 * options at the measured rate and block, a silent log — under the feature options of
 * lv2-measure-options.h, which a run's flags change and its record names. The worker's
 * schedule is each instance's own (below). Instantiating with NULL
 * features, which is what this program did first, made every LSP plugin segfault:
 * they require urid:map, and a host that does not map URIs is not a host.
 */
/*
 * THE MEASURING HOST IS THE HOST THAT WILL RUN THE PLUGIN
 * A figure is only as true as the host is faithful, so
 * this offers a plugin what a real host does:
 *
 *   options   the provider's table at the rate and block of each instance. An EMPTY
 *             table makes every JUCE-built LV2 refuse to instantiate.
 *   worker    worker:schedule QUEUES a job; the host runs the plugin's work() between blocks,
 *             off run(), delivers the answer through work_response() before the next block and
 *             calls end_run(). A schedule that accepts and drops measures an UNBUILT plugin
 *             (Hex Chain amp: 0.9 us/sample stubbed, 5.4 built).
 *   patch     patch:writable parameters are sent as patch:Set on the plugin's atom input and
 *             swept like control ports (JUCE 8 exposes parameters only this way).
 *
 * Everything below is allocated when an instance is opened; nothing allocates in the blocks
 * the interposer counts.
 */
#include <lv2/atom/forge.h>
#include <lv2/midi/midi.h>
#include <lv2/parameters/parameters.h>
#include <lv2/patch/patch.h>
#include <lv2/units/units.h>
#include <math.h>

/* The soak's control sweep is bounded to musically sane ranges. These defaults EQUAL
 * SOAK_SWEEP_DB / SOAK_SWEEP_RATIO in src/qualify-declarations.ts (a conformance test reads
 * both); the qualify tool passes the declared values in the environment (OMX_SWEEP_DB /
 * OMX_SWEEP_RATIO) so a moved declaration moves this. */
#define SWEEP_DB_DEFAULT 12
#define SWEEP_RATIO_DEFAULT 4

#define MAX_PARAMS 1024
#define ATOM_CAP 8192
#define PATCH_CAP 65536
#define PATCH_SETS_PER_BLOCK 256
#define MAX_JOBS 64
#define MAX_JOB_BYTES 8192

enum { PK_NONE, PK_AUDIO, PK_CONTROL_IN, PK_CONTROL_OUT, PK_ATOM_IN, PK_ATOM_OUT };

struct param {
  LV2_URID key, type;
  double lo, hi, def;
};

struct host {
  LilvWorld *world;
  const LilvPlugin *plugin;
  uint32_t n_ports, n_audio_in, n_audio_out, n_cv, n_control_in;
  uint8_t *pk;   /* PK_* per port */
  uint8_t *is_db; /* units:db per port */
  uint8_t *is_in; /* input port, per port */
  float *mins, *maxes, *defs;
  struct param params[MAX_PARAMS];
  int n_params;
  int patch_port; /* the atom input that takes patch:Set, or -1 */
  int midi_port;  /* the atom input that takes midi:MidiEvent, or -1 */
  int latency_port; /* the control output that reports the plugin's latency (lv2:designation lv2:latency, or the older lv2:reportsLatency), or -1 */
  LV2_URID_Map map; /* the provider's one URI table, for the forge */
  LV2_URID u_float, u_int, u_bool, u_long, u_double;
  LV2_URID u_chunk, u_sequence, u_patch_set, u_patch_prop, u_patch_val, u_midi;
  double sweep_db, sweep_ratio;
  LV2_Atom_Forge forge;
  /* What the host did, reported so a measurement can prove the injection landed. */
  long worker_jobs, worker_responses, worker_dropped, patch_sets, note_events;
  int worker_interface;
  /* The feature options every instance is built under, the plugin's lv2:requiredFeature list
   * (NULL-terminated), and the first of them a strict host refused it for. */
  const struct lv2_measure_options *opts;
  const char **required;
  const char *refused;
};

struct job {
  uint32_t size;
  uint8_t data[MAX_JOB_BYTES];
};

struct rig {
  struct host *h;
  LilvInstance *inst;
  uint32_t block;
  size_t audio_slots;
  float *audio, *controls;
  uint8_t **atoms;
  LV2_Worker_Schedule sched;
  struct omx_lv2_feature_block feature_block;
  const LV2_Worker_Interface *wk;
  LV2_Handle handle;
  struct job jobs[MAX_JOBS], resp[MAX_JOBS];
  int jh, jt, rh, rt;
  double pvals[MAX_PARAMS];
  int patch_live, pcursor;
  /* the note sweep's block this block plays, or -1 for none */
  int note_block;
  /* the latency and cost passes' own note: 0 none, 1 one key struck, 2 that key let go, 3 `held` keys struck */
  int probe_note;
  uint32_t held;
};

static LV2_Worker_Status schedule_work(LV2_Worker_Schedule_Handle handle, uint32_t size, const void *data) {
  struct rig *r = handle;
  int next = (r->jt + 1) % MAX_JOBS;
  if (next == r->jh || size > MAX_JOB_BYTES) return LV2_WORKER_ERR_NO_SPACE;
  r->jobs[r->jt].size = size;
  memcpy(r->jobs[r->jt].data, data, size);
  r->jt = next;
  return LV2_WORKER_SUCCESS;
}

static LV2_Worker_Status worker_respond(LV2_Worker_Respond_Handle handle, uint32_t size, const void *data) {
  struct rig *r = handle;
  int next = (r->rt + 1) % MAX_JOBS;
  if (next == r->rh || size > MAX_JOB_BYTES) return LV2_WORKER_ERR_NO_SPACE;
  r->resp[r->rt].size = size;
  memcpy(r->resp[r->rt].data, data, size);
  r->rt = next;
  return LV2_WORKER_SUCCESS;
}

static double env_or(const char *name, double fallback) {
  const char *v = getenv(name);
  const double x = v ? atof(v) : 0.0;
  return x > 0.0 ? x : fallback;
}

static LV2_URID host_map(LV2_URID_Map_Handle handle, const char *uri) {
  (void)handle;
  return omx_lv2_urid_map(uri);
}

static LV2_URID map_node(struct host *h, const LilvNode *n) {
  return n && lilv_node_is_uri(n) ? h->map.map(NULL, lilv_node_as_uri(n)) : 0;
}

/* Everything about the plugin that does not depend on an instance: port kinds, ranges, units
 * and the patch:writable parameters. */
static int host_open(struct host *h, LilvWorld *world, const LilvPlugin *plugin) {
  memset(h, 0, sizeof *h);
  h->world = world;
  h->plugin = plugin;
  h->map = (LV2_URID_Map){NULL, host_map};
  h->u_float = omx_lv2_urid_map(LV2_ATOM__Float);
  h->u_int = omx_lv2_urid_map(LV2_ATOM__Int);
  h->u_bool = omx_lv2_urid_map(LV2_ATOM__Bool);
  h->u_long = omx_lv2_urid_map(LV2_ATOM__Long);
  h->u_double = omx_lv2_urid_map(LV2_ATOM__Double);
  h->u_chunk = omx_lv2_urid_map(LV2_ATOM__Chunk);
  h->u_sequence = omx_lv2_urid_map(LV2_ATOM__Sequence);
  h->u_patch_set = omx_lv2_urid_map(LV2_PATCH__Set);
  h->u_patch_prop = omx_lv2_urid_map(LV2_PATCH__property);
  h->u_patch_val = omx_lv2_urid_map(LV2_PATCH__value);
  h->u_midi = omx_lv2_urid_map(LV2_MIDI__MidiEvent);
  h->sweep_db = env_or("OMX_SWEEP_DB", SWEEP_DB_DEFAULT);
  h->sweep_ratio = env_or("OMX_SWEEP_RATIO", SWEEP_RATIO_DEFAULT);
  h->patch_port = -1;
  h->midi_port = -1;
  h->latency_port = lilv_plugin_has_latency(plugin) ? (int)lilv_plugin_get_latency_port_index(plugin) : -1;
  lv2_atom_forge_init(&h->forge, &h->map);

  LilvNode *audio_class = lilv_new_uri(world, LV2_CORE__AudioPort);
  LilvNode *control_class = lilv_new_uri(world, LV2_CORE__ControlPort);
  LilvNode *input_class = lilv_new_uri(world, LV2_CORE__InputPort);
  LilvNode *output_class = lilv_new_uri(world, LV2_CORE__OutputPort);
  LilvNode *cv_class = lilv_new_uri(world, LV2_CORE__CVPort);
  LilvNode *atom_class = lilv_new_uri(world, LV2_ATOM__AtomPort);
  LilvNode *unit_pred = lilv_new_uri(world, LV2_UNITS__unit);
  LilvNode *db_unit = lilv_new_uri(world, LV2_UNITS__db);
  LilvNode *patch_msg = lilv_new_uri(world, LV2_PATCH__Message);
  LilvNode *midi_event = lilv_new_uri(world, LV2_MIDI__MidiEvent);

  h->n_ports = lilv_plugin_get_num_ports(plugin);
  h->pk = calloc(h->n_ports, 1);
  h->is_db = calloc(h->n_ports, 1);
  h->is_in = calloc(h->n_ports, 1);
  h->mins = calloc(h->n_ports, sizeof(float));
  h->maxes = calloc(h->n_ports, sizeof(float));
  h->defs = calloc(h->n_ports, sizeof(float));
  lilv_plugin_get_port_ranges_float(plugin, h->mins, h->maxes, h->defs);
  for (uint32_t i = 0; i < h->n_ports; i++) {
    const LilvPort *port = lilv_plugin_get_port_by_index(plugin, i);
    const int in = lilv_port_is_a(plugin, port, input_class);
    const int out = lilv_port_is_a(plugin, port, output_class);
    h->is_in[i] = (uint8_t)in;
    if (lilv_port_is_a(plugin, port, cv_class)) {
      h->n_cv++;
      h->pk[i] = PK_AUDIO;
    } else if (lilv_port_is_a(plugin, port, audio_class)) {
      if (in) h->n_audio_in++;
      else if (out) h->n_audio_out++;
      h->pk[i] = PK_AUDIO;
    } else if (lilv_port_is_a(plugin, port, control_class)) {
      h->pk[i] = in ? PK_CONTROL_IN : PK_CONTROL_OUT;
      if (in) h->n_control_in++;
      LilvNodes *u = lilv_port_get_value(plugin, port, unit_pred);
      if (u) {
        LILV_FOREACH (nodes, ui, u)
          if (lilv_node_equals(lilv_nodes_get(u, ui), db_unit)) h->is_db[i] = 1;
        lilv_nodes_free(u);
      }
    } else {
      h->pk[i] = in ? PK_ATOM_IN : PK_ATOM_OUT;
      if (in && h->patch_port < 0 && lilv_port_is_a(plugin, port, atom_class) &&
          lilv_port_supports_event(plugin, port, patch_msg))
        h->patch_port = (int)i;
      if (in && h->midi_port < 0 && lilv_port_is_a(plugin, port, atom_class) &&
          lilv_port_supports_event(plugin, port, midi_event))
        h->midi_port = (int)i;
    }
  }

  /* patch:writable parameters: JUCE 8 declares them ONLY here. */
  LilvNode *writable = lilv_new_uri(world, LV2_PATCH__writable);
  LilvNode *range_p = lilv_new_uri(world, "http://www.w3.org/2000/01/rdf-schema#range");
  LilvNode *min_p = lilv_new_uri(world, LV2_CORE__minimum);
  LilvNode *max_p = lilv_new_uri(world, LV2_CORE__maximum);
  LilvNode *def_p = lilv_new_uri(world, LV2_CORE__default);
  LilvNodes *ws = lilv_plugin_get_value(plugin, writable);
  if (ws) {
    LILV_FOREACH (nodes, wi, ws) {
      const LilvNode *prop = lilv_nodes_get(ws, wi);
      if (!lilv_node_is_uri(prop) || h->n_params >= MAX_PARAMS) continue;
      LilvNode *range = lilv_world_get(world, prop, range_p, NULL);
      const LV2_URID type = map_node(h, range);
      lilv_node_free(range);
      if (type != h->u_float && type != h->u_int && type != h->u_bool && type != h->u_long &&
          type != h->u_double)
        continue; /* strings and paths cannot be swept */
      LilvNode *mn = lilv_world_get(world, prop, min_p, NULL);
      LilvNode *mx = lilv_world_get(world, prop, max_p, NULL);
      LilvNode *df = lilv_world_get(world, prop, def_p, NULL);
      struct param *p = &h->params[h->n_params];
      p->key = map_node(h, prop);
      p->type = type;
      p->lo = type == h->u_bool ? 0.0 : (mn ? (double)lilv_node_as_float(mn) : 0.0);
      p->hi = type == h->u_bool ? 1.0 : (mx ? (double)lilv_node_as_float(mx) : 0.0);
      p->def = df ? (double)lilv_node_as_float(df) : p->lo;
      if (type == h->u_bool || (mn && mx)) h->n_params++;
      lilv_node_free(mn);
      lilv_node_free(mx);
      lilv_node_free(df);
    }
    lilv_nodes_free(ws);
  }
  lilv_node_free(writable);
  lilv_node_free(range_p);
  lilv_node_free(min_p);
  lilv_node_free(max_p);
  lilv_node_free(def_p);
  lilv_node_free(patch_msg);
  lilv_node_free(midi_event);
  lilv_node_free(db_unit);
  lilv_node_free(unit_pred);
  lilv_node_free(atom_class);
  lilv_node_free(cv_class);
  lilv_node_free(output_class);
  lilv_node_free(input_class);
  lilv_node_free(control_class);
  lilv_node_free(audio_class);
  return 0;
}

static void host_close(struct host *h) {
  free(h->pk);
  free(h->is_db);
  free(h->is_in);
  free(h->mins);
  free(h->maxes);
  free(h->defs);
}

static uint32_t atom_cap(const struct host *h, uint32_t port) {
  return (int)port == h->patch_port ? PATCH_CAP : ATOM_CAP;
}

static void atom_reset(const struct host *h, uint8_t *buf, uint32_t port) {
  LV2_Atom_Sequence *s = (LV2_Atom_Sequence *)buf;
  if (h->pk[port] == PK_ATOM_IN) {
    s->atom.size = (uint32_t)sizeof(LV2_Atom_Sequence_Body);
    s->atom.type = h->u_sequence;
    s->body.unit = 0;
    s->body.pad = 0;
  } else {
    /* An output sequence advertises its capacity as a chunk, afresh every block. */
    s->atom.size = atom_cap(h, port) - (uint32_t)sizeof(LV2_Atom);
    s->atom.type = h->u_chunk;
  }
}

/* Open one instance the way a real host does: the provider's feature block under the run's
 * feature options, at this instance's rate and block, with its own worker schedule. A strict
 * host refuses a plugin requiring a feature it does not offer before instantiating it.
 * `bind` also connects every port to a buffer of the type it expects. */
static struct rig *rig_open(struct host *h, double rate, uint32_t block, int bind) {
  struct rig *r = calloc(1, sizeof *r);
  if (r == NULL) return NULL;
  r->h = h;
  r->block = block;
  r->sched = (LV2_Worker_Schedule){r, schedule_work};
  const struct omx_lv2_feature_options *fo = &h->opts->feature;
  if (fo->strict && omx_lv2_features_admit(fo, h->required, &h->refused) != 0) {
    free(r);
    return NULL;
  }
  const LV2_Feature *const *features =
      omx_lv2_features_build(&r->feature_block, fo, rate, block, block, &r->sched);
  r->inst = features ? lilv_plugin_instantiate(h->plugin, rate, features) : NULL;
  if (r->inst == NULL) {
    free(r);
    return NULL;
  }
  r->handle = lilv_instance_get_handle(r->inst);
  r->wk = lilv_instance_get_extension_data(r->inst, LV2_WORKER__interface);
  if (r->wk != NULL) h->worker_interface = 1;
  for (int i = 0; i < h->n_params; i++) r->pvals[i] = h->params[i].def;
  r->note_block = -1;
  if (!bind) return r;

  r->audio_slots = (size_t)h->n_audio_in + h->n_audio_out + h->n_cv + 2;
  r->audio = calloc(r->audio_slots * block, sizeof(float));
  r->controls = calloc(h->n_ports, sizeof(float));
  r->atoms = calloc(h->n_ports, sizeof(void *));
  uint32_t ai = 0, ao = 0;
  for (uint32_t i = 0; i < h->n_ports; i++) {
    if (h->pk[i] == PK_AUDIO) {
      const int is_in = h->is_in[i];
      size_t slot = is_in ? ai++ : (h->n_audio_in + h->n_cv + ao++);
      if (slot >= r->audio_slots) slot = r->audio_slots - 1;
      lilv_instance_connect_port(r->inst, i, r->audio + slot * block);
    } else if (h->pk[i] == PK_CONTROL_IN || h->pk[i] == PK_CONTROL_OUT) {
      r->controls[i] = isnan(h->defs[i]) ? 0.0f : h->defs[i];
      lilv_instance_connect_port(r->inst, i, r->controls + i);
    } else {
      r->atoms[i] = calloc(1, atom_cap(h, i));
      atom_reset(h, r->atoms[i], i);
      lilv_instance_connect_port(r->inst, i, r->atoms[i]);
    }
  }
  return r;
}

static void rig_close(struct rig *r) {
  if (r == NULL) return;
  if (r->atoms) for (uint32_t i = 0; i < r->h->n_ports; i++) free(r->atoms[i]);
  free(r->atoms);
  free(r->audio);
  free(r->controls);
  free(r);
}

static float *rig_in(struct rig *r, uint32_t k) { return r->audio + (size_t)k * r->block; }
static const float *rig_out(struct rig *r) {
  return r->audio + (size_t)(r->h->n_audio_in + r->h->n_cv) * r->block;
}

/* The range a sweep covers for one control. `bounded` clamps it to musically sane limits: a
 * `units:db` control to +-sweep_db of its default, a strictly-positive default with a
 * non-negative range to default/ratio .. default*ratio. Anything else keeps its whole range. */
static int sweep_range(const struct host *h, double mn, double mx, double def, int is_db, int bounded,
                       double *lo, double *hi) {
  if (isnan(mn) || isnan(mx) || mx <= mn) return 0;
  *lo = mn;
  *hi = mx;
  if (bounded && !isnan(def)) {
    if (is_db) {
      *lo = fmax(mn, def - h->sweep_db);
      *hi = fmin(mx, def + h->sweep_db);
    } else if (def > 0.0 && mn >= 0.0) {
      *lo = fmax(mn, def / h->sweep_ratio);
      *hi = fmin(mx, def * h->sweep_ratio);
    }
  }
  return *hi > *lo;
}

/* Move every control input, and every patch:writable parameter, to position t (0..1) of its
 * range. Returns how many it moved. */
static int rig_sweep(struct rig *r, float t, int bounded) {
  struct host *h = r->h;
  int moved = 0;
  double lo, hi;
  for (uint32_t i = 0; i < h->n_ports; i++) {
    if (h->pk[i] != PK_CONTROL_IN) continue;
    if (!sweep_range(h, h->mins[i], h->maxes[i], h->defs[i], h->is_db[i], bounded, &lo, &hi)) continue;
    r->controls[i] = (float)(lo + (hi - lo) * t);
    moved++;
  }
  for (int k = 0; k < h->n_params; k++) {
    const struct param *p = &h->params[k];
    if (!sweep_range(h, p->lo, p->hi, p->def, 0, bounded, &lo, &hi)) continue;
    double v = lo + (hi - lo) * t;
    if (p->type == h->u_int || p->type == h->u_long) v = floor(v + 0.5);
    if (p->type == h->u_bool) v = t > 0.5 ? 1.0 : 0.0;
    r->pvals[k] = v;
    r->patch_live = 1;
    moved++;
  }
  return moved;
}

/* patch:Set for the next PATCH_SETS_PER_BLOCK writable parameters, at frame 0, into the open sequence */
static void forge_patch(struct rig *r) {
  struct host *h = r->h;
  LV2_Atom_Forge *f = &h->forge;
  const int n = h->n_params;
  const int count = n < PATCH_SETS_PER_BLOCK ? n : PATCH_SETS_PER_BLOCK;
  for (int k = 0; k < count; k++) {
    const int i = (r->pcursor + k) % n;
    const struct param *p = &h->params[i];
    LV2_Atom_Forge_Frame of;
    lv2_atom_forge_frame_time(f, 0);
    lv2_atom_forge_object(f, &of, 0, h->u_patch_set);
    lv2_atom_forge_key(f, h->u_patch_prop);
    lv2_atom_forge_urid(f, p->key);
    lv2_atom_forge_key(f, h->u_patch_val);
    if (p->type == h->u_float) lv2_atom_forge_float(f, (float)r->pvals[i]);
    else if (p->type == h->u_int) lv2_atom_forge_int(f, (int32_t)r->pvals[i]);
    else if (p->type == h->u_bool) lv2_atom_forge_bool(f, r->pvals[i] > 0.5);
    else if (p->type == h->u_long) lv2_atom_forge_long(f, (int64_t)r->pvals[i]);
    else lv2_atom_forge_double(f, r->pvals[i]);
    lv2_atom_forge_pop(f, &of);
    h->patch_sets++;
  }
  r->pcursor = (r->pcursor + count) % n;
}

/* ---- the note sweep: the CLAP prober's pattern (clap-qualify.c note_block), in MIDI's dialect ---- */

#define NOTE_CYCLE 8u
#define NOTE_BURST 32u
static const uint8_t CHORD[] = { 60, 64, 67 };
#define CHORD_SIZE (sizeof CHORD / sizeof CHORD[0])

static void forge_midi(struct rig *r, uint32_t time, uint8_t status, uint8_t a, uint8_t b) {
  struct host *h = r->h;
  const uint8_t msg[3] = { status, a, b };
  lv2_atom_forge_frame_time(&h->forge, time);
  lv2_atom_forge_atom(&h->forge, sizeof msg, h->u_midi);
  lv2_atom_forge_write(&h->forge, msg, sizeof msg);
  h->note_events++;
}

static uint8_t velocity(double v) { return (uint8_t)(v * 127.0 + 0.5); }

/* the MIDI events of block b of the note sweep, by b's place in the cycle, in time order */
static void forge_note_block(struct rig *r, uint32_t b, uint32_t frames) {
  const uint32_t step = frames / 8u ? frames / 8u : 1u;
  switch (b % NOTE_CYCLE) {
  case 0:
    for (uint32_t k = 0; k < CHORD_SIZE; k++) forge_midi(r, 0, 0x90, CHORD[k], velocity(0.8));
    break;
  case 1:
    for (uint32_t t = 0; t < 8u; t++) {
      const unsigned v = (unsigned)(((double)t / 4.0 - 1.0 + 1.0) * 8191.5);
      forge_midi(r, t * step, 0xE0, (uint8_t)(v & 0x7f), (uint8_t)(v >> 7 & 0x7f));
      forge_midi(r, t * step, 0xB0, 1, (uint8_t)(t * 16u));
    }
    break;
  case 2:
    for (uint32_t t = 0; t < 8u; t++) forge_midi(r, t * step, 0xD0, velocity((double)t / 7.0), 0);
    break;
  case 3:
    for (uint32_t k = 0; k < CHORD_SIZE; k++) forge_midi(r, 0, 0x80, CHORD[k], 0);
    break;
  case 4:
  case 5:
    for (uint32_t k = 0; k < NOTE_BURST; k++)
      forge_midi(r, k * frames / NOTE_BURST, b % NOTE_CYCLE == 4 ? 0x90 : 0x80, (uint8_t)(36 + k),
                 velocity(0.25 + 0.5 * (double)k / NOTE_BURST));
    break;
  case 6:
    forge_midi(r, 0, 0x90, 72, 127);
    forge_midi(r, frames / 2u, 0xB0, 123, 0);
    break;
  default:
    break; /* the release tails */
  }
}

/* the latency pass's note (A4, as the CLAP prober plays it), and the cost pass's held keys spread across a piano */
#define PROBE_NOTE_KEY 69
#define PIANO_LOW_KEY 21
#define PIANO_HIGH_KEY 108
#define PIANO_KEYS 88u
#define MIDI_KEYS 128u

static uint8_t held_key(uint32_t i, uint32_t n) {
  if (n <= 1) return PROBE_NOTE_KEY;
  const uint32_t low = n <= PIANO_KEYS ? PIANO_LOW_KEY : 0, high = n <= PIANO_KEYS ? PIANO_HIGH_KEY : MIDI_KEYS - 1;
  return (uint8_t)(low + i * (high - low) / (n - 1));
}

static void forge_probe_or_note_block(struct rig *r) {
  switch (r->probe_note) {
  case 1: forge_midi(r, 0, 0x90, PROBE_NOTE_KEY, 127); break;
  case 2: forge_midi(r, 0, 0x80, PROBE_NOTE_KEY, 0); break;
  case 3:
    for (uint32_t k = 0; k < r->held; k++) forge_midi(r, 0, 0x90, held_key(k, r->held), 127);
    break;
  default: forge_note_block(r, (uint32_t)r->note_block, r->block); break;
  }
}

/* One atom input's sequence for this block: patch:Set when it takes them and the sweep moved one, then the note
 * sweep's events when it takes MIDI and the block plays one (the patch events at frame 0 come first). */
static void forge_port(struct rig *r, int port) {
  struct host *h = r->h;
  const int patch = port == h->patch_port && r->patch_live && h->n_params > 0;
  const int notes = port == h->midi_port && (r->note_block >= 0 || r->probe_note != 0);
  if (!patch && !notes) return;
  LV2_Atom_Forge *f = &h->forge;
  lv2_atom_forge_set_buffer(f, r->atoms[port], atom_cap(h, (uint32_t)port));
  LV2_Atom_Forge_Frame seq;
  lv2_atom_forge_sequence_head(f, &seq, 0);
  if (patch) forge_patch(r);
  if (notes) forge_probe_or_note_block(r);
  lv2_atom_forge_pop(f, &seq);
}

/* Before a block: every atom port is a fresh, valid sequence; patch:Set and the note sweep's MIDI go in. */
static void rig_prepare(struct rig *r) {
  struct host *h = r->h;
  for (uint32_t i = 0; i < h->n_ports; i++)
    if (r->atoms[i] != NULL) atom_reset(h, r->atoms[i], i);
  if (h->patch_port >= 0) forge_port(r, h->patch_port);
  if (h->midi_port >= 0 && h->midi_port != h->patch_port) forge_port(r, h->midi_port);
}

/* After a block, between blocks and OFF run(): the plugin's work(), then its answers through
 * work_response(), then end_run() — the cycle is complete once every answer is delivered (the
 * LV2 worker's order). All before the next block. */
static void rig_after(struct rig *r) {
  struct host *h = r->h;
  while (r->jh != r->jt) {
    const struct job *j = &r->jobs[r->jh];
    r->jh = (r->jh + 1) % MAX_JOBS;
    if (r->wk != NULL && r->wk->work != NULL) {
      r->wk->work(r->handle, worker_respond, r, j->size, j->data);
      h->worker_jobs++;
    } else {
      h->worker_dropped++;
    }
  }
  while (r->rh != r->rt) {
    const struct job *j = &r->resp[r->rh];
    r->rh = (r->rh + 1) % MAX_JOBS;
    if (r->wk != NULL && r->wk->work_response != NULL) {
      r->wk->work_response(r->handle, j->size, j->data);
      h->worker_responses++;
    }
  }
  if (r->wk != NULL && r->wk->end_run != NULL) r->wk->end_run(r->handle);
}
/* LV2_CORE__CVPort comes from lv2/core/lv2.h via lilv.h. */

/* The interposer's control surface, resolved at start-up. All NULL when the library
 * was not preloaded, which is reported as no-interposer rather than as zero counts. */
static void (*rt_begin)(void);
static void (*rt_end)(void);
static void (*rt_reset)(void);
static void (*rt_counts)(uint64_t *, uint64_t *, uint64_t *);
static int (*rt_present)(void);
static int (*rt_events)(struct omx_rt_event *, int);

static void resolve_interposer(void) {
  rt_begin = dlsym(RTLD_DEFAULT, "omx_rt_begin");
  rt_end = dlsym(RTLD_DEFAULT, "omx_rt_end");
  rt_reset = dlsym(RTLD_DEFAULT, "omx_rt_reset");
  rt_counts = dlsym(RTLD_DEFAULT, "omx_rt_counts");
  rt_present = dlsym(RTLD_DEFAULT, "omx_rt_present");
  rt_events = dlsym(RTLD_DEFAULT, "omx_rt_events");
}

/* Threads in this process, from /proc/self/task. The spec's `threadsAfterInstantiate`
 * is a measured fact, not a guess from the plugin's class. */
static int count_threads(void) {
  DIR *d = opendir("/proc/self/task");
  if (d == NULL) return -1;
  int n = 0;
  for (struct dirent *e = readdir(d); e != NULL; e = readdir(d)) {
    if (e->d_name[0] != '.') n++;
  }
  closedir(d);
  return n;
}

/* Resident set, in kB. A plugin that leaks shows here long before it crashes. */
static long rss_kb(void) {
  FILE *f = fopen("/proc/self/statm", "r");
  if (f == NULL) return -1;
  long total = 0, res = 0;
  if (fscanf(f, "%ld %ld", &total, &res) != 2) res = -1;
  fclose(f);
  return res > 0 ? res * (sysconf(_SC_PAGESIZE) / 1024) : -1;
}

static const char *rt_kind_name(int k) {
  switch (k) {
  case OMX_RT_MALLOC: return "malloc"; case OMX_RT_CALLOC: return "calloc";
  case OMX_RT_REALLOC: return "realloc"; case OMX_RT_FREE: return "free";
  case OMX_RT_MUTEX_LOCK: return "mutex_lock"; case OMX_RT_MUTEX_TRYLOCK: return "mutex_trylock";
  case OMX_RT_OPEN: return "open"; case OMX_RT_NANOSLEEP: return "nanosleep";
  case OMX_RT_WRITE: return "write"; case OMX_RT_READ: return "read";
  default: return "?";
  }
}

/* The frame that OWNS an event: the first one not inside the interposer, libc, the
 * unwinder or this host. That is the plugin (or a library it calls), which is the fact a
 * decision needs — "one lock" becomes "one lock from lsp-plugins.so". */
static void rt_owner(const struct omx_rt_event *e, const char **module, const char **symbol) {
  *module = "?"; *symbol = "?";
  for (int i = 0; i < e->depth; i++) {
    Dl_info info;
    if (!dladdr(e->frames[i], &info) || !info.dli_fname) continue;
    const char *base = strrchr(info.dli_fname, '/');
    base = base ? base + 1 : info.dli_fname;
    if (strstr(base, "rt_interpose") || strstr(base, "libc.so") || strstr(base, "libgcc") ||
        strstr(base, "libpthread") || strstr(base, "lv2_measure") || strstr(base, "ld-linux"))
      continue;
    *module = base;
    *symbol = info.dli_sname ? info.dli_sname : "?";
    return;
  }
}

/* A JSON string, escaped enough for URIs and plugin names. */
static void json_str(FILE *out, const char *s) {
  fputc('"', out);
  for (const char *p = s; p && *p; p++) {
    if (*p == '"' || *p == '\\') fprintf(out, "\\%c", *p);
    else if ((unsigned char)*p < 0x20) fprintf(out, "\\u%04x", *p);
    else fputc(*p, out);
  }
  fputc('"', out);
}

/* `--pin <uri>`: the plugin's pin alone, read from the world without instantiating it — a re-vet of
 * the bytes, and the line the console's pin_set is built from. Exit 0, or 3 when there is no such plugin. */
static int pin_only(const char *uri) {
  LilvWorld *world = lilv_world_new();
  lilv_world_load_all(world);
  LilvNode *uri_node = lilv_new_uri(world, uri);
  const LilvPlugin *plugin = lilv_plugins_get_by_uri(lilv_world_get_all_plugins(world), uri_node);
  printf("{\"uri\":");
  json_str(stdout, uri);
  printf(",\"found\":%s", plugin ? "true" : "false");
  if (plugin) omx_lv2_pin_print(stdout, world, plugin);
  printf("}\n");
  lilv_node_free(uri_node);
  lilv_world_free(world);
  return plugin ? 0 : 3;
}

/* Where the JSON goes. A plugin may print on stdout while it instantiates (Guitarix:
 * "using block size: 0", "convolver disabled"); with the same buffer that tore this program's
 * own JSON line in two. fd 1 is therefore moved to stderr and the record goes to a private
 * dup of the original stdout. */
static FILE *jout;

/* The facts about what the host did, so a measurement can prove the injection landed. */
/* The first events, attributed. Deduplicated by (kind, module, symbol) so a plugin that mallocs 600 000 times
 * reports one line, and one that does three different things reports three. */
static void emit_rt_events(const struct omx_rt_event *seen, int n_seen) {
  const char *dk[OMX_RT_EV_MAX], *dm[OMX_RT_EV_MAX], *ds[OMX_RT_EV_MAX];
  int nd = 0;
  for (int i = 0; i < n_seen; i++) {
    const char *mod, *sym;
    rt_owner(&seen[i], &mod, &sym);
    const char *kind = rt_kind_name(seen[i].kind);
    int dup = 0;
    for (int j = 0; j < nd; j++)
      if (!strcmp(dk[j], kind) && !strcmp(dm[j], mod) && !strcmp(ds[j], sym)) { dup = 1; break; }
    if (dup) continue;
    dk[nd] = kind; dm[nd] = mod; ds[nd] = sym;
    fprintf(jout, "%s{\"kind\":\"%s\",\"module\":", nd ? "," : "", kind);
    json_str(jout, mod);
    fprintf(jout, ",\"symbol\":");
    json_str(jout, sym);
    fprintf(jout, "}");
    nd++;
  }
}

static void emit_host_facts(const struct host *h) {
  fprintf(jout, ",\"host\":{\"options\":true,\"workerInterface\":%s,\"workerJobs\":%ld,"
                "\"workerResponses\":%ld,\"workerDropped\":%ld,\"patchParams\":%d,"
                "\"patchPort\":%s,\"patchSets\":%ld,\"sweepDb\":%g,\"sweepRatio\":%g}",
          h->worker_interface ? "true" : "false", h->worker_jobs, h->worker_responses,
          h->worker_dropped, h->n_params, h->patch_port >= 0 ? "true" : "false", h->patch_sets,
          h->sweep_db, h->sweep_ratio);
}

/* The required feature a strict host refused the plugin for, when that is why nothing instantiated. */
static void emit_refusal(const struct host *h) {
  if (h->refused == NULL) return;
  fprintf(jout, ",\"refusedFeature\":");
  json_str(jout, h->refused);
}

static void fill_input(struct rig *r, unsigned *rng, int noise, uint32_t block, double rate, long frame0) {
  for (uint32_t i = 0; i < r->h->n_audio_in; i++) {
    float *in = rig_in(r, i);
    for (uint32_t f = 0; f < block; f++) {
      if (noise) {
        *rng = *rng * 1103515245u + 12345u;
        in[f] = 0.1f * ((float)((*rng >> 16) & 0x7fff) / 16384.0f - 1.0f);
      } else {
        in[f] = 0.1f * sinf(2.0f * (float)M_PI * 1000.0f * (float)(frame0 + f) / (float)rate);
      }
    }
  }
}

/* The run's feature options, and the buffer --log capture appends to. */
static struct lv2_measure_options g_opts;
static char *g_capture;

/* --log route: each line on stderr, which is where fd 1 went too, never into the record. */
static void log_to_stderr(void *ctx, const char *type, const char *line) {
  (void)ctx;
  const char *kind = type ? strrchr(type, '#') : NULL;
  const size_t len = strlen(line);
  fprintf(stderr, "lv2-measure: log %s: %.*s\n", kind ? kind + 1 : "?", (int)(len && line[len - 1] == '\n' ? len - 1 : len),
          line);
}

/* The record's featureOptions, beside whatever the log captured. */
static void emit_feature_options(void) {
  lv2_measure_options_print(jout, &g_opts, g_capture);
}

/* What main holds once the host is open, released on every way out, after the instances are gone. */
static void release(struct host *h, LilvNodes *required, LilvNodes *optional, LilvNode *uri_node, LilvWorld *world) {
  free(h->required);
  host_close(h);
  free(h);
  free(g_capture);
  lilv_nodes_free(required);
  lilv_nodes_free(optional);
  lilv_node_free(uri_node);
  lilv_world_free(world);
}

/* ---- latency and cost, per rate -----------------------------------------------------------------
 *
 * The CLAP prober's definitions (native/clap-qualify.c measure_rate and cost_rate), in LV2's host, so a
 * record holds the same two figures whichever format the plugin is:
 *
 *   latency  declaredFrames: what the plugin reports itself, read from its latency port (lv2:designation
 *            lv2:latency, or the older lv2:reportsLatency) after a block has run; 0 when it has no such port, said by
 *            declaredFrom. measuredFrames: an impulse of 1.0 at frame 0 of every audio input at the control
 *            defaults, the response kept as the loudest output at each frame up to the declared figure plus
 *            LATENCY_TAIL, and the arrival read as the first frame at or above LATENCY_ONSET_OF_PEAK of the
 *            response's own peak. An instrument (no audio input, a MIDI input) is played A4 at velocity 127
 *            at frame 0 instead and let go at the end (`from: note`). A response that never leaves silence
 *            has no measured figure: it says why, never a guessed 0.
 *   cost     every control swept across its range, noise on every audio input, each run() timed alone: the
 *            warm-up head dropped, nanoseconds per sample, the median and the 95th percentile. An instrument
 *            holds OMX_PROBE_NOTES keys down; given none it is not timed and says why (the CLAP prober's
 *            --probe-notes).
 *
 * Both are taken at the run's rate (the positional argument) and its block, the rate and block of the grid point the
 * rt-safety counts are, so a point of the record holds the three together.
 */
#define LATENCY_TAIL 8192u
#define LATENCY_SILENCE 1e-6f
#define LATENCY_ONSET_OF_PEAK 1e-3f
#define LATENCY_DECLARED_MAX (1u << 20)
#define COST_WARMUP_BLOCKS 64u
#define COST_BLOCKS 512u
#define COST_PERCENTILE 95.0

struct latency_at {
  const char *unmeasured; /* NULL when measured: a word of the contract's unmeasured reasons */
  const char *detail;
  uint32_t declared, measured;
  int declared_from_port, by_note;
};

struct cost_at {
  const char *unmeasured; /* NULL when measured */
  const char *detail;
  double median, p95, min, max, warmup_median;
  uint32_t blocks, held;
};

static int64_t now_ns(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC_RAW, &t);
  return (int64_t)t.tv_sec * 1000000000 + t.tv_nsec;
}

static int by_value(const void *a, const void *b) {
  const double x = *(const double *)a, y = *(const double *)b;
  return x < y ? -1 : x > y;
}

/* the linear-interpolated percentile of n sorted values (numpy's default, the CLAP prober's) */
static double percentile_sorted(const double *v, uint32_t n, double pct) {
  if (n == 1) return v[0];
  const double pos = (double)(n - 1) * pct / 100.0;
  const uint32_t low = (uint32_t)pos, high = low + 1 < n ? low + 1 : n - 1;
  return v[low] + (v[high] - v[low]) * (pos - (double)low);
}

static void zero_inputs(struct rig *r) {
  for (uint32_t k = 0; k < r->h->n_audio_in; k++) memset(rig_in(r, k), 0, r->block * sizeof(float));
}

static void measure_latency(struct host *H, double rate, uint32_t block, struct latency_at *L) {
  memset(L, 0, sizeof *L);
  L->declared_from_port = H->latency_port >= 0;
  L->by_note = H->n_audio_in == 0 && H->midi_port >= 0;
  if (H->n_audio_out == 0) {
    L->unmeasured = "no-audio-out", L->detail = "the plugin has no audio output to read a response from";
    return;
  }
  if (H->n_audio_in == 0 && !L->by_note) {
    L->unmeasured = "no-audio-in", L->detail = "no audio input to put an impulse in and no MIDI input to play";
    return;
  }
  struct rig *r = rig_open(H, rate, block, 1);
  const size_t cap = (size_t)LATENCY_DECLARED_MAX + LATENCY_TAIL + block;
  float *mag = r ? calloc(cap, sizeof *mag) : NULL;
  if (r == NULL || mag == NULL) {
    L->unmeasured = r == NULL ? "refused-instantiation" : "probe-error";
    L->detail = r == NULL ? "the plugin would not instantiate for the latency run" : "out of memory for the response";
    free(mag);
    if (r != NULL) lilv_instance_free(r->inst);
    rig_close(r);
    return;
  }
  lilv_instance_activate(r->inst);
  uint32_t horizon = LATENCY_TAIL;
  int nonfinite = 0;
  for (uint32_t base = 0; base < horizon && !L->unmeasured; base += block) {
    zero_inputs(r);
    if (base == 0)
      for (uint32_t k = 0; k < H->n_audio_in; k++) rig_in(r, k)[0] = 1.0f;
    r->probe_note = L->by_note ? (base == 0 ? 1 : (base + block >= horizon ? 2 : 0)) : 0;
    rig_prepare(r);
    lilv_instance_run(r->inst, block);
    rig_after(r);
    if (H->latency_port >= 0) {
      /* the port is written by run(): its value is read after the block, and moves the horizon with it */
      const float v = r->controls[H->latency_port];
      if (!isfinite(v) || v < 0.0f || v > (float)LATENCY_DECLARED_MAX) {
        L->unmeasured = "probe-error", L->detail = "the latency port reports a value that is no frame count";
        break;
      }
      L->declared = (uint32_t)(v + 0.5f);
      horizon = L->declared + LATENCY_TAIL;
    }
    const float *o = rig_out(r);
    for (uint32_t i = 0; i < block && base + i < cap; i++)
      for (uint32_t c = 0; c < H->n_audio_out; c++) {
        const float x = o[(size_t)c * block + i];
        if (!isfinite(x)) {
          nonfinite = 1;
          continue;
        }
        if (fabsf(x) > mag[base + i]) mag[base + i] = fabsf(x);
      }
    if (nonfinite) L->unmeasured = "non-finite-output", L->detail = "the response held a NaN or an infinity";
  }
  if (!L->unmeasured) {
    float peak = 0.0f;
    for (uint32_t i = 0; i < horizon; i++)
      if (mag[i] > peak) peak = mag[i];
    const float floor = peak * LATENCY_ONSET_OF_PEAK > LATENCY_SILENCE ? peak * LATENCY_ONSET_OF_PEAK : LATENCY_SILENCE;
    uint32_t seen_at = UINT32_MAX;
    for (uint32_t i = 0; i < horizon && peak > LATENCY_SILENCE; i++)
      if (mag[i] >= floor) {
        seen_at = i;
        break;
      }
    if (seen_at == UINT32_MAX) {
      L->unmeasured = "silent-output";
      L->detail = L->by_note ? "the note never sounded within the declared latency and the tail" : "the impulse never came out within the declared latency and the tail";
    } else {
      L->measured = seen_at;
    }
  }
  lilv_instance_deactivate(r->inst);
  lilv_instance_free(r->inst);
  rig_close(r);
  free(mag);
}

static void measure_cost(struct host *H, double rate, uint32_t block, struct cost_at *C) {
  memset(C, 0, sizeof *C);
  const int instrument = H->n_audio_in == 0 && H->midi_port >= 0;
  if (instrument) {
    const char *n = getenv("OMX_PROBE_NOTES");
    const long held = n ? atol(n) : 0;
    if (held <= 0) {
      C->unmeasured = "voices-unknown", C->detail = "an instrument with no probe count (OMX_PROBE_NOTES) to hold: no note was held down";
      return;
    }
    C->held = held > (long)MIDI_KEYS ? MIDI_KEYS : (uint32_t)held;
  }
  struct rig *r = rig_open(H, rate, block, 1);
  const uint32_t total = COST_WARMUP_BLOCKS + COST_BLOCKS;
  double *ns = r ? calloc(total, sizeof *ns) : NULL;
  if (r == NULL || ns == NULL) {
    C->unmeasured = r == NULL ? "refused-instantiation" : "probe-error";
    C->detail = r == NULL ? "the plugin would not instantiate for the cost run" : "out of memory for the block times";
    free(ns);
    if (r != NULL) lilv_instance_free(r->inst);
    rig_close(r);
    return;
  }
  lilv_instance_activate(r->inst);
  unsigned seed = 0x636f73u;
  for (uint32_t b = 0; b < total; b++) {
    rig_sweep(r, (float)((b * 7u) % 101u) / 100.0f, 0);
    for (uint32_t k = 0; k < H->n_audio_in; k++) {
      float *in = rig_in(r, k);
      for (uint32_t i = 0; i < block; i++) {
        seed = seed * 1664525u + 1013904223u;
        in[i] = ((float)(seed >> 8) / 16777216.0f - 0.5f) * 0.5f;
      }
    }
    r->probe_note = instrument && b == 0 ? 3 : 0;
    r->held = C->held;
    rig_prepare(r);
    const int64_t t0 = now_ns();
    lilv_instance_run(r->inst, block);
    ns[b] = (double)(now_ns() - t0) / (double)block;
    rig_after(r);
  }
  lilv_instance_deactivate(r->inst);
  lilv_instance_free(r->inst);
  rig_close(r);
  double *warm = ns, *timed = ns + COST_WARMUP_BLOCKS;
  qsort(warm, COST_WARMUP_BLOCKS, sizeof *warm, by_value);
  qsort(timed, COST_BLOCKS, sizeof *timed, by_value);
  C->warmup_median = percentile_sorted(warm, COST_WARMUP_BLOCKS, 50.0);
  C->median = percentile_sorted(timed, COST_BLOCKS, 50.0);
  C->p95 = percentile_sorted(timed, COST_BLOCKS, COST_PERCENTILE);
  C->min = timed[0];
  C->max = timed[COST_BLOCKS - 1];
  C->blocks = COST_BLOCKS;
  free(ns);
}

/* the latency map, in the shape the CLAP prober's line has: per rate, what the plugin reports and what was measured */
static void emit_latency(double rate, const struct latency_at *L) {
  fprintf(jout, ",\"latency\":{\"%.0f\":{\"declaredFrames\":%u,\"declaredFrom\":\"%s\"", rate, L->declared, L->declared_from_port ? "port" : "none");
  if (!L->unmeasured) fprintf(jout, ",\"measuredFrames\":%u", L->measured);
  if (L->by_note) fprintf(jout, ",\"from\":\"note\"");
  if (L->unmeasured) {
    fprintf(jout, ",\"unmeasuredReason\":");
    json_str(jout, L->unmeasured);
    fprintf(jout, ",\"unmeasuredDetail\":");
    json_str(jout, L->detail);
  }
  fprintf(jout, "}}");
}

/* the cost object, in the shape the CLAP prober's line has */
static void emit_cost(double rate, const struct cost_at *C, uint32_t block, int instrument) {
  fprintf(jout, ",\"cost\":{\"stimulus\":\"%s\",\"blockFrames\":%u,\"warmupBlocks\":%u,\"percentile\":%.0f,\"perRate\":{\"%.0f\":{",
          instrument ? "notes-held" : "noise", block, COST_WARMUP_BLOCKS, COST_PERCENTILE, rate);
  if (C->unmeasured) {
    fprintf(jout, "\"unmeasuredReason\":");
    json_str(jout, C->unmeasured);
    fprintf(jout, ",\"unmeasuredDetail\":");
    json_str(jout, C->detail);
  } else {
    fprintf(jout, "\"nsPerSampleMedian\":%.6g,\"nsPerSampleP95\":%.6g,\"nsPerSampleMin\":%.6g,\"nsPerSampleMax\":%.6g,"
                  "\"warmupNsPerSampleMedian\":%.6g,\"blocks\":%u",
            C->median, C->p95, C->min, C->max, C->warmup_median, C->blocks);
  }
  if (instrument && C->held) fprintf(jout, ",\"voices\":{\"held\":%u,\"basis\":\"probe\"}", C->held);
  fprintf(jout, "}}}");
}

static void usage(FILE *out, const char *self) {
  fprintf(out,
          "usage: %s [flags] <plugin-uri> [rate] [block] [cycles] [repeats]\n"
          "       %s --pin <plugin-uri>\n"
          "       %s --help\n\n%s",
          self, self, self, LV2_MEASURE_OPTIONS_HELP);
}

int main(int argc, char **argv) {
  /* lilv refuses a relative LV2_PATH segment and the world it leaves is a null dereference: resolve them first. */
  if (lv2_path_resolve_env() != 0) {
    fprintf(stderr, "lv2-measure: cannot resolve LV2_PATH against the working directory: %s\n", strerror(errno));
    return 1;
  }
  /* The flags anywhere on the line, the positionals in their order. */
  const char *pos[5] = {NULL};
  int npos = 0, pin = 0;
  lv2_measure_options_init(&g_opts);
  for (int i = 1; i < argc;) {
    const char *why = NULL;
    if (!strcmp(argv[i], "--help")) {
      usage(stdout, argv[0]);
      return 0;
    }
    if (!strcmp(argv[i], "--pin")) {
      pin = 1;
      i++;
      continue;
    }
    const int taken = lv2_measure_option_parse(&g_opts, argc, argv, &i, &why);
    if (taken < 0) {
      fprintf(stderr, "lv2-measure: %s: %s\n", argv[i], why);
      return 1;
    }
    if (taken > 0) continue;
    if (!strncmp(argv[i], "--", 2) || npos == 5) {
      fprintf(stderr, "lv2-measure: unexpected argument: %s\n", argv[i]);
      usage(stderr, argv[0]);
      return 1;
    }
    pos[npos++] = argv[i++];
  }
  if (npos < 1 || (pin && npos != 1)) {
    usage(stderr, argv[0]);
    return 1;
  }
  if (pin) return pin_only(pos[0]);
  const char *uri = pos[0];
  const double rate = pos[1] ? atof(pos[1]) : 192000.0;
  const uint32_t block = pos[2] ? (uint32_t)atoi(pos[2]) : 512;
  const int cycles = pos[3] ? atoi(pos[3]) : 20;
  /* RT safety is measured REPEATS times and reported as the worst case. A single
   * sample is not a measurement here: LSP's gate swings between 0 and 74 allocations
   * across identical runs, so one clean run would have licensed it onto the RT
   * thread. The max is what an operator actually risks. */
  const int repeats = pos[4] ? atoi(pos[4]) : 3;

  /* The options the provider is handed, refused here rather than as a plugin that would not
   * instantiate: what the provider checks, and block lengths whose minimum passes the maximum. */
  if (g_opts.feature.log.mode == OMX_LV2_LOG_ROUTE) g_opts.feature.log.sink = log_to_stderr;
  if (g_opts.feature.log.mode == OMX_LV2_LOG_CAPTURE) {
    g_capture = calloc(1, g_opts.capture_bytes);
    g_opts.feature.log.capture = g_capture;
    g_opts.feature.log.capture_size = g_capture ? g_opts.capture_bytes : 0;
  }
  {
    const struct omx_lv2_feature_options *fo = &g_opts.feature;
    const uint32_t lo = fo->block.min ? fo->block.min : block, hi = fo->block.max ? fo->block.max : block;
    if (omx_lv2_feature_options_check(fo) != 0 || lo > hi) {
      fprintf(stderr, "lv2-measure: the feature options do not hold together (block lengths %u..%u)\n", lo, hi);
      free(g_capture);
      return 1;
    }
  }

  fflush(stdout);
  {
    const int fd = dup(1);
    if (fd >= 0 && dup2(2, 1) >= 0) jout = fdopen(fd, "w");
    if (jout == NULL) jout = stdout;
  }
  const int warmup_blocks = 64, measured_blocks = 512;

  /* A tone excites a narrow band; noise excites everything. AmpVTS's rate-dependent
   * death showed under noise and hid under a 1 kHz sine, so the stimulus is a knob
   * and the sweep runs the one that reproduces known failures. */
  const int use_noise = getenv("OMX_STIM") && strcmp(getenv("OMX_STIM"), "noise") == 0;
  unsigned rng = 12345u;

  resolve_interposer();

  LilvWorld *world = lilv_world_new();
  lilv_world_load_all(world);
  const LilvPlugins *plugins = lilv_world_get_all_plugins(world);
  LilvNode *uri_node = lilv_new_uri(world, uri);
  const LilvPlugin *plugin = lilv_plugins_get_by_uri(plugins, uri_node);
  if (plugin == NULL) {
    fprintf(stderr, "lv2-measure: no such plugin: %s\n", uri);
    fprintf(jout, "{\"uri\":");
    json_str(jout, uri);
    fprintf(jout, ",\"found\":false}\n");
    lilv_node_free(uri_node);
    lilv_world_free(world);
    free(g_capture);
    return 3;
  }

  /* ---- features, straight from the bundle ---- */
  LilvNodes *required = lilv_plugin_get_required_features(plugin);
  LilvNodes *optional = lilv_plugin_get_optional_features(plugin);

  /* ---- ports and parameters: classify, and find what the sweep will drive ---- */
  struct host *hp = calloc(1, sizeof *hp);
  host_open(hp, world, plugin);
  struct host *H = hp;
  H->opts = &g_opts;
  {
    size_t n = 0, k = 0;
    LILV_FOREACH (nodes, i, required) n++;
    H->required = calloc(n + 1, sizeof *H->required);
    LILV_FOREACH (nodes, i, required) if (H->required) H->required[k++] = lilv_node_as_uri(lilv_nodes_get(required, i));
  }
  const uint32_t n_audio_in = H->n_audio_in, n_audio_out = H->n_audio_out;
  const uint32_t n_cv = H->n_cv, n_control_in = H->n_control_in;

  /* ---- SOAK MODE ----------------------------------------------------------
   * The stability dimension's real question is not "does it start" but "does it
   * still work in the third hour". AmpVTS dies two seconds into a 96 kHz render;
   * a leak shows only as RSS climbing over many minutes. So this runs one instance
   * continuously, sweeps every control slowly across its range, and watches three
   * things per one-second window: the output stays finite, it does not fall away
   * from the level it started at, and the process does not grow.
   *
   * The sweep is BOUNDED to musically sane ranges (sweep_range): a startup blast the
   * sweep itself drives is not the plugin's.
   *
   * It short-circuits the rest of the program: a soak is a long measurement of one
   * thing, not an addendum to the quick ones.
   */
  const char *soak_env = getenv("OMX_SOAK_SECONDS");
  if (soak_env != NULL && atoi(soak_env) > 0) {
    const double soak_s = atof(soak_env);
    struct rig *si = rig_open(H, rate, block, 1);
    if (si == NULL) {
      fprintf(jout, "{\"uri\":");
      json_str(jout, uri);
      fprintf(jout, ",\"soak\":{\"instantiated\":false}");
      emit_refusal(H);
      emit_feature_options();
      fprintf(jout, "}\n");
      release(H, required, optional, uri_node, world);
      return 2;
    }
    lilv_instance_activate(si->inst);

    const long total_blocks = (long)(soak_s * rate / block);
    const long win_blocks = (long)(rate / block); /* ~1 s */
    long b = 0, windows = 0, nonfinite_windows = 0, silent_windows = 0;
    double first_rms = -1.0, last_rms = -1.0, min_rms = 1e30, max_rms = 0.0;
    long rss_start = rss_kb(), rss_max = rss_start;
    double win_sum = 0.0;
    long win_n = 0;
    for (b = 0; b < total_blocks; b++) {
      const float t = (float)(b % 4096) / 4096.0f; /* slow, repeating parameter sweep */
      rig_sweep(si, t, 1);
      fill_input(si, &rng, 1, block, rate, 0);
      rig_prepare(si);
      lilv_instance_run(si->inst, block);
      rig_after(si);
      if (n_audio_out > 0) {
        const float *o = rig_out(si);
        int win_nonfinite = 0;
        for (uint32_t f = 0; f < block; f++) {
          const float v = o[f];
          if (!isfinite(v)) win_nonfinite = 1;
          else win_sum += (double)v * (double)v;
        }
        win_n += block;
        if (win_nonfinite) nonfinite_windows++;
      }
      if ((b + 1) % win_blocks == 0) {
        const double rms = win_n ? sqrt(win_sum / (double)win_n) : 0.0;
        if (first_rms < 0 && windows >= 2) first_rms = rms; /* skip settling */
        last_rms = rms;
        if (rms < min_rms) min_rms = rms;
        if (rms > max_rms) max_rms = rms;
        /* Dead relative to what this plugin was doing at the start: a ratio. */
        if (first_rms > 0 && rms > 0 && omx_lin_to_db_d(rms / first_rms, 0.0) < -40.0) silent_windows++;
        else if (first_rms > 0 && rms == 0.0) silent_windows++;
        const long r = rss_kb();
        if (r > rss_max) rss_max = r;
        windows++;
        win_sum = 0.0;
        win_n = 0;
      }
    }
    lilv_instance_deactivate(si->inst);
    lilv_instance_free(si->inst);
    fprintf(jout, "{\"uri\":");
    json_str(jout, uri);
    fprintf(jout, ",\"soak\":{\"instantiated\":true,\"seconds\":%.0f,\"rate\":%.0f,\"block\":%u"
           ",\"windows\":%ld,\"nonFiniteWindows\":%ld,\"silentWindows\":%ld"
           ",\"firstRmsDbfs\":%.2f,\"lastRmsDbfs\":%.2f,\"minRmsDbfs\":%.2f,\"maxRmsDbfs\":%.2f"
           ",\"rssStartKb\":%ld,\"rssMaxKb\":%ld,\"rssGrowthKb\":%ld}",
           soak_s, rate, block, windows, nonfinite_windows, silent_windows,
           first_rms > 0 ? omx_lin_to_db_d(first_rms, 0.0) : -999.0,
           last_rms > 0 ? omx_lin_to_db_d(last_rms, 0.0) : -999.0,
           min_rms < 1e29 && min_rms > 0 ? omx_lin_to_db_d(min_rms, 0.0) : -999.0,
           max_rms > 0 ? omx_lin_to_db_d(max_rms, 0.0) : -999.0,
           rss_start, rss_max, rss_max - rss_start);
    emit_host_facts(H);
    emit_feature_options();
    fprintf(jout, "}\n");
    rig_close(si);
    release(H, required, optional, uri_node, world);
    return 0;
  }

  /* ---- lifecycle: instantiate and destroy, counting what does not come back ---- */
  const int threads_before = count_threads();
  int instantiated = 0, failed = 0;
  int threads_after_first = -1;
  for (int c = 0; c < cycles; c++) {
    struct rig *ci = rig_open(H, rate, block, 0);
    if (ci == NULL) {
      failed++;
      continue;
    }
    lilv_instance_activate(ci->inst);
    if (c == 0) threads_after_first = count_threads();
    lilv_instance_deactivate(ci->inst);
    lilv_instance_free(ci->inst);
    rig_close(ci);
    instantiated++;
  }
  const int threads_after = count_threads();

  if (instantiated == 0) {
    fprintf(jout, "{\"uri\":");
    json_str(jout, uri);
    fprintf(jout, ",\"found\":true,\"instantiated\":false,\"cyclesAttempted\":%d", cycles);
    emit_refusal(H);
    emit_feature_options();
    fprintf(jout, "}\n");
    release(H, required, optional, uri_node, world);
    return 2;
  }

  /* ---- rt-safety: repeated, worst-case ---- */
  uint64_t allocs = 0, locks = 0, syscalls = 0;
  uint64_t allocs_min = UINT64_MAX, locks_min = UINT64_MAX, syscalls_min = UINT64_MAX;
  int swept = 0;
  struct omx_rt_event seen[OMX_RT_EV_MAX];
  int n_seen = 0;
  for (int rep = 0; rep < repeats; rep++) {
  struct rig *inst = rig_open(H, rate, block, 1);
  uint64_t r_allocs = 0, r_locks = 0, r_syscalls = 0;
  if (inst != NULL) {
    /* Every port gets the buffer type it actually expects (rig_open). An atom port handed a
     * float* is a segfault, not a measurement — LSP's equalisers carry two of them
     * beside 196 control ports, which is how this was found. */

    /* A -20 dBFS tone, so the plugin has real signal rather than silence: a gate or
     * an expander given silence never leaves its quiet branch and would measure as
     * RT-clean while its loud path allocates. */
    fill_input(inst, &rng, use_noise, block, rate, 0);

    lilv_instance_activate(inst->inst);
    for (int b = 0; b < warmup_blocks; b++) {
      rig_prepare(inst);
      lilv_instance_run(inst->inst, block);
      rig_after(inst);
    }

    if (rt_reset) rt_reset();
    for (int b = 0; b < measured_blocks; b++) {
      /* Sweep every control input, and every patch:writable parameter, across its FULL
       * declared range as the blocks go by: this judges what allocates when a control
       * crosses a threshold, not level, so it is not bounded like the soak. */
      const float t = (float)b / (float)measured_blocks;
      if (rig_sweep(inst, t, 0) > 0) swept = 1;
      rig_prepare(inst);
      if (rt_begin) rt_begin();
      lilv_instance_run(inst->inst, block);
      if (rt_end) rt_end();
      rig_after(inst);
    }
    if (rt_counts) rt_counts(&r_allocs, &r_locks, &r_syscalls);
    if (rt_events && n_seen == 0) n_seen = rt_events(seen, OMX_RT_EV_MAX);
    lilv_instance_deactivate(inst->inst);
    lilv_instance_free(inst->inst);
    rig_close(inst);
  }
  if (r_allocs > allocs) allocs = r_allocs;
  if (r_locks > locks) locks = r_locks;
  if (r_syscalls > syscalls) syscalls = r_syscalls;
  if (r_allocs < allocs_min) allocs_min = r_allocs;
  if (r_locks < locks_min) locks_min = r_locks;
  if (r_syscalls < syscalls_min) syscalls_min = r_syscalls;
  }
  if (allocs_min == UINT64_MAX) allocs_min = 0;
  if (locks_min == UINT64_MAX) locks_min = 0;
  if (syscalls_min == UINT64_MAX) syscalls_min = 0;

  /* ---- the note sweep: a plugin with a MIDI input, played, counted apart ---- */
  struct {
    int played, nonfinite, n_seen;
    long events;
    uint64_t allocs, locks, syscalls;
    struct omx_rt_event seen[OMX_RT_EV_MAX];
  } ns = {0};
  if (H->midi_port >= 0) {
    struct rig *ni = rig_open(H, rate, block, 1);
    if (ni != NULL) {
      fill_input(ni, &rng, use_noise, block, rate, 0);
      lilv_instance_activate(ni->inst);
      for (int b = 0; b < warmup_blocks; b++) {
        rig_prepare(ni);
        lilv_instance_run(ni->inst, block);
        rig_after(ni);
      }
      const long before = H->note_events;
      if (rt_reset) rt_reset();
      for (int b = 0; b < measured_blocks; b++) {
        ni->note_block = b;
        rig_prepare(ni);
        if (rt_begin) rt_begin();
        lilv_instance_run(ni->inst, block);
        if (rt_end) rt_end();
        rig_after(ni);
        if (n_audio_out > 0) {
          const float *o = rig_out(ni);
          for (uint32_t f = 0; f < block; f++)
            if (!isfinite(o[f])) ns.nonfinite = 1;
        }
      }
      ns.events = H->note_events - before;
      if (rt_counts) rt_counts(&ns.allocs, &ns.locks, &ns.syscalls);
      if (rt_events) ns.n_seen = rt_events(ns.seen, OMX_RT_EV_MAX);
      ns.played = 1;
      lilv_instance_deactivate(ni->inst);
      lilv_instance_free(ni->inst);
      rig_close(ni);
    }
  }

  /* A plugin with no sweepable control was still measured; saying it was swept would
   * be a lie the classifier would act on. Report what happened. */
  const int sweep_applicable = n_control_in > 0 || H->n_params > 0;

  fprintf(jout, "{\"uri\":");
  json_str(jout, uri);
  fprintf(jout, ",\"found\":true,\"instantiated\":true");
  fprintf(jout, ",\"rate\":%.0f,\"block\":%u", rate, block);
  fprintf(jout, ",\"audioInputs\":%u,\"audioOutputs\":%u,\"cvPorts\":%u,\"controlInputs\":%u",
         n_audio_in, n_audio_out, n_cv, n_control_in);
  /* the pin (plugin-qualify spec §11): the files this world loaded the plugin from, and its layout */
  omx_lv2_pin_print(jout, world, plugin);

  fprintf(jout, ",\"requiredFeatures\":[");
  int first = 1;
  LILV_FOREACH (nodes, i, required) {
    const LilvNode *n = lilv_nodes_get(required, i);
    if (!first) fprintf(jout, ",");
    json_str(jout, lilv_node_as_string(n));
    first = 0;
  }
  fprintf(jout, "],\"optionalFeatures\":[");
  first = 1;
  LILV_FOREACH (nodes, i, optional) {
    const LilvNode *n = lilv_nodes_get(optional, i);
    if (!first) fprintf(jout, ",");
    json_str(jout, lilv_node_as_string(n));
    first = 0;
  }
  fprintf(jout, "]");

  fprintf(jout, ",\"lifecycle\":{\"cycles\":%d,\"instantiated\":%d,\"failed\":%d}",
         cycles, instantiated, failed);
  fprintf(jout, ",\"threads\":{\"before\":%d,\"afterFirstInstantiate\":%d,\"afterAllFreed\":%d,\"leaked\":%d}",
         threads_before, threads_after_first, threads_after,
         threads_after > threads_before ? threads_after - threads_before : 0);
  fprintf(jout, ",\"rtSafety\":{\"interposer\":%s,\"blocks\":%d,\"repeats\":%d,\"swept\":%s,"
         "\"sweepApplicable\":%s,\"allocationsInRun\":%llu,\"allocationsMin\":%llu,"
         "\"variable\":%s,\"locksInRun\":%llu,\"locksMin\":%llu,"
         "\"syscallsInRun\":%llu,\"syscallsMin\":%llu,\"events\":[",
         (rt_present && rt_present()) ? "true" : "false",
         measured_blocks, repeats, swept ? "true" : "false", sweep_applicable ? "true" : "false",
         (unsigned long long)allocs, (unsigned long long)allocs_min,
         (allocs != allocs_min || locks != locks_min || syscalls != syscalls_min) ? "true" : "false",
         (unsigned long long)locks, (unsigned long long)locks_min,
         (unsigned long long)syscalls, (unsigned long long)syscalls_min);
  emit_rt_events(seen, n_seen);
  fprintf(jout, "]");
  /* the note sweep: not applicable without a MIDI input, its counts only under the interposer */
  if (!ns.played) {
    fprintf(jout, ",\"noteSweep\":{\"applicable\":false}");
  } else {
    const int counted = rt_present && rt_present();
    fprintf(jout, ",\"noteSweep\":{\"applicable\":true,\"dialect\":\"midi\",\"blocks\":%d,\"blockFrames\":%u,"
            "\"noteEvents\":%ld,\"processErrors\":0,\"nonFinite\":%s,\"interposer\":%s",
            measured_blocks, block, ns.events, ns.nonfinite ? "true" : "false", counted ? "true" : "false");
    if (counted) {
      fprintf(jout, ",\"allocationsInRun\":%llu,\"locksInRun\":%llu,\"syscallsInRun\":%llu,\"events\":[",
              (unsigned long long)ns.allocs, (unsigned long long)ns.locks, (unsigned long long)ns.syscalls);
      emit_rt_events(ns.seen, ns.n_seen);
      fprintf(jout, "]");
    }
    fprintf(jout, "}");
  }
  fprintf(jout, "}");

  /* ---- rate support: instantiate and RUN at each rate the console can boot at ----
   * Instantiating is not enough. AmpVTS instantiates happily at 96 kHz and then
   * outputs digital silence, which is why this runs blocks and checks the output is
   * finite and non-silent for a plugin that was given signal. A plugin that dies or
   * goes quiet at a rate must not be offered at that rate. The rates are the declared ones
   * (OMX_DECLARED_RATES, <omxcontract/omx_contract_limits.h>: omx-contract's STANDARD_SAMPLE_RATES). The probe
   * runs through the same host as everything else — options, worker — so a plugin whose sound
   * depends on its worker is measured built. */
  fprintf(jout, ",\"rates\":{");
  for (size_t ri = 0; ri < OMX_DECLARED_RATE_COUNT; ri++) {
    const double r = OMX_DECLARED_RATES[ri];
    int ok = 0, nonfinite = 0;
    double rms_out = -1.0;
    struct rig *pr = rig_open(H, r, block, 1);
    if (pr != NULL) {
      lilv_instance_activate(pr->inst);
      double sum = 0.0;
      const char *pb = getenv("OMX_PROBE_BLOCKS");
      const int probe_blocks = pb ? atoi(pb) : 96;
      const int probe_settle = probe_blocks / 3;
      for (int b2 = 0; b2 < probe_blocks; b2++) {
        fill_input(pr, &rng, use_noise, block, r, (long)b2 * block);
        rig_prepare(pr);
        lilv_instance_run(pr->inst, block);
        rig_after(pr);
        if (b2 >= probe_settle && n_audio_out > 0) {
          const float *o = rig_out(pr);
          for (uint32_t f = 0; f < block; f++) {
            const float v = o[f];
            if (!isfinite(v)) nonfinite = 1;
            else sum += (double)v * (double)v;
          }
        }
      }
      rms_out = n_audio_out ? sqrt(sum / ((double)(probe_blocks - probe_settle) * block)) : -1.0;
      /* An ABSOLUTE silence threshold cannot see AmpVTS: it reads 1.07e-5 at 96 kHz,
       * quiet enough to be useless and loud enough to pass any fixed floor. The
       * verdict is a RATIO against the plugin's own best rate, computed by the
       * caller from the per-rate rms this emits. Reported here, judged there. */
      ok = 1;
      lilv_instance_deactivate(pr->inst);
      lilv_instance_free(pr->inst);
      rig_close(pr);
    }
    fprintf(jout, "%s\"%.0f\":{\"instantiated\":%s,\"nonFinite\":%s,"
           "\"rms\":%.9g,\"rmsDbfs\":%.2f}",
           ri ? "," : "", r, ok ? "true" : "false",
           nonfinite ? "true" : "false", rms_out,
           rms_out > 0 ? omx_lin_to_db_d(rms_out, 0.0) : -999.0);
  }
  fprintf(jout, "}");

  /* ---- latency and cost at the run's rate and block (see the passes above) ---- */
  {
    struct latency_at lat;
    struct cost_at cost;
    measure_latency(H, rate, block, &lat);
    measure_cost(H, rate, block, &cost);
    emit_latency(rate, &lat);
    emit_cost(rate, &cost, block, n_audio_in == 0 && H->midi_port >= 0);
  }
  emit_host_facts(H);
  emit_feature_options();
  fprintf(jout, "}\n");
  fflush(jout);

  release(H, required, optional, uri_node, world);
  return 0;
}
