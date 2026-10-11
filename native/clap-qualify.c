// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * clap-qualify — the CLAP prober of plugin-qualify: it loads a `.clap`, runs each of its plugins
 * headless at every rate it is given and prints, per plugin, one JSON line of what it MEASURED.
 * It judges nothing: the verdict is plugin-qualify's (`src/clap-qualify.ts`), read from these facts.
 *
 *   clap-qualify --rates <r,...> [--block <frames>] [--blocks <n>] <path.clap> [<id>]
 *
 * Per rate the plugin is activated, its latency read, an impulse run through `process()` to see
 * where it lands, and then every parameter is swept across its range through events while noise
 * plays in. Under LD_PRELOAD=rt_interpose.so the interposer counts the allocations, locks and
 * syscalls made inside each `process()` of the sweep; without it the line says so and counts
 * nothing. The file's SHA-256 is printed beside the facts, so a verdict is bound to the bytes it
 * was measured on.
 *
 * The host offers exactly the extensions in HOST_EXTENSIONS and nothing else, so a plugin that
 * needs more fails headless here rather than on the desk. A plugin calling a main-thread host
 * function from inside `process()` is a thread violation.
 *
 * Exit status: 0 every plugin was measured, 2 usage, or the file or the plugin could not be loaded
 * (the line still prints with what was read).
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <clap/clap.h>
#include <plugin-hostd/pin.h>

#include "rt-interpose.h"

#define MAX_RATES 16
#define MAX_PORTS 16
#define MAX_PARAMS 4096
/* parameter events one sweep block carries */
#define EVENTS_PER_BLOCK 64u
/* frames past the declared latency the impulse is looked for */
#define IMPULSE_TAIL 8192u
#define SILENCE 1e-6f

/* what the host offers, in the order the document lists it */
static const char *const HOST_EXTENSIONS[] = {
  CLAP_EXT_LOG, CLAP_EXT_THREAD_CHECK, CLAP_EXT_LATENCY, CLAP_EXT_PARAMS, CLAP_EXT_AUDIO_PORTS, CLAP_EXT_STATE,
};
#define HOST_EXTENSION_COUNT (sizeof HOST_EXTENSIONS / sizeof HOST_EXTENSIONS[0])

static const char *const EVENT_KIND[] = {
  [OMX_RT_MALLOC] = "malloc", [OMX_RT_CALLOC] = "calloc", [OMX_RT_REALLOC] = "realloc", [OMX_RT_FREE] = "free",
  [OMX_RT_MUTEX_LOCK] = "pthread_mutex_lock", [OMX_RT_MUTEX_TRYLOCK] = "pthread_mutex_trylock",
  [OMX_RT_OPEN] = "open", [OMX_RT_NANOSLEEP] = "nanosleep", [OMX_RT_WRITE] = "write", [OMX_RT_READ] = "read",
};

/* ---- the interposer, when it is in the process ---- */

struct interposer {
  void (*begin)(void);
  void (*end)(void);
  void (*reset)(void);
  void (*counts)(uint64_t *, uint64_t *, uint64_t *);
  int (*events)(struct omx_rt_event *, int);
};

static int interposer_find(struct interposer *ip) {
  memset(ip, 0, sizeof *ip);
  if (!dlsym(RTLD_DEFAULT, "omx_rt_present")) return 0;
  *(void **)&ip->begin = dlsym(RTLD_DEFAULT, "omx_rt_begin");
  *(void **)&ip->end = dlsym(RTLD_DEFAULT, "omx_rt_end");
  *(void **)&ip->reset = dlsym(RTLD_DEFAULT, "omx_rt_reset");
  *(void **)&ip->counts = dlsym(RTLD_DEFAULT, "omx_rt_counts");
  *(void **)&ip->events = dlsym(RTLD_DEFAULT, "omx_rt_events");
  return ip->begin && ip->end && ip->reset && ip->counts && ip->events;
}

/* ---- the host object ---- */

