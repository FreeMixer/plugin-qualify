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
 *   rtSafety   allocations, locks and syscalls counted INSIDE run(), under a sweep
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
 * WHAT IT DOES NOT DO. It does not soak — the spec's stability dimension also wants a
 * continuous run at least as long as the operator's longest show, which is hours and
 * belongs in a scheduled sweep rather than here. A plugin passing this program still
 * reads `unknown` until it has been soaked, and that is deliberate.
 *
 *   npm run build:lv2-measure   (cc ... -Isrc tools/lv2-measure.c tools/lv2-measure-features.c
 *                                tools/lv2-measure-pin.c, plugin-hostd's include directory,
 *                                lilv, -lpthread -lm -ldl: package.json carries the line)
 *   LD_PRELOAD=$PWD/build/rt_interpose.so ./build/lv2_measure <uri> [rate] [block] [cycles]
 *   ./build/lv2_measure --pin <uri>       the pin alone, nothing instantiated
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
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <lilv/lilv.h>
#include "rt-interpose.h"
#include "lv2-measure-features.h"
#include "lv2-measure-pin.h"
#include "omx_console_limits.h"
#include <lv2/atom/atom.h>

/*
 * THE HOST FEATURES WE PROVIDE ARE THE MEASUREMENT'S DEFINITION.
 *
 * A plugin measured under a host that offers more than ours does would earn a
 * verdict our RT thread cannot honour; measured under one that offers less, a
 * perfectly good plugin fails to instantiate and reads as broken. So the providers
 * are lv2-measure-features.h's, built on the kinds the LV2 adapter the engine hosts
 * through provides (host-backend-one-contract §3) — one URI table, the options at the
 * measured rate and block, a silent log. The worker's schedule is this program's own
 * (below). Instantiating with NULL
 * features, which is what this program did first, made every LSP plugin segfault:
 * they require urid:map, and a host that does not map URIs is not a host.
 */
/*
 * The worker. A real host runs work() off the audio thread; scheduling from run()
 * must not block. Jobs are queued here and drained by the main thread between
 * blocks, which is a genuine non-RT execution rather than an inline call — a plugin
 * that deadlocks or misbehaves when work() does not run inline is exactly what this
 * catches, and calling work() inline would hide it.
 *
 * FINDING (2026-10-01, lane lv2-host-features-one-home, not fixed there): nothing in this
 * program drains job_queue and `worker_respond` is never handed to a work() call — the
 * build warns it is unused, which is why build:lv2-measure carries no -Werror. A plugin's
 * scheduled work is queued and dropped, so the paragraph above describes the intent, not
 * the measurement; the worker's non-RT execution is unmeasured until a drain lands.
 */
#define MAX_JOBS 64
static struct {
  uint32_t size;
  uint8_t data[8192];
} job_queue[MAX_JOBS];
static int job_head, job_tail;

static LV2_Worker_Status schedule_work(LV2_Worker_Schedule_Handle h, uint32_t size,
                                       const void *data) {
  (void)h;
  int next = (job_tail + 1) % MAX_JOBS;
  if (next == job_head || size > sizeof job_queue[0].data) return LV2_WORKER_ERR_NO_SPACE;
  job_queue[job_tail].size = size;
  memcpy(job_queue[job_tail].data, data, size);
  job_tail = next;
  return LV2_WORKER_SUCCESS;
}