/* One plugin at a time, on one thread: `in_process` is the audio thread's window. */
static struct {
  int in_process;
  uint32_t thread_violations;
} g_host;

static void main_thread_only(void) {
  if (g_host.in_process) g_host.thread_violations++;
}

static void host_log(const clap_host_t *h, clap_log_severity severity, const char *msg) {
  (void)h;
  /* a message from process() is dropped: writing it would be the host's syscall, counted as the plugin's */
  if (!g_host.in_process) fprintf(stderr, "clap-qualify: plugin log %d: %s\n", (int)severity, msg ? msg : "");
}
static const clap_host_log_t g_log = { host_log };

static bool host_is_main_thread(const clap_host_t *h) { (void)h; return !g_host.in_process; }
static bool host_is_audio_thread(const clap_host_t *h) { (void)h; return g_host.in_process; }
static const clap_host_thread_check_t g_thread_check = { host_is_main_thread, host_is_audio_thread };

static void host_latency_changed(const clap_host_t *h) { (void)h; main_thread_only(); }
static const clap_host_latency_t g_latency = { host_latency_changed };

static void host_params_rescan(const clap_host_t *h, clap_param_rescan_flags f) { (void)h; (void)f; main_thread_only(); }
static void host_params_clear(const clap_host_t *h, clap_id id, clap_param_clear_flags f) { (void)h; (void)id; (void)f; main_thread_only(); }
static void host_params_request_flush(const clap_host_t *h) { (void)h; }
static const clap_host_params_t g_params = { host_params_rescan, host_params_clear, host_params_request_flush };

static bool host_ports_rescan_supported(const clap_host_t *h, uint32_t f) { (void)h; (void)f; return false; }
static void host_ports_rescan(const clap_host_t *h, uint32_t f) { (void)h; (void)f; main_thread_only(); }
static const clap_host_audio_ports_t g_audio_ports = { host_ports_rescan_supported, host_ports_rescan };

static void host_state_mark_dirty(const clap_host_t *h) { (void)h; main_thread_only(); }
static const clap_host_state_t g_state = { host_state_mark_dirty };

static const void *host_get_extension(const clap_host_t *h, const char *id) {
  (void)h;
  if (!id) return NULL;
  if (!strcmp(id, CLAP_EXT_LOG)) return &g_log;
  if (!strcmp(id, CLAP_EXT_THREAD_CHECK)) return &g_thread_check;
  if (!strcmp(id, CLAP_EXT_LATENCY)) return &g_latency;
  if (!strcmp(id, CLAP_EXT_PARAMS)) return &g_params;
  if (!strcmp(id, CLAP_EXT_AUDIO_PORTS)) return &g_audio_ports;
  if (!strcmp(id, CLAP_EXT_STATE)) return &g_state;
  return NULL;
}
static void host_request(const clap_host_t *h) { (void)h; }

static const clap_host_t g_clap_host = {
  .clap_version = CLAP_VERSION_INIT,
  .host_data = NULL,
  .name = "plugin-qualify",
  .vendor = "FreeMixer",
  .url = "https://github.com/FreeMixer/plugin-qualify",
  .version = "1",
  .get_extension = host_get_extension,
  .request_restart = host_request,
  .request_process = host_request,
  .request_callback = host_request,
};

/* ---- the events a sweep block carries ---- */

static struct {
  clap_event_param_value_t ev[EVENTS_PER_BLOCK];
  uint32_t count;
} g_in;

static uint32_t in_size(const clap_input_events_t *l) { (void)l; return g_in.count; }
static const clap_event_header_t *in_get(const clap_input_events_t *l, uint32_t i) {
  (void)l;
  return i < g_in.count ? &g_in.ev[i].header : NULL;
}
static const clap_input_events_t g_in_events = { NULL, in_size, in_get };
static bool out_push(const clap_output_events_t *l, const clap_event_header_t *e) { (void)l; (void)e; return true; }
static const clap_output_events_t g_out_events = { NULL, out_push };

/* ---- one plugin ---- */

struct port_set {
  uint32_t count;
  clap_audio_buffer_t buf[MAX_PORTS];
  float **chan[MAX_PORTS];
  int main_port; /* -1 when none is main */
};

struct facts {
  int is_audio_effect;
  int headless_ok;
  uint32_t main_in, main_out, sidechains, note_inputs;
  uint32_t n_rates;
  double rates[MAX_RATES];
  uint32_t declared[MAX_RATES], measured[MAX_RATES];
  uint32_t process_calls, process_errors;
  int nonfinite;
  int interposer;
  uint32_t params;
  uint64_t allocations, locks, syscalls;
  struct omx_rt_event events[OMX_RT_EV_MAX];
  int n_events;
};

static int ports_open(const clap_plugin_t *p, const clap_plugin_audio_ports_t *ext, bool input, uint32_t frames,
                      struct port_set *ps, uint32_t *main_channels, uint32_t *others) {
  memset(ps, 0, sizeof *ps);
  ps->main_port = -1;
  *main_channels = 0;
  *others = 0;
  const uint32_t n = ext ? ext->count(p, input) : 0;
  for (uint32_t i = 0; i < n && ps->count < MAX_PORTS; i++) {
    clap_audio_port_info_t info;
    memset(&info, 0, sizeof info);
    if (!ext->get(p, i, input, &info)) continue;
    const uint32_t k = ps->count++;
    ps->chan[k] = calloc(info.channel_count ? info.channel_count : 1, sizeof(float *));
    if (!ps->chan[k]) return -1;
    for (uint32_t c = 0; c < info.channel_count; c++)
      if (!(ps->chan[k][c] = calloc(frames, sizeof(float)))) return -1;
    ps->buf[k].data32 = ps->chan[k];
    ps->buf[k].channel_count = info.channel_count;
    if ((info.flags & CLAP_AUDIO_PORT_IS_MAIN) && ps->main_port < 0) {
      ps->main_port = (int)k;
      *main_channels = info.channel_count;
    } else {
      ++*others;
    }
  }
  return 0;
}

static void ports_close(struct port_set *ps) {
  for (uint32_t k = 0; k < ps->count; k++) {
    for (uint32_t c = 0; c < ps->buf[k].channel_count; c++) free(ps->chan[k][c]);
    free(ps->chan[k]);
  }
  memset(ps, 0, sizeof *ps);
}

static void ports_fill(struct port_set *ps, uint32_t frames, float value) {
  for (uint32_t k = 0; k < ps->count; k++)
    for (uint32_t c = 0; c < ps->buf[k].channel_count; c++)
      for (uint32_t i = 0; i < frames; i++) ps->chan[k][c][i] = value;
}

static int ports_finite(const struct port_set *ps, uint32_t frames) {
  for (uint32_t k = 0; k < ps->count; k++)
    for (uint32_t c = 0; c < ps->buf[k].channel_count; c++)
      for (uint32_t i = 0; i < frames; i++)
        if (!isfinite(ps->chan[k][c][i])) return 0;
  return 1;
}

/* one process() call; the result is CLAP's */
static clap_process_status run_block(const clap_plugin_t *p, struct port_set *ins, struct port_set *outs,
                                     uint32_t frames, int64_t *steady, const struct interposer *ip) {
  clap_process_t proc = {
    .steady_time = *steady,
    .frames_count = frames,
    .transport = NULL,
    .audio_inputs = ins->buf,
    .audio_outputs = outs->buf,
    .audio_inputs_count = ins->count,
    .audio_outputs_count = outs->count,
    .in_events = &g_in_events,
    .out_events = &g_out_events,
  };
  g_host.in_process = 1;
  if (ip) ip->begin();
  const clap_process_status st = p->process(p, &proc);
  if (ip) ip->end();
  g_host.in_process = 0;
  *steady += frames;
  g_in.count = 0;
  return st;
}

struct param_row { clap_id id; double min, max; void *cookie; };