static LV2_Worker_Status worker_respond(LV2_Worker_Respond_Handle h, uint32_t size,
                                        const void *data) {
  (void)h;
  (void)size;
  (void)data;
  return LV2_WORKER_SUCCESS;
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
 * ruling needs — "one lock" becomes "one lock from lsp-plugins.so". */
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

int main(int argc, char **argv) {
  if (argc == 3 && !strcmp(argv[1], "--pin")) return pin_only(argv[2]);
  if (argc < 2) {
    fprintf(stderr, "usage: %s <plugin-uri> [rate] [block] [cycles] | %s --pin <plugin-uri>\n", argv[0], argv[0]);
    return 1;
  }
  const char *uri = argv[1];
  const double rate = argc > 2 ? atof(argv[2]) : 192000.0;
  const uint32_t block = argc > 3 ? (uint32_t)atoi(argv[3]) : 512;
  const int cycles = argc > 4 ? atoi(argv[4]) : 20;
  /* RT safety is measured REPEATS times and reported as the worst case. A single
   * sample is not a measurement here: LSP's gate swings between 0 and 74 allocations
   * across identical runs, so one clean run would have licensed it onto the RT
   * thread. The max is what an operator actually risks. */
  const int repeats = argc > 5 ? atoi(argv[5]) : 3;
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
    printf("{\"uri\":");
    json_str(stdout, uri);
    printf(",\"found\":false}\n");
    lilv_node_free(uri_node);
    lilv_world_free(world);
    return 3;
  }

  /* ---- features, straight from the bundle ---- */
  LilvNodes *required = lilv_plugin_get_required_features(plugin);
  LilvNodes *optional = lilv_plugin_get_optional_features(plugin);

  /* ---- ports: classify, and find the control ports the sweep will drive ---- */
  const uint32_t n_ports = lilv_plugin_get_num_ports(plugin);
  LilvNode *audio_class = lilv_new_uri(world, LV2_CORE__AudioPort);
  LilvNode *control_class = lilv_new_uri(world, LV2_CORE__ControlPort);
  LilvNode *input_class = lilv_new_uri(world, LV2_CORE__InputPort);
  LilvNode *output_class = lilv_new_uri(world, LV2_CORE__OutputPort);
  LilvNode *cv_class = lilv_new_uri(world, LV2_CORE__CVPort);

  float *mins = calloc(n_ports, sizeof(float));
  float *maxes = calloc(n_ports, sizeof(float));
  float *defs = calloc(n_ports, sizeof(float));
  lilv_plugin_get_port_ranges_float(plugin, mins, maxes, defs);

  uint32_t n_audio_in = 0, n_audio_out = 0, n_cv = 0, n_control_in = 0;
  for (uint32_t i = 0; i < n_ports; i++) {
    const LilvPort *port = lilv_plugin_get_port_by_index(plugin, i);
    if (lilv_port_is_a(plugin, port, cv_class)) n_cv++;
    else if (lilv_port_is_a(plugin, port, audio_class)) {
      if (lilv_port_is_a(plugin, port, input_class)) n_audio_in++;
      else if (lilv_port_is_a(plugin, port, output_class)) n_audio_out++;
    } else if (lilv_port_is_a(plugin, port, control_class) &&
               lilv_port_is_a(plugin, port, input_class)) {
      n_control_in++;
    }
  }


  /* The host's feature block (lv2-measure-features.h), built once and used for every
   * instantiate below; the rate probe rebuilds the options in place for each rate. */
  LV2_Worker_Schedule schedule = {NULL, schedule_work};
  static struct omx_lv2_options options;
  omx_lv2_options_build(&options, rate, block);
  struct omx_lv2_feature_block feature_block;
  const LV2_Feature *const *features =
      omx_lv2_features_build(&feature_block, OMX_LV2_LILV_HOST_FEATURES, &options, &schedule);


  /* ---- SOAK MODE ----------------------------------------------------------
   * The stability dimension's real question is not "does it start" but "does it
   * still work in the third hour". AmpVTS dies two seconds into a 96 kHz render;
   * a leak shows only as RSS climbing over many minutes. So this runs one instance
   * continuously, sweeps every control slowly across its range, and watches three
   * things per one-second window: the output stays finite, it does not fall away
   * from the level it started at, and the process does not grow.
   *
   * It short-circuits the rest of the program: a soak is a long measurement of one
   * thing, not an addendum to the quick ones.
   */
  const char *soak_env = getenv("OMX_SOAK_SECONDS");
  if (soak_env != NULL && atoi(soak_env) > 0) {
    const double soak_s = atof(soak_env);
    LilvInstance *si = lilv_plugin_instantiate(plugin, rate, features);
    if (si == NULL) {
      printf("{\"uri\":");
      json_str(stdout, uri);
      printf(",\"soak\":{\"instantiated\":false}}\n");
      return 2;
    }
    const size_t slots = (size_t)n_audio_in + n_audio_out + n_cv + 2;
    float *ab = calloc(slots * block, sizeof(float));
    float *cb = calloc(n_ports, sizeof(float));
    void **atb = calloc(n_ports, sizeof(void *));
    uint32_t sai = 0, sao = 0;
    for (uint32_t i = 0; i < n_ports; i++) {
      const LilvPort *port = lilv_plugin_get_port_by_index(plugin, i);
      const int is_in = lilv_port_is_a(plugin, port, input_class);
      if (lilv_port_is_a(plugin, port, audio_class) || lilv_port_is_a(plugin, port, cv_class)) {
        size_t slot = is_in ? sai++ : (n_audio_in + n_cv + sao++);
        if (slot >= slots) slot = slots - 1;
        lilv_instance_connect_port(si, i, ab + slot * block);
      } else if (lilv_port_is_a(plugin, port, control_class)) {
        cb[i] = isnan(defs[i]) ? 0.0f : defs[i];
        lilv_instance_connect_port(si, i, cb + i);
      } else {
        const size_t cap = 8192;
        uint8_t *b = calloc(1, cap);
        atb[i] = b;
        LV2_Atom_Sequence *sq = (LV2_Atom_Sequence *)b;
        sq->atom.size = is_in ? (uint32_t)sizeof(LV2_Atom_Sequence_Body)
                              : (uint32_t)(cap - sizeof(LV2_Atom));
        lilv_instance_connect_port(si, i, b);
      }
    }
    lilv_instance_activate(si);

    const long total_blocks = (long)(soak_s * rate / block);
    const long win_blocks = (long)(rate / block); /* ~1 s */
    long b = 0, windows = 0, nonfinite_windows = 0, silent_windows = 0;
    double first_rms = -1.0, last_rms = -1.0, min_rms = 1e30, max_rms = 0.0;
    long rss_start = rss_kb(), rss_max = rss_start;
    double win_sum = 0.0;
    long win_n = 0;
    for (b = 0; b < total_blocks; b++) {
      const float t = (float)(b % 4096) / 4096.0f; /* slow, repeating parameter sweep */
      for (uint32_t i = 0; i < n_ports; i++) {
        const LilvPort *port = lilv_plugin_get_port_by_index(plugin, i);
        if (!lilv_port_is_a(plugin, port, control_class)) continue;
        if (!lilv_port_is_a(plugin, port, input_class)) continue;
        if (isnan(mins[i]) || isnan(maxes[i]) || maxes[i] <= mins[i]) continue;
        cb[i] = mins[i] + (maxes[i] - mins[i]) * t;
      }
      for (uint32_t i = 0; i < n_audio_in; i++) {
        for (uint32_t f = 0; f < block; f++) {
          rng = rng * 1103515245u + 12345u;
          ab[i * block + f] = 0.1f * ((float)((rng >> 16) & 0x7fff) / 16384.0f - 1.0f);
        }
      }
      lilv_instance_run(si, block);
      if (n_audio_out > 0) {
        const float *o = ab + (size_t)(n_audio_in + n_cv) * block;
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
        if (first_rms > 0 && rms > 0 && 20.0 * log10(rms / first_rms) < -40.0) silent_windows++;
        else if (first_rms > 0 && rms == 0.0) silent_windows++;
        const long r = rss_kb();
        if (r > rss_max) rss_max = r;
        windows++;
        win_sum = 0.0;
        win_n = 0;
      }
    }
    lilv_instance_deactivate(si);
    lilv_instance_free(si);
    printf("{\"uri\":");
    json_str(stdout, uri);
    printf(",\"soak\":{\"instantiated\":true,\"seconds\":%.0f,\"rate\":%.0f,\"block\":%u"
           ",\"windows\":%ld,\"nonFiniteWindows\":%ld,\"silentWindows\":%ld"
           ",\"firstRmsDbfs\":%.2f,\"lastRmsDbfs\":%.2f,\"minRmsDbfs\":%.2f"
           ",\"rssStartKb\":%ld,\"rssMaxKb\":%ld,\"rssGrowthKb\":%ld}}\n",
           soak_s, rate, block, windows, nonfinite_windows, silent_windows,
           first_rms > 0 ? 20.0 * log10(first_rms) : -999.0,
           last_rms > 0 ? 20.0 * log10(last_rms) : -999.0,
           min_rms < 1e29 && min_rms > 0 ? 20.0 * log10(min_rms) : -999.0,
           rss_start, rss_max, rss_max - rss_start);
    free(ab);
    free(cb);
    for (uint32_t i = 0; i < n_ports; i++) free(atb[i]);
    free(atb);
    return 0;
  }

  /* ---- lifecycle: instantiate and destroy, counting what does not come back ---- */
  const int threads_before = count_threads();
  int instantiated = 0, failed = 0;
  int threads_after_first = -1;
  for (int c = 0; c < cycles; c++) {
    LilvInstance *inst = lilv_plugin_instantiate(plugin, rate, features);
    if (inst == NULL) {
      failed++;
      continue;
    }
    lilv_instance_activate(inst);
    if (c == 0) threads_after_first = count_threads();
    lilv_instance_deactivate(inst);
    lilv_instance_free(inst);
    instantiated++;
  }
  const int threads_after = count_threads();

  if (instantiated == 0) {
    printf("{\"uri\":");
    json_str(stdout, uri);
    printf(",\"found\":true,\"instantiated\":false,\"cyclesAttempted\":%d}\n", cycles);
    return 2;
  }

  /* ---- rt-safety: repeated, worst-case ---- */
  uint64_t allocs = 0, locks = 0, syscalls = 0;
  uint64_t allocs_min = UINT64_MAX, locks_min = UINT64_MAX, syscalls_min = UINT64_MAX;
  int swept = 0;
  struct omx_rt_event seen[OMX_RT_EV_MAX];
  int n_seen = 0;
  for (int rep = 0; rep < repeats; rep++) {
  LilvInstance *inst = lilv_plugin_instantiate(plugin, rate, features);
  uint64_t r_allocs = 0, r_locks = 0, r_syscalls = 0;
  if (inst != NULL) {
    /* Every port gets the buffer type it actually expects. An atom port handed a
     * float* is a segfault, not a measurement — LSP's equalisers carry two of them
     * beside 196 control ports, which is how this was found. */
    const size_t audio_slots = (size_t)n_audio_in + n_audio_out + n_cv + 2;
    float *audio = calloc(audio_slots * block, sizeof(float));
    float *controls = calloc(n_ports, sizeof(float));
    void **atom_bufs = calloc(n_ports, sizeof(void *));
    uint32_t ai = 0, ao = 0;
    for (uint32_t i = 0; i < n_ports; i++) {
      const LilvPort *port = lilv_plugin_get_port_by_index(plugin, i);
      const int is_in = lilv_port_is_a(plugin, port, input_class);
      if (lilv_port_is_a(plugin, port, audio_class) || lilv_port_is_a(plugin, port, cv_class)) {
        size_t slot = is_in ? ai++ : (n_audio_in + n_cv + ao++);
        if (slot >= audio_slots) slot = audio_slots - 1;
        lilv_instance_connect_port(inst, i, audio + slot * block);
      } else if (lilv_port_is_a(plugin, port, control_class)) {
        controls[i] = isnan(defs[i]) ? 0.0f : defs[i];
        lilv_instance_connect_port(inst, i, controls + i);
      } else {
        /* Anything else — atom, event, MIDI — gets a real, correctly headed buffer.
         * An input sequence is empty but VALID (v1 feeds no events); an output
         * sequence advertises its capacity so the plugin can write into it. */
        const size_t cap = 8192;
        uint8_t *buf = calloc(1, cap);
        atom_bufs[i] = buf;
        LV2_Atom_Sequence *seq = (LV2_Atom_Sequence *)buf;
        seq->atom.size = is_in ? (uint32_t)sizeof(LV2_Atom_Sequence_Body)
                               : (uint32_t)(cap - sizeof(LV2_Atom));
        seq->atom.type = 0; /* no URID map here: an unmapped type is inert, not a lie */
        seq->body.unit = 0;
        seq->body.pad = 0;
        lilv_instance_connect_port(inst, i, buf);
      }
    }
    /* A -20 dBFS tone, so the plugin has real signal rather than silence: a gate or
     * an expander given silence never leaves its quiet branch and would measure as
     * RT-clean while its loud path allocates. */
    for (uint32_t i = 0; i < n_audio_in; i++) {
      for (uint32_t f = 0; f < block; f++) {
        if (use_noise) {
          rng = rng * 1103515245u + 12345u;
          audio[i * block + f] = 0.1f * ((float)((rng >> 16) & 0x7fff) / 16384.0f - 1.0f);
        } else {
          audio[i * block + f] = 0.1f * sinf(2.0f * (float)M_PI * 1000.0f * (float)f / (float)rate);
        }
      }
    }

    lilv_instance_activate(inst);
    for (int b = 0; b < warmup_blocks; b++) lilv_instance_run(inst, block);

    if (rt_reset) rt_reset();
    for (int b = 0; b < measured_blocks; b++) {
      /* Sweep every control input across its declared range as the blocks go by, so
       * the counted window covers the settings an operator will actually reach. */
      const float t = (float)b / (float)measured_blocks;
      for (uint32_t i = 0; i < n_ports; i++) {
        const LilvPort *port = lilv_plugin_get_port_by_index(plugin, i);
        if (!lilv_port_is_a(plugin, port, control_class)) continue;
        if (!lilv_port_is_a(plugin, port, input_class)) continue;
        if (isnan(mins[i]) || isnan(maxes[i]) || maxes[i] <= mins[i]) continue;
        controls[i] = mins[i] + (maxes[i] - mins[i]) * t;
        swept = 1;
      }
      if (rt_begin) rt_begin();
      lilv_instance_run(inst, block);
      if (rt_end) rt_end();
    }
    if (rt_counts) rt_counts(&r_allocs, &r_locks, &r_syscalls);
    if (rt_events && n_seen == 0) n_seen = rt_events(seen, OMX_RT_EV_MAX);
    lilv_instance_deactivate(inst);
    lilv_instance_free(inst);
    free(audio);
    free(controls);
    for (uint32_t i = 0; i < n_ports; i++) free(atom_bufs[i]);
    free(atom_bufs);
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

  /* A plugin with no sweepable control was still measured; saying it was swept would
   * be a lie the classifier would act on. Report what happened. */
  const int sweep_applicable = n_control_in > 0;

  printf("{\"uri\":");
  json_str(stdout, uri);
  printf(",\"found\":true,\"instantiated\":true");
  printf(",\"rate\":%.0f,\"block\":%u", rate, block);
  printf(",\"audioInputs\":%u,\"audioOutputs\":%u,\"cvPorts\":%u,\"controlInputs\":%u",
         n_audio_in, n_audio_out, n_cv, n_control_in);
  /* the pin (plugin-qualify spec §11): the files this world loaded the plugin from, and its layout */
  omx_lv2_pin_print(stdout, world, plugin);

  printf(",\"requiredFeatures\":[");
  int first = 1;
  LILV_FOREACH (nodes, i, required) {
    const LilvNode *n = lilv_nodes_get(required, i);
    if (!first) printf(",");
    json_str(stdout, lilv_node_as_string(n));
    first = 0;
  }
  printf("],\"optionalFeatures\":[");
  first = 1;
  LILV_FOREACH (nodes, i, optional) {
    const LilvNode *n = lilv_nodes_get(optional, i);
    if (!first) printf(",");
    json_str(stdout, lilv_node_as_string(n));
    first = 0;
  }
  printf("]");

  printf(",\"lifecycle\":{\"cycles\":%d,\"instantiated\":%d,\"failed\":%d}",
         cycles, instantiated, failed);
  printf(",\"threads\":{\"before\":%d,\"afterFirstInstantiate\":%d,\"afterAllFreed\":%d,\"leaked\":%d}",
         threads_before, threads_after_first, threads_after,
         threads_after > threads_before ? threads_after - threads_before : 0);
  printf(",\"rtSafety\":{\"interposer\":%s,\"blocks\":%d,\"repeats\":%d,\"swept\":%s,"
         "\"sweepApplicable\":%s,\"allocationsInRun\":%llu,\"allocationsMin\":%llu,"
         "\"variable\":%s,\"locksInRun\":%llu,\"locksMin\":%llu,"
         "\"syscallsInRun\":%llu,\"syscallsMin\":%llu,\"events\":[",
         (rt_present && rt_present()) ? "true" : "false",
         measured_blocks, repeats, swept ? "true" : "false", sweep_applicable ? "true" : "false",
         (unsigned long long)allocs, (unsigned long long)allocs_min,
         (allocs != allocs_min || locks != locks_min || syscalls != syscalls_min) ? "true" : "false",
         (unsigned long long)locks, (unsigned long long)locks_min,
         (unsigned long long)syscalls, (unsigned long long)syscalls_min);
  /* The first events, attributed. Deduplicated by (kind, module, symbol) so a plugin that
   * mallocs 600 000 times reports one line, and one that does three different things
   * reports three. */
  {
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
      printf("%s{\"kind\":\"%s\",\"module\":", nd ? "," : "", kind);
      json_str(stdout, mod);
      printf(",\"symbol\":");
      json_str(stdout, sym);
      printf("}");
      nd++;
    }
  }
  printf("]}");

  /* ---- rate support: instantiate and RUN at each rate the console can boot at ----
   * Instantiating is not enough. AmpVTS instantiates happily at 96 kHz and then
   * outputs digital silence, which is why this runs blocks and checks the output is
   * finite and non-silent for a plugin that was given signal. A plugin that dies or
   * goes quiet at a rate must not be offered at that rate. The rates are the declared ones
   * (OMX_DECLARED_RATES, generated from core's STANDARD_SAMPLE_RATES). */
  printf(",\"rates\":{");
  for (size_t ri = 0; ri < OMX_DECLARED_RATE_COUNT; ri++) {
    const double r = OMX_DECLARED_RATES[ri];
    int ok = 0, silent = 0, nonfinite = 0;
    double lat_frames = -1.0, rms_out = -1.0;
    omx_lv2_options_build(&options, r, block); /* the options name the rate it is instantiated at */
    LilvInstance *pi = lilv_plugin_instantiate(plugin, r, features);
    if (pi != NULL) {
      const size_t slots = (size_t)n_audio_in + n_audio_out + n_cv + 2;
      float *ab = calloc(slots * block, sizeof(float));
      float *cb = calloc(n_ports, sizeof(float));
      void **atb = calloc(n_ports, sizeof(void *));
      uint32_t pai = 0, pao = 0;
      for (uint32_t i = 0; i < n_ports; i++) {
        const LilvPort *port = lilv_plugin_get_port_by_index(plugin, i);
        const int is_in = lilv_port_is_a(plugin, port, input_class);
        if (lilv_port_is_a(plugin, port, audio_class) || lilv_port_is_a(plugin, port, cv_class)) {
          size_t slot = is_in ? pai++ : (n_audio_in + n_cv + pao++);
          if (slot >= slots) slot = slots - 1;
          lilv_instance_connect_port(pi, i, ab + slot * block);
        } else if (lilv_port_is_a(plugin, port, control_class)) {
          cb[i] = isnan(defs[i]) ? 0.0f : defs[i];
          lilv_instance_connect_port(pi, i, cb + i);
        } else {
          const size_t cap = 8192;
          uint8_t *b = calloc(1, cap);
          atb[i] = b;
          LV2_Atom_Sequence *sq = (LV2_Atom_Sequence *)b;
          sq->atom.size = is_in ? (uint32_t)sizeof(LV2_Atom_Sequence_Body)
                                : (uint32_t)(cap - sizeof(LV2_Atom));
          lilv_instance_connect_port(pi, i, b);
        }
      }
      lilv_instance_activate(pi);
      double sum = 0.0;
      const char *pb = getenv("OMX_PROBE_BLOCKS");
      const int probe_blocks = pb ? atoi(pb) : 96;
      const int probe_settle = probe_blocks / 3;
      for (int b2 = 0; b2 < probe_blocks; b2++) {
        for (uint32_t i = 0; i < n_audio_in; i++) {
          for (uint32_t f = 0; f < block; f++) {
            if (use_noise) {
              rng = rng * 1103515245u + 12345u;
              ab[i * block + f] = 0.1f * ((float)((rng >> 16) & 0x7fff) / 16384.0f - 1.0f);
            } else {
              ab[i * block + f] =
                  0.1f * sinf(2.0f * (float)M_PI * 1000.0f * (float)(b2 * block + f) / (float)r);
            }
          }
        }
        lilv_instance_run(pi, block);
        if (b2 >= probe_settle && n_audio_out > 0) {
          const float *o = ab + (size_t)(n_audio_in + n_cv) * block;
          for (uint32_t f = 0; f < block; f++) {
            const float v = o[f];
            if (!isfinite(v)) nonfinite = 1;
            else sum += (double)v * (double)v;
          }
        }
      }
      /* The plugin's own reported latency, if it publishes one. */
      for (uint32_t i = 0; i < n_ports; i++) {
        const LilvPort *port = lilv_plugin_get_port_by_index(plugin, i);
        if (!lilv_port_is_a(plugin, port, control_class)) continue;
        if (!lilv_port_is_a(plugin, port, output_class)) continue;
        LilvNode *dn = lilv_port_get_name(plugin, port);
        if (dn && strcasestr(lilv_node_as_string(dn), "latency")) lat_frames = cb[i];
        if (dn) lilv_node_free(dn);
      }
      rms_out = n_audio_out ? sqrt(sum / ((double)(probe_blocks - probe_settle) * block)) : -1.0;
      /* An ABSOLUTE silence threshold cannot see AmpVTS: it reads 1.07e-5 at 96 kHz,
       * quiet enough to be useless and loud enough to pass any fixed floor. The
       * verdict is a RATIO against the plugin's own best rate, computed by the
       * caller from the per-rate rms this emits. Reported here, judged there. */
      silent = 0;
      ok = 1;
      lilv_instance_deactivate(pi);
      lilv_instance_free(pi);
      free(ab);
      free(cb);
      for (uint32_t i = 0; i < n_ports; i++) free(atb[i]);
      free(atb);
    }
    printf("%s\"%.0f\":{\"instantiated\":%s,\"nonFinite\":%s,\"latencyFrames\":%.0f,"
           "\"rms\":%.9g,\"rmsDbfs\":%.2f}",
           ri ? "," : "", r, ok ? "true" : "false",
           nonfinite ? "true" : "false", lat_frames, rms_out,
           rms_out > 0 ? 20.0 * log10(rms_out) : -999.0);
    (void)silent;
  }
  printf("}");

  printf("}\n");

  free(mins);
  free(maxes);
  free(defs);
  lilv_nodes_free(required);
  lilv_nodes_free(optional);
  lilv_node_free(audio_class);
  lilv_node_free(control_class);
  lilv_node_free(input_class);
  lilv_node_free(output_class);
  lilv_node_free(cv_class);
  lilv_node_free(uri_node);
  lilv_world_free(world);
  return 0;
}