static void measure_rate(const clap_plugin_t *p, double rate, uint32_t frames, uint32_t blocks, const struct param_row *rows,
                         uint32_t n_rows, const struct interposer *ip, struct facts *f, uint32_t r) {
  const clap_plugin_audio_ports_t *ports = p->get_extension(p, CLAP_EXT_AUDIO_PORTS);
  const clap_plugin_latency_t *latency = p->get_extension(p, CLAP_EXT_LATENCY);
  struct port_set ins, outs;
  uint32_t sidechains = 0, other_outs = 0;
  if (ports_open(p, ports, true, frames, &ins, &f->main_in, &sidechains) != 0 ||
      ports_open(p, ports, false, frames, &outs, &f->main_out, &other_outs) != 0) {
    f->headless_ok = 0;
    ports_close(&ins);
    ports_close(&outs);
    return;
  }
  f->sidechains = sidechains;
  if (!p->activate(p, rate, frames, frames)) {
    f->headless_ok = 0;
    ports_close(&ins);
    ports_close(&outs);
    return;
  }
  f->declared[r] = latency ? latency->get(p) : 0;
  if (p->start_processing && !p->start_processing(p)) {
    f->headless_ok = 0;
    p->deactivate(p);
    ports_close(&ins);
    ports_close(&outs);
    return;
  }
  int64_t steady = 0;

  /* the impulse: where does it land? Scanned up to the declared figure plus a tail. */
  if (p->reset) p->reset(p);
  const uint32_t horizon = f->declared[r] + IMPULSE_TAIL;
  uint32_t seen_at = UINT32_MAX;
  for (uint32_t base = 0; base < horizon && seen_at == UINT32_MAX; base += frames) {
    ports_fill(&ins, frames, 0.0f);
    if (base == 0 && ins.main_port >= 0)
      for (uint32_t c = 0; c < ins.buf[ins.main_port].channel_count; c++) ins.chan[ins.main_port][c][0] = 1.0f;
    if (run_block(p, &ins, &outs, frames, &steady, NULL) == CLAP_PROCESS_ERROR) {
      f->process_errors++;
      break;
    }
    if (!ports_finite(&outs, frames)) {
      f->nonfinite = 1;
      break;
    }
    if (outs.main_port < 0) break;
    for (uint32_t i = 0; i < frames && seen_at == UINT32_MAX; i++)
      for (uint32_t c = 0; c < outs.buf[outs.main_port].channel_count; c++)
        if (fabsf(outs.chan[outs.main_port][c][i]) > SILENCE) {
          seen_at = base + i;
          break;
        }
  }
  f->measured[r] = seen_at == UINT32_MAX ? f->declared[r] + 1u : seen_at;

  /* the sweep: every parameter across its range through events, noise in, counted under the interposer */
  uint32_t seed = 0x6f6d78u;
  for (uint32_t b = 0; b < blocks; b++) {
    for (uint32_t k = 0; k < n_rows && g_in.count < EVENTS_PER_BLOCK; k++) {
      const double frac = (double)((b * 7u + k * 13u) % 101u) / 100.0;
      clap_event_param_value_t *e = &g_in.ev[g_in.count++];
      memset(e, 0, sizeof *e);
      e->header.size = sizeof *e;
      e->header.time = 0;
      e->header.space_id = CLAP_CORE_EVENT_SPACE_ID;
      e->header.type = CLAP_EVENT_PARAM_VALUE;
      e->param_id = rows[k].id;
      e->cookie = rows[k].cookie;
      e->note_id = -1;
      e->port_index = -1;
      e->channel = -1;
      e->key = -1;
      e->value = rows[k].min + (rows[k].max - rows[k].min) * frac;
    }
    for (uint32_t k = 0; k < ins.count; k++)
      for (uint32_t c = 0; c < ins.buf[k].channel_count; c++)
        for (uint32_t i = 0; i < frames; i++) {
          seed = seed * 1664525u + 1013904223u;
          ins.chan[k][c][i] = ((float)(seed >> 8) / 16777216.0f - 0.5f) * 0.5f;
        }
    if (run_block(p, &ins, &outs, frames, &steady, ip) == CLAP_PROCESS_ERROR) f->process_errors++;
    if (!ports_finite(&outs, frames)) f->nonfinite = 1;
    f->process_calls++;
  }
  if (p->stop_processing) p->stop_processing(p);
  p->deactivate(p);
  ports_close(&ins);
  ports_close(&outs);
}

/* ---- JSON ---- */

static int utf8_length(const unsigned char *s) {
  if (s[0] < 0x80) return 1;
  if (s[0] >= 0xC2 && s[0] <= 0xDF && (s[1] & 0xC0) == 0x80) return 2;
  if (s[0] >= 0xE0 && s[0] <= 0xEF && (s[1] & 0xC0) == 0x80 && (s[2] & 0xC0) == 0x80)
    return (s[0] == 0xE0 && s[1] < 0xA0) || (s[0] == 0xED && s[1] >= 0xA0) ? 0 : 3;
  if (s[0] >= 0xF0 && s[0] <= 0xF4 && (s[1] & 0xC0) == 0x80 && (s[2] & 0xC0) == 0x80 && (s[3] & 0xC0) == 0x80)
    return (s[0] == 0xF0 && s[1] < 0x90) || (s[0] == 0xF4 && s[1] >= 0x90) ? 0 : 4;
  return 0;
}

/* a JSON string; a byte that is no UTF-8 becomes ? */
static void put_string(const char *s) {
  const unsigned char *p = (const unsigned char *)(s ? s : "");
  putchar('"');
  while (*p) {
    const int n = utf8_length(p);
    if (n == 0) {
      putchar('?');
      p++;
    } else if (n > 1) {
      fwrite(p, 1, (size_t)n, stdout);
      p += n;
    } else {
      if (*p < 0x20 || *p == 0x7F) printf("\\u%04x", *p);
      else if (*p == '"' || *p == '\\') printf("\\%c", *p);
      else putchar(*p);
      p++;
    }
  }
  putchar('"');
}

static void put_strings(const char *const *list, size_t n) {
  putchar('[');
  for (size_t i = 0; i < n && list[i]; i++) {
    if (i) putchar(',');
    put_string(list[i]);
  }
  putchar(']');
}

static size_t count_strings(const char *const *list) {
  size_t n = 0;
  while (list && list[n]) n++;
  return n;
}

static void put_head(const char *id, const char *path, const char *sha256) {
  char *uri = NULL;
  if (asprintf(&uri, "urn:clap:%s", id) < 0) uri = NULL;
  printf("{\"uri\":");
  put_string(uri);
  free(uri);
  printf(",\"format\":\"clap\",\"id\":");
  put_string(id);
  printf(",\"binary\":{\"path\":");
  put_string(path);
  printf(",\"sha256\":");
  put_string(sha256);
  printf("},\"hostExtensions\":");
  put_strings(HOST_EXTENSIONS, HOST_EXTENSION_COUNT);
}

static void put_facts(const clap_plugin_descriptor_t *d, const struct facts *f, uint32_t frames) {
  printf(",\"clap\":{\"mainInputChannels\":%u,\"mainOutputChannels\":%u,\"sidechainInputs\":%u,\"features\":", f->main_in,
         f->main_out, f->sidechains);
  put_strings(d->features, count_strings(d->features));
  printf(",\"headlessOk\":%s,\"noteInputs\":%u,\"latency\":{", f->headless_ok ? "true" : "false", f->note_inputs);
  if (f->headless_ok)
    for (uint32_t r = 0; r < f->n_rates; r++)
      printf("%s\"%.0f\":{\"declaredFrames\":%u,\"measuredFrames\":%u}", r ? "," : "", f->rates[r], f->declared[r],
             f->measured[r]);
  printf("},\"threadViolations\":%u,\"processErrors\":%u,\"processCalls\":%u,\"nonFinite\":%s}", g_host.thread_violations,
         f->process_errors, f->process_calls, f->nonfinite ? "true" : "false");
  if (!f->interposer) {
    printf(",\"rtSafety\":{\"interposer\":false}");
    return;
  }
  printf(",\"rtSafety\":{\"interposer\":true,\"swept\":%s,\"sweepApplicable\":%s,\"blocks\":%u,\"blockFrames\":%u,"
         "\"allocationsInRun\":%llu,\"locksInRun\":%llu,\"syscallsInRun\":%llu,\"events\":[",
         f->params ? "true" : "false", f->params ? "true" : "false", f->process_calls, frames,
         (unsigned long long)f->allocations, (unsigned long long)f->locks, (unsigned long long)f->syscalls);
  for (int i = 0; i < f->n_events; i++) {
    const int k = f->events[i].kind;
    printf("%s\"%s\"", i ? "," : "", k > 0 && k < (int)(sizeof EVENT_KIND / sizeof EVENT_KIND[0]) ? EVENT_KIND[k] : "unknown");
  }
  printf("]}");
}

/* ---- the program ---- */

struct options {
  double rates[MAX_RATES];
  uint32_t n_rates;
  uint32_t frames;
  uint32_t blocks;
  const char *path;
  const char *id;
};

static int qualify_plugin(const clap_plugin_factory_t *factory, const clap_plugin_descriptor_t *d, const char *path,
                          const char *sha256, const struct options *o) {
  static struct param_row rows[MAX_PARAMS];
  struct facts f;
  memset(&f, 0, sizeof f);
  memset(&g_host, 0, sizeof g_host);
  f.n_rates = o->n_rates;
  memcpy(f.rates, o->rates, sizeof f.rates);
  for (const char *const *ft = d->features; ft && *ft; ft++)
    if (!strcmp(*ft, CLAP_PLUGIN_FEATURE_AUDIO_EFFECT)) f.is_audio_effect = 1;

  const clap_plugin_t *p = factory->create_plugin(factory, &g_clap_host, d->id);
  if (!p || !p->init(p)) {
    if (p) p->destroy(p);
    put_head(d->id, path, sha256);
    put_facts(d, &f, o->frames);
    printf("}\n");
    return 2;
  }
  f.headless_ok = 1;
  const clap_plugin_note_ports_t *notes = p->get_extension(p, CLAP_EXT_NOTE_PORTS);
  f.note_inputs = notes ? notes->count(p, true) : 0;
  const clap_plugin_params_t *params = p->get_extension(p, CLAP_EXT_PARAMS);
  uint32_t n_rows = 0;
  const uint32_t n_params = params ? params->count(p) : 0;
  for (uint32_t i = 0; i < n_params && n_rows < MAX_PARAMS; i++) {
    clap_param_info_t info;
    memset(&info, 0, sizeof info);
    if (!params->get_info(p, i, &info)) continue;
    if (info.flags & CLAP_PARAM_IS_READONLY) continue;
    if (!isfinite(info.min_value) || !isfinite(info.max_value)) continue;
    rows[n_rows++] = (struct param_row){ info.id, info.min_value, info.max_value, info.cookie };
  }
  f.params = n_rows;

  struct interposer ip;
  f.interposer = interposer_find(&ip);
  if (f.interposer) ip.reset();
  for (uint32_t r = 0; r < o->n_rates && f.headless_ok; r++)
    measure_rate(p, o->rates[r], o->frames, o->blocks, rows, n_rows, f.interposer ? &ip : NULL, &f, r);
  if (f.interposer) {
    ip.counts(&f.allocations, &f.locks, &f.syscalls);
    f.n_events = ip.events(f.events, OMX_RT_EV_MAX);
  }
  p->destroy(p);
  put_head(d->id, path, sha256);
  put_facts(d, &f, o->frames);
  printf("}\n");
  return f.headless_ok ? 0 : 2;
}

static int parse_u32(const char *s, uint32_t *out) {
  char *end;
  const unsigned long v = strtoul(s, &end, 10);
  if (!*s || *end || v == 0 || v > 1u << 20) return -1;
  *out = (uint32_t)v;
  return 0;
}

static int parse_rates(const char *s, struct options *o) {
  char *copy = strdup(s), *save = NULL;
  o->n_rates = 0;
  for (char *tok = strtok_r(copy, ",", &save); tok; tok = strtok_r(NULL, ",", &save)) {
    uint32_t v;
    if (o->n_rates == MAX_RATES || parse_u32(tok, &v) != 0) {
      free(copy);
      return -1;
    }
    o->rates[o->n_rates++] = v;
  }
  free(copy);
  return o->n_rates ? 0 : -1;
}

static int usage(const char *name) {
  fprintf(stderr, "usage: %s --rates <r,...> [--block <frames>] [--blocks <n>] <path.clap> [<id>]\n", name);
  return 2;
}

int main(int argc, char **argv) {
  struct options o = { .n_rates = 0, .frames = 512, .blocks = 512 };
  int a = 1;
  for (; a < argc && argv[a][0] == '-'; a += 2) {
    if (a + 1 >= argc) return usage(argv[0]);
    if (!strcmp(argv[a], "--rates")) {
      if (parse_rates(argv[a + 1], &o) != 0) return usage(argv[0]);
    } else if (!strcmp(argv[a], "--block")) {
      if (parse_u32(argv[a + 1], &o.frames) != 0) return usage(argv[0]);
    } else if (!strcmp(argv[a], "--blocks")) {
      if (parse_u32(argv[a + 1], &o.blocks) != 0) return usage(argv[0]);
    } else {
      return usage(argv[0]);
    }
  }
  if (o.n_rates == 0 || a >= argc || argc - a > 2) return usage(argv[0]);
  o.id = a + 1 < argc ? argv[a + 1] : NULL;

  char path[PATH_MAX];
  if (!realpath(argv[a], path)) {
    fprintf(stderr, "%s: %s: no such file\n", argv[0], argv[a]);
    return 2;
  }
  char sha256[PHD_SHA256_HEX_LEN + 1];
  const int fd = open(path, O_RDONLY | O_CLOEXEC);
  const int hashed = fd >= 0 && phd_pin_fd_digest(fd, sha256) == 0;
  if (fd >= 0) close(fd);
  if (!hashed) {
    fprintf(stderr, "%s: %s: cannot be read\n", argv[0], path);
    return 2;
  }

  void *so = dlopen(path, RTLD_NOW | RTLD_LOCAL);
  if (!so) {
    fprintf(stderr, "%s: %s\n", argv[0], dlerror());
    return 2;
  }
  const clap_plugin_entry_t *entry = dlsym(so, "clap_entry");
  if (!entry || !clap_version_is_compatible(entry->clap_version) || !entry->init(path)) {
    fprintf(stderr, "%s: %s: no usable clap_entry\n", argv[0], path);
    dlclose(so);
    return 2;
  }
  const clap_plugin_factory_t *factory = entry->get_factory(CLAP_PLUGIN_FACTORY_ID);
  int status = 0, found = 0;
  const uint32_t n = factory ? factory->get_plugin_count(factory) : 0;
  for (uint32_t i = 0; i < n; i++) {
    const clap_plugin_descriptor_t *d = factory->get_plugin_descriptor(factory, i);
    if (!d || !d->id || (o.id && strcmp(o.id, d->id))) continue;
    found = 1;
    fflush(stdout);
    if (qualify_plugin(factory, d, path, sha256, &o) != 0) status = 2;
    fflush(stdout);
  }
  entry->deinit();
  dlclose(so);
  if (!found) {
    fprintf(stderr, "%s: %s holds no plugin%s%s\n", argv[0], path, o.id ? " " : "", o.id ? o.id : "");
    return 2;
  }
  return status;
}
