// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * clap-qualify — the CLAP prober of plugin-qualify: it loads a `.clap`, runs each of its plugins
 * headless at every rate it is given and prints, per plugin, one JSON line of what it MEASURED.
 * It judges nothing: the verdict is plugin-qualify's (`src/clap-qualify.ts`), read from these facts.
 *
 *   clap-qualify --rates <r,...> [--block <frames>] [--blocks <n>] [--offer <ext,...>]
 *                [--probe-notes <n>] [--hold <n>] <path.clap> [<id>]
 *   clap-qualify --json <path>...      the scan (below), the document the CLAP loader reads
 *
 * Per rate the plugin is activated, its latency read, an impulse run through `process()` to see
 * where it lands, and then every parameter is swept across its range through events while noise
 * plays in. Under LD_PRELOAD=rt_interpose.so the interposer counts the allocations, locks and
 * syscalls made inside each `process()` of the sweep; without it the line says so and counts
 * nothing. The file's SHA-256 is printed beside the facts, so a verdict is bound to the bytes it
 * was measured on.
 *
 * A plugin with a note input is then played, at every rate, under a count of its own (the note
 * sweep): a chord, the pitch bent and a controller moved across a block, pressure, the chord let
 * go, a burst of note ons in one block and their offs, all notes off, in the dialect its note
 * port reads. An instrument is quiet and cheap until a voice plays, so what a note on does inside
 * `process()` is only seen here.
 *
 * Then the cost (the cost arm): at every rate the plugin is run again with every parameter swept,
 * the sweep's noise on every audio input, and each `process()` is timed. An instrument (a note
 * input, and no main audio input or the instrument feature) also holds notes down, at velocity
 * 127, spread across the keyboard, for the whole run: as many as the voice capacity it declares
 * through `voice-info` after `activate` at that rate (basis `declared`), or, when it declares
 * none, the count `--probe-notes` gives (basis `probe`).
 * `--hold` holds that count whatever the plugin declares (basis `probe`). An instrument with no
 * count to hold, or one declaring a capacity of 0, is not timed and the line says why. The figure
 * is nanoseconds per sample, a warm-up head dropped, its median and 95th percentile; the run is
 * not under the interposer's count.
 *
 * The host offers exactly the extensions in HOST_EXTENSIONS — omx-clap-core's own host object,
 * `clap_host_extensions.h` — and nothing else, so a plugin that needs more fails headless here
 * rather than on the desk; `--offer` adds those of OFFERABLE a host such as omx-clap-host offers
 * too (their host functions answer nothing). A plugin calling a main-thread host function from
 * inside `process()` is a thread violation. The eleven beyond the original six are headless the
 * way the library's host object is: timer-support and posix-fd-support register and unregister
 * but never fire (no event loop runs here), thread-pool runs every task on the calling thread
 * inside `process()` exactly as the library does, tail and the three `changed` notifications
 * (note-name, voice-info, and the surround/ambisonic layout, which also answers its draft id) take
 * the call and nothing more, event-registry answers false (no event space beyond the core one),
 * and note-ports answers every dialect the prober itself speaks.
 *
 * Exit status: 0 every plugin was measured, 2 usage, or the file or the plugin could not be loaded
 * (the line still prints with what was read).
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <signal.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <malloc.h>
#include <time.h>
#include <unistd.h>

#include <clap/clap.h>
#include <plugin-hostd/pin.h>
#include <plugin-hostd/protocol.h>

#include "rt-interpose.h"

#define MAX_RATES 16
#define MAX_PORTS 16
#define MAX_PARAMS 4096
/* omx-clap-core's CLAP_HOST_PARAM_COUNT_MAX: the host refuses at `add` a plugin with more parameters,
 * so the prober pins none (plugin-hostd's layout_pin_write returns -1 above it) */
#define HOST_PARAM_COUNT_MAX 2048
_Static_assert(HOST_PARAM_COUNT_MAX <= MAX_PARAMS, "the prober reads every parameter the host accepts");
#define STR_(x) #x
#define STR(x) STR_(x)
/* parameter events one sweep block carries */
#define EVENTS_PER_BLOCK 64u
/* notes the cost arm can hold: one per MIDI key */
#define NOTE_KEYS_MAX 128
/* the events one block can carry: every held note's note on beside a sweep block's parameters */
#define EVENTS_MAX (NOTE_KEYS_MAX + EVENTS_PER_BLOCK)
/* the cost arm: blocks timed and dropped before the figure is taken, and its high percentile */
#define COST_WARMUP_BLOCKS 64u
#define COST_PERCENTILE 95.0
/* the keyboard the held notes are spread across: a piano's keys, or every MIDI key past 88 notes */
#define PIANO_LOW_KEY 21
#define PIANO_HIGH_KEY 108
#define PIANO_KEYS 88u
#define HELD_VELOCITY 1.0
/* frames past the declared latency the impulse is looked for */
#define IMPULSE_TAIL 8192u
#define SILENCE 1e-6f
/* the impulse's arrival is the first frame at or above this fraction of the response's own peak
 * magnitude: an absolute floor as low as SILENCE reads the leakage a fractional-delay read puts one
 * frame ahead of the main arrival (omx-pitch at 44.1 kHz: -2.1e-5 at 882, 1.03 at 883) as the onset,
 * and refuses a plugin that declares its true delay by one frame. -60 dB below the
 * peak sits far above that leakage and far below any arrival a plugin means. */
#define ONSET_OF_PEAK 1e-3f

/* what the host offers, in the order omx-clap-core's clap_host_extensions.h lists it */
static const char *const HOST_EXTENSIONS[] = {
  CLAP_EXT_LOG, CLAP_EXT_THREAD_CHECK, CLAP_EXT_LATENCY, CLAP_EXT_PARAMS, CLAP_EXT_AUDIO_PORTS, CLAP_EXT_STATE,
  CLAP_EXT_NOTE_PORTS, CLAP_EXT_NOTE_NAME, CLAP_EXT_VOICE_INFO, CLAP_EXT_EVENT_REGISTRY,
  CLAP_EXT_TIMER_SUPPORT, CLAP_EXT_POSIX_FD_SUPPORT, CLAP_EXT_THREAD_POOL, CLAP_EXT_TAIL,
  CLAP_EXT_SURROUND, CLAP_EXT_AMBISONIC, CLAP_EXT_AUDIO_PORTS_CONFIG,
};
#define HOST_EXTENSION_COUNT (sizeof HOST_EXTENSIONS / sizeof HOST_EXTENSIONS[0])

/* every dialect a note the sweep can speak, for clap.note-ports' supported_dialects: the host offers all four, as
 * omx-clap-core's own host object does with note inputs configured (OMX_CLAP_HOST_NOTE_DIALECTS) */
#define HOST_NOTE_DIALECTS (CLAP_NOTE_DIALECT_CLAP | CLAP_NOTE_DIALECT_MIDI | CLAP_NOTE_DIALECT_MIDI_MPE | CLAP_NOTE_DIALECT_MIDI2)

/* timer-support and posix-fd-support: registrations the prober accepts and never fires, since no event loop runs
 * here; bounded the way the library's are (OMX_CLAP_TIMERS, OMX_CLAP_FDS), reset with g_host each plugin */
#define HOST_TIMERS 16
#define HOST_FDS 16

/* what --offer may add, each by its id and the draft id a plugin may still ask for, in the order the document lists them */
static const struct { const char *id, *compat; } OFFERABLE[] = {
  { CLAP_EXT_PRESET_LOAD, CLAP_EXT_PRESET_LOAD_COMPAT },
  { CLAP_EXT_TRACK_INFO, CLAP_EXT_TRACK_INFO_COMPAT },
  { CLAP_EXT_REMOTE_CONTROLS, CLAP_EXT_REMOTE_CONTROLS_COMPAT },
};
#define OFFERABLE_COUNT (sizeof OFFERABLE / sizeof OFFERABLE[0])
static int g_offered[OFFERABLE_COUNT];

/* the note sweep: a cycle of NOTE_CYCLE blocks (see note_block), a burst of NOTE_BURST note ons in one block */
#define NOTE_CYCLE 8u
#define NOTE_BURST 32u
/* the chord the sweep holds, and the bend's reach in semitones (MIDI's default range) */
static const int16_t CHORD[] = { 60, 64, 67 };
#define CHORD_SIZE (sizeof CHORD / sizeof CHORD[0])
#define BEND_SEMITONES 2.0

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
  const clap_plugin_t *plugin;
  const clap_plugin_thread_pool_t *plugin_thread_pool;
  int in_exec;
  struct { int used; clap_id id; } timers[HOST_TIMERS];
  clap_id timer_next_id;
  struct { int used, fd; clap_posix_fd_flags_t flags; } fds[HOST_FDS];
} g_host;

static void main_thread_only(void) {
  if (g_host.in_process) g_host.thread_violations++;
}

/* true on the main thread (and counts the violation otherwise): the gate register/unregister and the fd calls take,
 * since a call off it must refuse rather than merely be noted */
static int on_main_thread(void) {
  if (g_host.in_process) {
    g_host.thread_violations++;
    return 0;
  }
  return 1;
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

/* clap.note-ports: the host supports every dialect the note sweep speaks; a rescan is taken and nothing more, since
 * the prober reads a plugin's note ports once, at open */
static uint32_t host_note_ports_supported_dialects(const clap_host_t *h) { (void)h; return HOST_NOTE_DIALECTS; }
static void host_note_ports_rescan(const clap_host_t *h, uint32_t f) { (void)h; (void)f; main_thread_only(); }
static const clap_host_note_ports_t g_note_ports = { host_note_ports_supported_dialects, host_note_ports_rescan };

static void host_note_name_changed(const clap_host_t *h) { (void)h; main_thread_only(); }
static const clap_host_note_name_t g_note_name = { host_note_name_changed };

static void host_voice_info_changed(const clap_host_t *h) { (void)h; main_thread_only(); }
static const clap_host_voice_info_t g_voice_info = { host_voice_info_changed };

/* the prober reads no event space but the core one, so every query answers false, as the library's does */
static bool host_event_registry_query(const clap_host_t *h, const char *space_name, uint16_t *space_id) {
  (void)h;
  (void)space_name;
  if (space_id) *space_id = UINT16_MAX;
  main_thread_only();
  return false;
}
static const clap_host_event_registry_t g_event_registry = { host_event_registry_query };

/* timer-support and posix-fd-support: a registration the prober accepts, headless — no tick ever calls on_timer or
 * on_fd back, since no event loop runs here */
static bool host_register_timer(const clap_host_t *h, uint32_t period_ms, clap_id *timer_id) {
  (void)h;
  (void)period_ms;
  if (!on_main_thread() || !timer_id) return false;
  for (uint32_t i = 0; i < HOST_TIMERS; i++)
    if (!g_host.timers[i].used) {
      g_host.timers[i].used = 1;
      g_host.timers[i].id = g_host.timer_next_id++;
      *timer_id = g_host.timers[i].id;
      return true;
    }
  return false;
}
static bool host_unregister_timer(const clap_host_t *h, clap_id timer_id) {
  (void)h;
  if (!on_main_thread()) return false;
  for (uint32_t i = 0; i < HOST_TIMERS; i++)
    if (g_host.timers[i].used && g_host.timers[i].id == timer_id) {
      g_host.timers[i].used = 0;
      return true;
    }
  return false;
}
static const clap_host_timer_support_t g_timer_support = { host_register_timer, host_unregister_timer };

static int host_fd_slot(int fd) {
  for (uint32_t i = 0; i < HOST_FDS; i++)
    if (g_host.fds[i].used && g_host.fds[i].fd == fd) return (int)i;
  return -1;
}
static bool host_register_fd(const clap_host_t *h, int fd, clap_posix_fd_flags_t flags) {
  (void)h;
  if (!on_main_thread() || fd < 0 || host_fd_slot(fd) >= 0) return false;
  for (uint32_t i = 0; i < HOST_FDS; i++)
    if (!g_host.fds[i].used) {
      g_host.fds[i].used = 1;
      g_host.fds[i].fd = fd;
      g_host.fds[i].flags = flags;
      return true;
    }
  return false;
}
static bool host_modify_fd(const clap_host_t *h, int fd, clap_posix_fd_flags_t flags) {
  (void)h;
  const int i = fd < 0 ? -1 : host_fd_slot(fd);
  if (!on_main_thread() || i < 0) return false;
  g_host.fds[i].flags = flags;
  return true;
}
static bool host_unregister_fd(const clap_host_t *h, int fd) {
  (void)h;
  const int i = fd < 0 ? -1 : host_fd_slot(fd);
  if (!on_main_thread() || i < 0) return false;
  g_host.fds[i].used = 0;
  return true;
}
static const clap_host_posix_fd_support_t g_posix_fd_support = { host_register_fd, host_modify_fd, host_unregister_fd };

/* thread-pool: [audio-thread], so gated on the process() window rather than on_main_thread; every task runs before
 * the call returns, one after another on the calling thread, exactly as omx-clap-core's own host object runs them */
static bool host_request_exec(const clap_host_t *h, uint32_t num_tasks) {
  (void)h;
  if (!g_host.in_process || !g_host.plugin_thread_pool || !g_host.plugin_thread_pool->exec || g_host.in_exec) return false;
  g_host.in_exec = 1;
  for (uint32_t i = 0; i < num_tasks; i++) g_host.plugin_thread_pool->exec(g_host.plugin, i);
  g_host.in_exec = 0;
  return true;
}
static const clap_host_thread_pool_t g_thread_pool = { host_request_exec };

/* tail: [audio-thread], no thread-check — the prober reads no tail figure back, the call is taken and nothing more */
static void host_tail_changed(const clap_host_t *h) { (void)h; }
static const clap_host_tail_t g_tail = { host_tail_changed };

/* surround and ambisonic: a layout changed notification taken and nothing more, since the prober describes a
 * plugin's ports once, at open */
static void host_layout_changed(const clap_host_t *h) { (void)h; main_thread_only(); }
static const clap_host_surround_t g_surround = { host_layout_changed };
static const clap_host_ambisonic_t g_ambisonic = { host_layout_changed };

static void host_configs_rescan(const clap_host_t *h) { (void)h; main_thread_only(); }
static const clap_host_audio_ports_config_t g_audio_ports_config = { host_configs_rescan };

/* the offerable extensions: main-thread host functions that answer nothing */
static void host_preset_error(const clap_host_t *h, uint32_t kind, const char *location, const char *key, int32_t error,
                              const char *msg) {
  (void)h; (void)kind; (void)location; (void)key; (void)error; (void)msg;
  main_thread_only();
}
static void host_preset_loaded(const clap_host_t *h, uint32_t kind, const char *location, const char *key) {
  (void)h; (void)kind; (void)location; (void)key;
  main_thread_only();
}
static const clap_host_preset_load_t g_preset_load = { host_preset_error, host_preset_loaded };

static bool host_track_info_get(const clap_host_t *h, clap_track_info_t *info) { (void)h; (void)info; main_thread_only(); return false; }
static const clap_host_track_info_t g_track_info = { host_track_info_get };

static void host_remote_changed(const clap_host_t *h) { (void)h; main_thread_only(); }
static void host_remote_suggest(const clap_host_t *h, clap_id page) { (void)h; (void)page; main_thread_only(); }
static const clap_host_remote_controls_t g_remote_controls = { host_remote_changed, host_remote_suggest };

static const void *const OFFERED_OBJECT[OFFERABLE_COUNT] = { &g_preset_load, &g_track_info, &g_remote_controls };

static const void *host_get_extension(const clap_host_t *h, const char *id) {
  (void)h;
  if (!id) return NULL;
  if (!strcmp(id, CLAP_EXT_LOG)) return &g_log;
  if (!strcmp(id, CLAP_EXT_THREAD_CHECK)) return &g_thread_check;
  if (!strcmp(id, CLAP_EXT_LATENCY)) return &g_latency;
  if (!strcmp(id, CLAP_EXT_PARAMS)) return &g_params;
  if (!strcmp(id, CLAP_EXT_AUDIO_PORTS)) return &g_audio_ports;
  if (!strcmp(id, CLAP_EXT_STATE)) return &g_state;
  if (!strcmp(id, CLAP_EXT_NOTE_PORTS)) return &g_note_ports;
  if (!strcmp(id, CLAP_EXT_NOTE_NAME)) return &g_note_name;
  if (!strcmp(id, CLAP_EXT_VOICE_INFO)) return &g_voice_info;
  if (!strcmp(id, CLAP_EXT_EVENT_REGISTRY)) return &g_event_registry;
  if (!strcmp(id, CLAP_EXT_TIMER_SUPPORT)) return &g_timer_support;
  if (!strcmp(id, CLAP_EXT_POSIX_FD_SUPPORT)) return &g_posix_fd_support;
  if (!strcmp(id, CLAP_EXT_THREAD_POOL)) return &g_thread_pool;
  if (!strcmp(id, CLAP_EXT_TAIL)) return &g_tail;
  /* the draft ids of the two layout extensions, answered as their own; the declared list names the final ids only,
   * as omx-clap-core's own host object does */
  if (!strcmp(id, CLAP_EXT_SURROUND) || !strcmp(id, CLAP_EXT_SURROUND_COMPAT)) return &g_surround;
  if (!strcmp(id, CLAP_EXT_AMBISONIC) || !strcmp(id, CLAP_EXT_AMBISONIC_COMPAT)) return &g_ambisonic;
  if (!strcmp(id, CLAP_EXT_AUDIO_PORTS_CONFIG)) return &g_audio_ports_config;
  for (size_t k = 0; k < OFFERABLE_COUNT; k++)
    if (g_offered[k] && (!strcmp(id, OFFERABLE[k].id) || !strcmp(id, OFFERABLE[k].compat))) return OFFERED_OBJECT[k];
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

union any_event {
  clap_event_header_t header;
  clap_event_param_value_t param;
  clap_event_note_t note;
  clap_event_note_expression_t expression;
  clap_event_midi_t midi;
};

static struct {
  union any_event ev[EVENTS_MAX];
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

#include "rss-kb.h"
#include "timing-sched.h"

/* how the cost arm chose how many notes to hold */
enum voice_basis { BASIS_NONE, BASIS_DECLARED, BASIS_PROBE };

/* one rate of the cost arm: the figures, or why there are none */
struct cost_at {
  const char *unmeasured; /* NULL when measured */
  const char *detail;
  double median, p95, min, max, warmup_median;
  uint32_t blocks;
  /* the notes held (0 for an effect), why that many, and the capacity voice-info declared */
  uint32_t held;
  enum voice_basis basis;
  int has_capacity;
  uint32_t capacity;
  struct timing_sched sched; /* read on the timing thread, as the blocks were timed */
};

/* one rate of the footprint: what the resident set grew by at each step of one instance's life, in KB, and a second
 * instance's own part. `got` marks each figure taken; `unmeasured` says why one that should be there is not. */
enum { FP_INSTANTIATE = 1, FP_ACTIVATE = 2, FP_REST = 4, FP_NOTES = 8, FP_SECOND = 16 };
struct footprint {
  unsigned got;
  long instantiate, activate, rest, notes, second;
  enum voice_basis basis;
  char unmeasured[32];
  char detail[96];
};

struct facts {
  int is_audio_effect;
  int headless_ok;
  uint32_t main_in, main_out, sidechains, note_inputs;
  uint32_t n_rates;
  double rates[MAX_RATES];
  uint32_t declared[MAX_RATES], measured[MAX_RATES];
  /* the latency of a plugin with no main audio input, taken from a note: the dialect to play it in (0 CLAP's, 1
   * MIDI's, -1 no note to play), and per rate whether anything was heard */
  int latency_note;
  int heard[MAX_RATES];
  uint32_t process_calls, process_errors;
  int nonfinite;
  int interposer;
  uint32_t params;
  uint64_t allocations, locks, syscalls;
  struct omx_rt_event events[OMX_RT_EV_MAX];
  int n_events;
  /* the note sweep: the dialect it spoke (NULL: no note input, or none it speaks), and what it counted */
  const char *note_dialect;
  uint32_t note_calls, note_events, note_errors;
  int note_nonfinite;
  uint64_t note_allocations, note_locks, note_syscalls;
  struct omx_rt_event note_rt_events[OMX_RT_EV_MAX];
  int n_note_rt_events;
  /* the cost arm, per rate; `cost_notes` is whether it played notes (an instrument) or noise */
  int cost_notes;
  struct cost_at cost[MAX_RATES];
  struct footprint footprint[MAX_RATES];
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

struct param_row { clap_id id; double min, max; void *cookie; int stepped; };

/* where a sweep puts a parameter at `frac` of its range: a stepped one (an enum, a switch) on a whole value, as a
 * host sends it, never between two steps */
static double sweep_value(const struct param_row *row, double frac) {
  const double v = row->min + (row->max - row->min) * frac;
  return row->stepped ? floor(v + 0.5) : v;
}

struct options {
  double rates[MAX_RATES];
  uint32_t n_rates;
  uint32_t frames;
  uint32_t blocks;
  /* the notes the cost arm holds for an instrument that declares no voice capacity (--probe-notes), and
   * the count it holds whatever the plugin declares (--hold); 0 when not given */
  uint32_t probe_notes, hold;
  const char *path; /* as invoked, before realpath: the name the pin holds */
  const char *id;
};

static void note_key(int clap_dialect, uint32_t time, int on, int16_t key, double velocity);

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

  /* the impulse: where does it land? The whole response up to the declared figure plus a tail is
   * kept as its per-frame magnitude (the loudest main-out channel), and the arrival is read against
   * its own peak (ONSET_OF_PEAK); a response that never leaves SILENCE has not arrived. A plugin with
   * no main audio input has nowhere to put an impulse: an instrument is played a note instead, A4 at
   * velocity 127 at frame 0, let go at the end, and its onset is read the same way. */
  if (p->reset) p->reset(p);
  const int by_note = ins.main_port < 0 && f->latency_note >= 0;
  const uint32_t horizon = f->declared[r] + IMPULSE_TAIL;
  const uint32_t span = (horizon + frames - 1u) / frames * frames;
  float *mag = calloc(span, sizeof *mag);
  uint32_t seen_at = UINT32_MAX;
  for (uint32_t base = 0; mag && base < horizon; base += frames) {
    ports_fill(&ins, frames, 0.0f);
    if (base == 0 && ins.main_port >= 0)
      for (uint32_t c = 0; c < ins.buf[ins.main_port].channel_count; c++) ins.chan[ins.main_port][c][0] = 1.0f;
    if (by_note && base == 0) note_key(f->latency_note == 0, 0, 1, 69, 1.0);
    if (by_note && base + frames >= horizon) note_key(f->latency_note == 0, 0, 0, 69, 0.0);
    if (run_block(p, &ins, &outs, frames, &steady, NULL) == CLAP_PROCESS_ERROR) {
      f->process_errors++;
      break;
    }
    if (!ports_finite(&outs, frames)) {
      f->nonfinite = 1;
      break;
    }
    if (outs.main_port < 0) break;
    for (uint32_t i = 0; i < frames; i++)
      for (uint32_t c = 0; c < outs.buf[outs.main_port].channel_count; c++) {
        const float m = fabsf(outs.chan[outs.main_port][c][i]);
        if (m > mag[base + i]) mag[base + i] = m;
      }
  }
  if (mag) {
    float peak = 0.0f;
    for (uint32_t i = 0; i < horizon; i++)
      if (mag[i] > peak) peak = mag[i];
    const float floor = peak * ONSET_OF_PEAK > SILENCE ? peak * ONSET_OF_PEAK : SILENCE;
    for (uint32_t i = 0; i < horizon && peak > SILENCE; i++)
      if (mag[i] >= floor) {
        seen_at = i;
        break;
      }
    free(mag);
  }
  f->measured[r] = seen_at == UINT32_MAX ? f->declared[r] + 1u : seen_at;
  f->heard[r] = seen_at != UINT32_MAX;
  /* the note's voice, and its release, never reach the sweep */
  if (by_note && p->reset) p->reset(p);

  /* the sweep: every parameter across its range through events, noise in, counted under the interposer */
  uint32_t seed = 0x6f6d78u;
  for (uint32_t b = 0; b < blocks; b++) {
    for (uint32_t k = 0; k < n_rows && g_in.count < EVENTS_PER_BLOCK; k++) {
      const double frac = (double)((b * 7u + k * 13u) % 101u) / 100.0;
      clap_event_param_value_t *e = &g_in.ev[g_in.count++].param;
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
      e->value = sweep_value(&rows[k], frac);
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

/* ---- the note sweep ---- */

/* one event of a note block, at frame `time`; the caller keeps the block's events in time order */
static union any_event *note_event(uint32_t time, uint16_t type, uint32_t size) {
  if (g_in.count >= EVENTS_MAX) return NULL;
  union any_event *e = &g_in.ev[g_in.count++];
  memset(e, 0, sizeof *e);
  e->header.size = size;
  e->header.time = time;
  e->header.space_id = CLAP_CORE_EVENT_SPACE_ID;
  e->header.type = type;
  return e;
}

static void note_midi(uint32_t time, uint8_t status, uint8_t a, uint8_t b) {
  union any_event *e = note_event(time, CLAP_EVENT_MIDI, sizeof(clap_event_midi_t));
  if (!e) return;
  e->midi.port_index = 0;
  e->midi.data[0] = status;
  e->midi.data[1] = a;
  e->midi.data[2] = b;
}

/* a note on (velocity above 0) or off, key -1 for every key, in the dialect. Always on channel 0: every key of
 * channel 0 is what the host sends for all notes off (omx-clap-core maps controller 123 to a note off with key -1
 * on the controller's channel), never the channel wildcard, which a plugin indexing a 16-channel table reads out of
 * bounds (Six Sines 1.2.1). */
static void note_key(int clap_dialect, uint32_t time, int on, int16_t key, double velocity) {
  if (clap_dialect) {
    union any_event *e = note_event(time, on ? CLAP_EVENT_NOTE_ON : CLAP_EVENT_NOTE_OFF, sizeof(clap_event_note_t));
    if (!e) return;
    e->note.note_id = -1;
    e->note.port_index = 0;
    e->note.channel = 0;
    e->note.key = key;
    e->note.velocity = velocity;
  } else if (key < 0) {
    note_midi(time, 0xB0, 123, 0);
  } else {
    note_midi(time, on ? 0x90 : 0x80, (uint8_t)key, (uint8_t)(velocity * 127.0 + 0.5));
  }
}

/* a channel-wide expression: the pitch bent by `amount` of its reach (-1 to 1), or pressure (0 to 1) */
static void note_expression(int clap_dialect, uint32_t time, int bend, double amount) {
  if (clap_dialect) {
    union any_event *e = note_event(time, CLAP_EVENT_NOTE_EXPRESSION, sizeof(clap_event_note_expression_t));
    if (!e) return;
    e->expression.expression_id = bend ? CLAP_NOTE_EXPRESSION_TUNING : CLAP_NOTE_EXPRESSION_PRESSURE;
    e->expression.note_id = -1;
    e->expression.port_index = 0;
    e->expression.channel = 0;
    e->expression.key = -1;
    e->expression.value = bend ? amount * BEND_SEMITONES : amount;
  } else if (bend) {
    const unsigned v = (unsigned)((amount + 1.0) * 8191.5);
    note_midi(time, 0xE0, (uint8_t)(v & 0x7f), (uint8_t)(v >> 7 & 0x7f));
  } else {
    note_midi(time, 0xD0, (uint8_t)(amount * 127.0 + 0.5), 0);
  }
}

/* the events of block b of the note sweep, by b's place in the cycle; a controller only where the port reads MIDI */
static void note_block(uint32_t b, uint32_t frames, int clap_dialect, int midi_too) {
  const uint32_t step = frames / 8u ? frames / 8u : 1u;
  switch (b % NOTE_CYCLE) {
  case 0:
    for (uint32_t k = 0; k < CHORD_SIZE; k++) note_key(clap_dialect, 0, 1, CHORD[k], 0.8);
    break;
  case 1:
    for (uint32_t t = 0; t < 8u; t++) {
      note_expression(clap_dialect, t * step, 1, (double)t / 4.0 - 1.0);
      if (!clap_dialect || midi_too) note_midi(t * step, 0xB0, 1, (uint8_t)(t * 16u));
    }
    break;
  case 2:
    for (uint32_t t = 0; t < 8u; t++) note_expression(clap_dialect, t * step, 0, (double)t / 7.0);
    break;
  case 3:
    for (uint32_t k = 0; k < CHORD_SIZE; k++) note_key(clap_dialect, 0, 0, CHORD[k], 0.0);
    break;
  case 4:
  case 5:
    for (uint32_t k = 0; k < NOTE_BURST; k++)
      note_key(clap_dialect, k * frames / NOTE_BURST, b % NOTE_CYCLE == 4, (int16_t)(36 + k), 0.25 + 0.5 * (double)k / NOTE_BURST);
    break;
  case 6:
    note_key(clap_dialect, 0, 1, 72, 1.0);
    /* all notes off as the host sends it (omx-clap-core's note input): to a port that reads MIDI too, controller
     * 123 as it came; to one reading CLAP's dialect alone, a note off on every key of the channel */
    if (clap_dialect && midi_too) note_midi(frames / 2u, 0xB0, 123, 0);
    else note_key(clap_dialect, frames / 2u, 0, -1, 0.0);
    break;
  default:
    break; /* the release tails */
  }
}

/* the dialect the note sweep speaks to the plugin's first note input: CLAP's when it reads it, else MIDI's; NULL for none */
static const char *note_dialect(const clap_plugin_t *p, int *clap_dialect, int *midi_too) {
  const clap_plugin_note_ports_t *notes = p->get_extension(p, CLAP_EXT_NOTE_PORTS);
  clap_note_port_info_t info;
  memset(&info, 0, sizeof info);
  if (!notes || notes->count(p, true) == 0 || !notes->get(p, 0, true, &info)) return NULL;
  *midi_too = (info.supported_dialects & CLAP_NOTE_DIALECT_MIDI) != 0;
  if (info.supported_dialects & CLAP_NOTE_DIALECT_CLAP) return *clap_dialect = 1, "clap";
  if (*midi_too) return *clap_dialect = 0, "midi";
  return NULL;
}

static void note_sweep_rate(const clap_plugin_t *p, double rate, uint32_t frames, uint32_t blocks, int clap_dialect, int midi_too,
                            const struct interposer *ip, struct facts *f) {
  const clap_plugin_audio_ports_t *ports = p->get_extension(p, CLAP_EXT_AUDIO_PORTS);
  struct port_set ins, outs;
  uint32_t main_in, main_out, others;
  if (ports_open(p, ports, true, frames, &ins, &main_in, &others) != 0 || ports_open(p, ports, false, frames, &outs, &main_out, &others) != 0 ||
      !p->activate(p, rate, frames, frames)) {
    f->headless_ok = 0;
    ports_close(&ins);
    ports_close(&outs);
    return;
  }
  if (p->start_processing && !p->start_processing(p)) {
    f->headless_ok = 0;
    p->deactivate(p);
    ports_close(&ins);
    ports_close(&outs);
    return;
  }
  if (p->reset) p->reset(p);
  int64_t steady = 0;
  ports_fill(&ins, frames, 0.0f);
  for (uint32_t b = 0; b < blocks; b++) {
    note_block(b, frames, clap_dialect, midi_too);
    f->note_events += g_in.count;
    if (run_block(p, &ins, &outs, frames, &steady, ip) == CLAP_PROCESS_ERROR) f->note_errors++;
    if (!ports_finite(&outs, frames)) f->note_nonfinite = 1;
    f->note_calls++;
  }
  if (p->stop_processing) p->stop_processing(p);
  p->deactivate(p);
  ports_close(&ins);
  ports_close(&outs);
}

/* ---- the cost arm ---- */

/* the voice capacity voice-info declares now (after activate), or 0 in *has when the plugin has no voice-info */
static uint32_t voice_capacity(const clap_plugin_t *p, int *has) {
  const clap_plugin_voice_info_t *vi = p->get_extension(p, CLAP_EXT_VOICE_INFO);
  clap_voice_info_t info;
  memset(&info, 0, sizeof info);
  *has = vi && vi->get && vi->get(p, &info);
  return *has ? info.voice_capacity : 0;
}

/* the i-th of n held keys, spread evenly across a piano's keys (every MIDI key past 88 notes); one note is A4 */
static int16_t held_key(uint32_t i, uint32_t n) {
  if (n <= 1) return 69;
  const uint32_t low = n <= PIANO_KEYS ? PIANO_LOW_KEY : 0, high = n <= PIANO_KEYS ? PIANO_HIGH_KEY : NOTE_KEYS_MAX - 1;
  return (int16_t)(low + i * (high - low) / (n - 1));
}

static int by_value(const void *a, const void *b) {
  const double x = *(const double *)a, y = *(const double *)b;
  return x < y ? -1 : x > y;
}

/* the linear-interpolated percentile of n sorted values (numpy's default, benchmark.py's `percentile`) */
static double percentile_sorted(const double *v, uint32_t n, double pct) {
  if (n == 1) return v[0];
  const double pos = (double)(n - 1) * pct / 100.0;
  const uint32_t low = (uint32_t)pos, high = low + 1 < n ? low + 1 : n - 1;
  return v[low] + (v[high] - v[low]) * (pos - (double)low);
}

static int64_t now_ns(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC_RAW, &t);
  return (int64_t)t.tv_sec * 1000000000 + t.tv_nsec;
}

/*
 * One rate of the cost arm. Every parameter is moved across its range through events, a block's worth
 * at a time, as the RT sweep moves them, and every audio input hears the sweep's noise; an instrument
 * also holds its notes, all struck in the first block and never let go. Each process() is timed alone;
 * the warm-up head is dropped and the rest folded into nanoseconds per sample.
 */
static void cost_rate(const clap_plugin_t *p, double rate, uint32_t frames, uint32_t blocks, const struct param_row *rows,
                      uint32_t n_rows, int clap_dialect, const struct options *o, struct facts *f, uint32_t r) {
  struct cost_at *c = &f->cost[r];
  const clap_plugin_audio_ports_t *ports = p->get_extension(p, CLAP_EXT_AUDIO_PORTS);
  struct port_set ins, outs;
  uint32_t main_in, main_out, others;
  if (ports_open(p, ports, true, frames, &ins, &main_in, &others) != 0 || ports_open(p, ports, false, frames, &outs, &main_out, &others) != 0 ||
      !p->activate(p, rate, frames, frames)) {
    ports_close(&ins);
    ports_close(&outs);
    c->unmeasured = "refused-instantiation", c->detail = "activate failed for the cost run";
    return;
  }
  if (f->cost_notes) {
    c->capacity = voice_capacity(p, &c->has_capacity);
    if (o->hold) {
      c->held = o->hold, c->basis = BASIS_PROBE;
    } else if (c->has_capacity && c->capacity == 0) {
      c->unmeasured = "no-voices", c->detail = "voice-info declares a voice capacity of 0";
    } else if (c->has_capacity) {
      c->held = c->capacity, c->basis = BASIS_DECLARED;
    } else if (o->probe_notes) {
      c->held = o->probe_notes, c->basis = BASIS_PROBE;
    } else {
      c->unmeasured = "voices-unknown", c->detail = "no voice-info and no --probe-notes count to hold";
    }
    if (c->held > NOTE_KEYS_MAX) c->held = NOTE_KEYS_MAX;
  }
  double *ns = c->unmeasured ? NULL : calloc(COST_WARMUP_BLOCKS + blocks, sizeof *ns);
  if (!c->unmeasured && !ns) c->unmeasured = "probe-error", c->detail = "out of memory for the block times";
  if (c->unmeasured || (p->start_processing && !p->start_processing(p))) {
    if (!c->unmeasured) c->unmeasured = "refused-instantiation", c->detail = "start_processing failed for the cost run";
    free(ns);
    p->deactivate(p);
    ports_close(&ins);
    ports_close(&outs);
    return;
  }
  if (p->reset) p->reset(p);
  ports_fill(&ins, frames, 0.0f);
  uint32_t seed = 0x636f73u;
  const uint32_t total = COST_WARMUP_BLOCKS + blocks;
  int64_t steady = 0;
  c->sched = timing_sched_read();
  for (uint32_t b = 0; b < total; b++) {
    if (b == 0)
      for (uint32_t k = 0; k < c->held; k++) note_key(clap_dialect, 0, 1, held_key(k, c->held), HELD_VELOCITY);
    for (uint32_t k = 0; k < n_rows && k < EVENTS_PER_BLOCK; k++) {
      const uint32_t row = (b * EVENTS_PER_BLOCK + k) % n_rows;
      const double frac = (double)((b * 7u + row * 13u) % 101u) / 100.0;
      union any_event *e = note_event(0, CLAP_EVENT_PARAM_VALUE, sizeof(clap_event_param_value_t));
      if (!e) break;
      e->param.param_id = rows[row].id;
      e->param.cookie = rows[row].cookie;
      e->param.note_id = -1;
      e->param.port_index = -1;
      e->param.channel = -1;
      e->param.key = -1;
      e->param.value = sweep_value(&rows[row], frac);
    }
    for (uint32_t k = 0; k < ins.count; k++)
        for (uint32_t ch = 0; ch < ins.buf[k].channel_count; ch++)
          for (uint32_t i = 0; i < frames; i++) {
            seed = seed * 1664525u + 1013904223u;
            ins.chan[k][ch][i] = ((float)(seed >> 8) / 16777216.0f - 0.5f) * 0.5f;
          }
    const int64_t t0 = now_ns();
    run_block(p, &ins, &outs, frames, &steady, NULL);
    ns[b] = (double)(now_ns() - t0) / (double)frames;
  }
  if (p->stop_processing) p->stop_processing(p);
  p->deactivate(p);
  ports_close(&ins);
  ports_close(&outs);

  double *warm = ns, *timed = ns + COST_WARMUP_BLOCKS;
  qsort(warm, COST_WARMUP_BLOCKS, sizeof *warm, by_value);
  qsort(timed, blocks, sizeof *timed, by_value);
  c->warmup_median = percentile_sorted(warm, COST_WARMUP_BLOCKS, 50.0);
  c->median = percentile_sorted(timed, blocks, 50.0);
  c->p95 = percentile_sorted(timed, blocks, COST_PERCENTILE);
  c->min = timed[0];
  c->max = timed[blocks - 1];
  c->blocks = blocks;
  free(ns);
}

/* ---- the footprint ---- */

/* what loading the .clap itself took, in KB: it belongs to the first instance, since nothing else loads it */
static long g_load_kb;

static long grew(long from) {
  const long now = rss_kb();
  return now < 0 || from < 0 || now < from ? 0 : now - from;
}

static void footprint_blocks(const clap_plugin_t *p, struct port_set *ins, struct port_set *outs, uint32_t frames, uint32_t *seed) {
  int64_t steady = 0;
  for (uint32_t b = 0; b < FOOTPRINT_BLOCKS; b++) {
    for (uint32_t k = 0; k < ins->count; k++)
      for (uint32_t ch = 0; ch < ins->buf[k].channel_count; ch++)
        for (uint32_t i = 0; i < frames; i++) {
          *seed = *seed * 1664525u + 1013904223u;
          ins->chan[k][ch][i] = ((float)(*seed >> 8) / 16777216.0f - 0.5f) * 0.5f;
        }
    run_block(p, ins, outs, frames, &steady, NULL);
  }
}

/* One instance through its life, with the readings as it goes, then a second beside it. Runs in a child of its own: the
 * measure must start from a process no earlier instance grew, and a plugin that dies here costs the rate its figure and
 * nothing else. A figure a step could not reach stays out. */
static void footprint_measure(const clap_plugin_factory_t *factory, const clap_plugin_descriptor_t *d, double rate, uint32_t frames,
                              int instrument_feature, const struct options *o, struct footprint *fp) {
  uint32_t seed = 0x6d656du;
  struct port_set ins, outs, ins2, outs2;
  uint32_t main_in, main_out, others;
  malloc_trim(0);
  const long base = rss_kb();
  if (base < 0) {
    snprintf(fp->unmeasured, sizeof fp->unmeasured, "probe-error");
    snprintf(fp->detail, sizeof fp->detail, "the resident set could not be read");
    return;
  }
  const clap_plugin_t *p = factory->create_plugin(factory, &g_clap_host, d->id);
  if (!p || !p->init(p)) {
    snprintf(fp->unmeasured, sizeof fp->unmeasured, "refused-instantiation");
    snprintf(fp->detail, sizeof fp->detail, "create_plugin or init failed for the footprint");
    return;
  }
  g_host.plugin = p;
  g_host.plugin_thread_pool = p->get_extension(p, CLAP_EXT_THREAD_POOL);
  fp->instantiate = grew(base) + g_load_kb, fp->got |= FP_INSTANTIATE;
  const clap_plugin_audio_ports_t *ports = p->get_extension(p, CLAP_EXT_AUDIO_PORTS);
  if (ports_open(p, ports, true, frames, &ins, &main_in, &others) != 0 || ports_open(p, ports, false, frames, &outs, &main_out, &others) != 0 ||
      !p->activate(p, rate, frames, frames)) {
    snprintf(fp->unmeasured, sizeof fp->unmeasured, "refused-instantiation");
    snprintf(fp->detail, sizeof fp->detail, "activate failed for the footprint");
    return;
  }
  fp->activate = grew(base) + g_load_kb, fp->got |= FP_ACTIVATE;
  if (p->start_processing && !p->start_processing(p)) {
    snprintf(fp->unmeasured, sizeof fp->unmeasured, "refused-instantiation");
    snprintf(fp->detail, sizeof fp->detail, "start_processing failed for the footprint");
    return;
  }
  footprint_blocks(p, &ins, &outs, frames, &seed);
  fp->rest = grew(base) + g_load_kb, fp->got |= FP_REST;
  /* an instrument at the same notes the cost arm holds; one it cannot say a count for has no figure, and says so */
  const clap_plugin_note_ports_t *notes = p->get_extension(p, CLAP_EXT_NOTE_PORTS);
  int clap_dialect = 0, midi_too = 0;
  const char *dialect = note_dialect(p, &clap_dialect, &midi_too);
  if (notes && notes->count(p, true) > 0 && (main_in == 0 || instrument_feature)) {
    int has_capacity = 0;
    const uint32_t capacity = dialect ? voice_capacity(p, &has_capacity) : 0;
    uint32_t held = 0;
    if (!dialect) snprintf(fp->unmeasured, sizeof fp->unmeasured, "notes-unplayable");
    else if (o->hold) held = o->hold, fp->basis = BASIS_PROBE;
    else if (has_capacity && capacity == 0) snprintf(fp->unmeasured, sizeof fp->unmeasured, "no-voices");
    else if (has_capacity) held = capacity, fp->basis = BASIS_DECLARED;
    else if (o->probe_notes) held = o->probe_notes, fp->basis = BASIS_PROBE;
    else snprintf(fp->unmeasured, sizeof fp->unmeasured, "voices-unknown");
    if (held > NOTE_KEYS_MAX) held = NOTE_KEYS_MAX;
    if (held) {
      for (uint32_t k = 0; k < held; k++) note_key(clap_dialect, 0, 1, held_key(k, held), HELD_VELOCITY);
      footprint_blocks(p, &ins, &outs, frames, &seed);
      fp->notes = grew(base) + g_load_kb, fp->got |= FP_NOTES;
    } else {
      snprintf(fp->detail, sizeof fp->detail, "no count of notes to hold for the footprint");
    }
  }
  /* the second instance's own part: what it adds once the first is there, which is what any further one costs */
  const long before = rss_kb();
  const clap_plugin_t *q = factory->create_plugin(factory, &g_clap_host, d->id);
  if (q && q->init(q)) {
    const clap_plugin_audio_ports_t *qports = q->get_extension(q, CLAP_EXT_AUDIO_PORTS);
    if (ports_open(q, qports, true, frames, &ins2, &main_in, &others) == 0 && ports_open(q, qports, false, frames, &outs2, &main_out, &others) == 0 &&
        q->activate(q, rate, frames, frames) && (!q->start_processing || q->start_processing(q))) {
      footprint_blocks(q, &ins2, &outs2, frames, &seed);
      fp->second = grew(before), fp->got |= FP_SECOND;
    }
  }
}

/* the footprint at one rate, from a child of its own */
static void footprint_rate(const clap_plugin_factory_t *factory, const clap_plugin_descriptor_t *d, double rate, uint32_t frames,
                           int instrument_feature, const struct options *o, struct footprint *fp) {
  int fds[2];
  memset(fp, 0, sizeof *fp);
  fflush(NULL);
  if (pipe(fds) != 0) {
    snprintf(fp->unmeasured, sizeof fp->unmeasured, "probe-error");
    snprintf(fp->detail, sizeof fp->detail, "no pipe for the footprint");
    return;
  }
  const pid_t child = fork();
  if (child == 0) {
    struct footprint got;
    close(fds[0]);
    alarm(FOOTPRINT_TIMEOUT_S);
    memset(&got, 0, sizeof got);
    footprint_measure(factory, d, rate, frames, instrument_feature, o, &got);
    const ssize_t wrote = write(fds[1], &got, sizeof got);
    _exit(wrote == (ssize_t)sizeof got ? 0 : 1);
  }
  close(fds[1]);
  int status = 0;
  const ssize_t got = child > 0 ? read(fds[0], fp, sizeof *fp) : -1;
  close(fds[0]);
  if (child > 0) waitpid(child, &status, 0);
  if (got != (ssize_t)sizeof *fp) {
    memset(fp, 0, sizeof *fp);
    snprintf(fp->unmeasured, sizeof fp->unmeasured, child > 0 && WIFSIGNALED(status) ? "probe-crashed" : "probe-error");
    snprintf(fp->detail, sizeof fp->detail, "the footprint's child gave no figure (status %d)", status);
  }
}

/* ---- JSON ---- */

/* where the JSON goes: stdout, or a scan child's pipe */
static FILE *g_out;
static void fputc_out(int c) { fputc(c, g_out); }


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
  fputc_out('"');
  while (*p) {
    const int n = utf8_length(p);
    if (n == 0) {
      fputc_out('?');
      p++;
    } else if (n > 1) {
      fwrite(p, 1, (size_t)n, g_out);
      p += n;
    } else {
      if (*p < 0x20 || *p == 0x7F) fprintf(g_out, "\\u%04x", *p);
      else if (*p == '"' || *p == '\\') fprintf(g_out, "\\%c", *p);
      else fputc_out(*p);
      p++;
    }
  }
  fputc_out('"');
}

static void put_strings(const char *const *list, size_t n) {
  fputc_out('[');
  for (size_t i = 0; i < n && list[i]; i++) {
    if (i) fputc_out(',');
    put_string(list[i]);
  }
  fputc_out(']');
}

static size_t count_strings(const char *const *list) {
  size_t n = 0;
  while (list && list[n]) n++;
  return n;
}

static void put_head(const char *id, const char *path, const char *sha256) {
  char *uri = NULL;
  if (asprintf(&uri, "urn:clap:%s", id) < 0) uri = NULL;
  fprintf(g_out, "{\"uri\":");
  put_string(uri);
  free(uri);
  fprintf(g_out, ",\"format\":\"clap\",\"id\":");
  put_string(id);
  fprintf(g_out, ",\"binary\":{\"path\":");
  put_string(path);
  fprintf(g_out, ",\"sha256\":");
  put_string(sha256);
  fprintf(g_out, "},\"hostExtensions\":");
  const char *offered[HOST_EXTENSION_COUNT + OFFERABLE_COUNT + 1];
  size_t n = 0;
  for (size_t k = 0; k < HOST_EXTENSION_COUNT; k++) offered[n++] = HOST_EXTENSIONS[k];
  for (size_t k = 0; k < OFFERABLE_COUNT; k++)
    if (g_offered[k]) offered[n++] = OFFERABLE[k].id;
  offered[n] = NULL;
  put_strings(offered, n);
}

static const char *event_kind(int k) {
  return k > 0 && k < (int)(sizeof EVENT_KIND / sizeof EVENT_KIND[0]) ? EVENT_KIND[k] : "unknown";
}

/* the note sweep's block: not applicable without a note input it can speak to; its counts only under the interposer */
static void put_note_sweep(const struct facts *f, uint32_t frames) {
  if (!f->note_dialect) {
    fprintf(g_out, ",\"noteSweep\":{\"applicable\":false}");
    return;
  }
  fprintf(g_out, ",\"noteSweep\":{\"applicable\":true,\"dialect\":\"%s\",\"blocks\":%u,\"blockFrames\":%u,\"noteEvents\":%u,"
          "\"processErrors\":%u,\"nonFinite\":%s,\"interposer\":%s", f->note_dialect, f->note_calls, frames, f->note_events,
          f->note_errors, f->note_nonfinite ? "true" : "false", f->interposer ? "true" : "false");
  if (f->interposer) {
    fprintf(g_out, ",\"allocationsInRun\":%llu,\"locksInRun\":%llu,\"syscallsInRun\":%llu,\"events\":[",
            (unsigned long long)f->note_allocations, (unsigned long long)f->note_locks, (unsigned long long)f->note_syscalls);
    for (int i = 0; i < f->n_note_rt_events; i++) fprintf(g_out, "%s\"%s\"", i ? "," : "", event_kind(f->note_rt_events[i].kind));
    fputc_out(']');
  }
  fputc_out('}');
}

static const char *const BASIS_NAME[] = { [BASIS_NONE] = NULL, [BASIS_DECLARED] = "declared", [BASIS_PROBE] = "probe" };

/* the cost arm: per rate, its figures in nanoseconds per sample and the notes it held, or why it has none */
static void put_cost(const struct facts *f, uint32_t frames) {
  fprintf(g_out, ",\"cost\":{\"stimulus\":\"%s\",\"blockFrames\":%u,\"warmupBlocks\":%u,\"percentile\":%.0f,\"perRate\":{",
          f->cost_notes ? "notes-held" : "noise", frames, COST_WARMUP_BLOCKS, COST_PERCENTILE);
  for (uint32_t r = 0; r < f->n_rates; r++) {
    const struct cost_at *c = &f->cost[r];
    fprintf(g_out, "%s\"%.0f\":{", r ? "," : "", f->rates[r]);
    if (c->unmeasured) {
      fprintf(g_out, "\"unmeasuredReason\":");
      put_string(c->unmeasured);
      fprintf(g_out, ",\"unmeasuredDetail\":");
      put_string(c->detail);
    } else {
      fprintf(g_out, "\"nsPerSampleMedian\":%.6g,\"nsPerSampleP95\":%.6g,\"nsPerSampleMin\":%.6g,\"nsPerSampleMax\":%.6g,"
              "\"warmupNsPerSampleMedian\":%.6g,\"blocks\":%u", c->median, c->p95, c->min, c->max, c->warmup_median, c->blocks);
      if (c->sched.policy) fprintf(g_out, ",\"scheduling\":{\"policy\":\"%s\",\"priority\":%d}", c->sched.policy, c->sched.priority);
    }
    if (f->cost_notes && (c->basis != BASIS_NONE || c->has_capacity)) {
      fprintf(g_out, ",\"voices\":{");
      if (c->basis != BASIS_NONE) fprintf(g_out, "\"held\":%u,\"basis\":\"%s\"%s", c->held, BASIS_NAME[c->basis], c->has_capacity ? "," : "");
      if (c->has_capacity) fprintf(g_out, "\"capacity\":%u", c->capacity);
      fputc_out('}');
    }
    const struct footprint *fp = &f->footprint[r];
    fprintf(g_out, ",\"memory\":{");
    const char *sep = "";
    if (fp->got & FP_INSTANTIATE) fprintf(g_out, "%s\"afterInstantiateKb\":%ld", sep, fp->instantiate), sep = ",";
    if (fp->got & FP_ACTIVATE) fprintf(g_out, "%s\"afterActivateKb\":%ld", sep, fp->activate), sep = ",";
    if (fp->got & FP_REST) fprintf(g_out, "%s\"atRestKb\":%ld", sep, fp->rest), sep = ",";
    if (fp->got & FP_NOTES) fprintf(g_out, "%s\"notesHeldKb\":%ld,\"basis\":\"%s\"", sep, fp->notes, BASIS_NAME[fp->basis]), sep = ",";
    if (fp->got & FP_SECOND) fprintf(g_out, "%s\"secondInstanceKb\":%ld", sep, fp->second), sep = ",";
    if (fp->unmeasured[0]) {
      fprintf(g_out, "%s\"unmeasuredReason\":", sep);
      put_string(fp->unmeasured);
      if (fp->detail[0]) {
        fprintf(g_out, ",\"unmeasuredDetail\":");
        put_string(fp->detail);
      }
    }
    fprintf(g_out, "}}");
  }
  fprintf(g_out, "}}");
}

static void put_facts(const clap_plugin_descriptor_t *d, const struct facts *f, uint32_t frames) {
  fprintf(g_out, ",\"clap\":{\"mainInputChannels\":%u,\"mainOutputChannels\":%u,\"sidechainInputs\":%u,\"features\":", f->main_in,
         f->main_out, f->sidechains);
  put_strings(d->features, count_strings(d->features));
  fprintf(g_out, ",\"headlessOk\":%s,\"noteInputs\":%u,\"latency\":{", f->headless_ok ? "true" : "false", f->note_inputs);
  if (f->headless_ok)
    for (uint32_t r = 0; r < f->n_rates; r++)
      fprintf(g_out, "%s\"%.0f\":{\"declaredFrames\":%u,\"measuredFrames\":%u%s%s}", r ? "," : "", f->rates[r], f->declared[r],
             f->measured[r], f->latency_note >= 0 && f->main_in == 0 ? ",\"from\":\"note\"" : "",
             f->latency_note >= 0 && f->main_in == 0 && !f->heard[r] ? ",\"heard\":false" : "");
  fprintf(g_out, "},\"threadViolations\":%u,\"processErrors\":%u,\"processCalls\":%u,\"nonFinite\":%s}", g_host.thread_violations,
         f->process_errors, f->process_calls, f->nonfinite ? "true" : "false");
  if (!f->interposer) {
    fprintf(g_out, ",\"rtSafety\":{\"interposer\":false}");
    put_note_sweep(f, frames);
    if (f->n_rates && f->headless_ok) put_cost(f, frames);
    return;
  }
  fprintf(g_out, ",\"rtSafety\":{\"interposer\":true,\"swept\":%s,\"sweepApplicable\":%s,\"blocks\":%u,\"blockFrames\":%u,"
         "\"allocationsInRun\":%llu,\"locksInRun\":%llu,\"syscallsInRun\":%llu,\"events\":[",
         f->params ? "true" : "false", f->params ? "true" : "false", f->process_calls, frames,
         (unsigned long long)f->allocations, (unsigned long long)f->locks, (unsigned long long)f->syscalls);
  for (int i = 0; i < f->n_events; i++) {
    const int k = f->events[i].kind;
    fprintf(g_out, "%s\"%s\"", i ? "," : "", k > 0 && k < (int)(sizeof EVENT_KIND / sizeof EVENT_KIND[0]) ? EVENT_KIND[k] : "unknown");
  }
  fprintf(g_out, "]}");
  put_note_sweep(f, frames);
  if (f->n_rates && f->headless_ok) put_cost(f, frames);
}

/* ---- the pin (plugin-qualify spec §11) ---- */

/*
 * The integrity block: the SHA-256 of the one file the host loads, the `.clap`, by its path relative to
 * its directory under the name the prober was handed (a symlink's own name, not its target's, since the
 * console adds the path it was given and plugin-hostd checks that name), and the plugin's parameter layout in plugin-hostd's omx-layout/1, filled from every
 * parameter params.count()/get_info() give (hidden, read-only and bypass included) after init and
 * before activate, as omx-clap-host recomputes it on `add`. pin.h serialises and hashes; nothing here
 * does. A file name a pin cannot hold, or a layout that cannot be read, is no pin and says why.
 */
struct integrity {
  const char *reason; /* NULL when the pin was taken */
  const char *detail;
  char layout[PHD_SHA256_HEX_LEN + 1];
};

static void integrity_layout(const clap_plugin_t *p, struct integrity *pin) {
  const clap_plugin_params_t *params = p->get_extension(p, CLAP_EXT_PARAMS);
  const uint32_t count = params ? params->count(p) : 0;
  if (count > HOST_PARAM_COUNT_MAX) {
    pin->reason = "unpinnable", pin->detail = "more parameters than the host accepts (" STR(HOST_PARAM_COUNT_MAX) ")";
    return;
  }
  clap_param_info_t *infos = calloc(count ? count : 1, sizeof *infos);
  phd_layout_clap_param_t *records = calloc(count ? count : 1, sizeof *records);
  pin->reason = "probe-error";
  if (!infos || !records) {
    pin->detail = "out of memory reading the parameter layout";
    goto out;
  }
  for (uint32_t i = 0; i < count; i++) {
    if (!params->get_info(p, i, &infos[i])) {
      pin->detail = "a parameter's get_info failed";
      goto out;
    }
    infos[i].name[sizeof infos[i].name - 1] = '\0';
    records[i] = (phd_layout_clap_param_t){ infos[i].id, infos[i].name, infos[i].min_value, infos[i].max_value,
                                            infos[i].default_value, infos[i].flags };
  }
  if (phd_layout_clap_digest(records, count, pin->layout) != 0) {
    pin->detail = "out of memory hashing the parameter layout";
    goto out;
  }
  pin->reason = pin->detail = NULL;
out:
  free(records);
  free(infos);
}

static void put_integrity(const char *named, const char *version, const char *sha256, const struct integrity *pin) {
  const char *base = strrchr(named, '/');
  base = base ? base + 1 : named;
  fprintf(g_out, ",\"integrity\":{");
  if (version && *version) {
    fprintf(g_out, "\"version\":");
    put_string(version);
    fputc_out(',');
  }
  if (strpbrk(base, PHD_PIN_PATH_EXCLUDED)) {
    fprintf(g_out, "\"unmeasuredReason\":\"unpinnable\",\"unmeasuredDetail\":");
    put_string("the file name holds a separator of pin_set or whitespace");
  } else if (pin->reason) {
    fprintf(g_out, "\"unmeasuredReason\":");
    put_string(pin->reason);
    fprintf(g_out, ",\"unmeasuredDetail\":");
    put_string(pin->detail);
  } else {
    fprintf(g_out, "\"files\":[{\"path\":");
    put_string(base);
    fprintf(g_out, ",\"sha256\":");
    put_string(sha256);
    fprintf(g_out, "}],\"layout\":{\"scheme\":\"%s\",\"sha256\":\"%s\"}", PHD_PIN_LAYOUT_SCHEME, pin->layout);
  }
  fputc_out('}');
}

/* ---- the scan ---- */

/*
 * `clap-qualify --json <path>...` lists what CLAP files hold, in the scan document the CLAP loader
 * reads (`src/clap-loader.ts`): every plugin of every factory, initialised and never activated, with
 * its parameters, an enum parameter's labels as the plugin renders them, its remote-control pages,
 * its audio ports (with their port type) and note ports (with their dialects) and latency, and each
 * file's SHA-256, the key `tools/descriptors.py clap` names the plugin's scanned descriptor by. Each
 * file is scanned in a child, so a plugin that crashes or hangs is reported and the scan goes on.
 */

#define SCAN_TIMEOUT_S 30
#define MAX_ENUM_LABELS 1024u
#define CLAP_SUFFIX ".clap"

static const struct { uint32_t bit; const char *name; } PARAM_FLAGS[] = {
  { CLAP_PARAM_IS_STEPPED, "stepped" },
  { CLAP_PARAM_IS_PERIODIC, "periodic" },
  { CLAP_PARAM_IS_HIDDEN, "hidden" },
  { CLAP_PARAM_IS_READONLY, "readonly" },
  { CLAP_PARAM_IS_BYPASS, "bypass" },
  { CLAP_PARAM_IS_AUTOMATABLE, "automatable" },
  { CLAP_PARAM_IS_AUTOMATABLE_PER_NOTE_ID, "automatable_per_note_id" },
  { CLAP_PARAM_IS_AUTOMATABLE_PER_KEY, "automatable_per_key" },
  { CLAP_PARAM_IS_AUTOMATABLE_PER_CHANNEL, "automatable_per_channel" },
  { CLAP_PARAM_IS_AUTOMATABLE_PER_PORT, "automatable_per_port" },
  { CLAP_PARAM_IS_MODULATABLE, "modulatable" },
  { CLAP_PARAM_IS_MODULATABLE_PER_NOTE_ID, "modulatable_per_note_id" },
  { CLAP_PARAM_IS_MODULATABLE_PER_KEY, "modulatable_per_key" },
  { CLAP_PARAM_IS_MODULATABLE_PER_CHANNEL, "modulatable_per_channel" },
  { CLAP_PARAM_IS_MODULATABLE_PER_PORT, "modulatable_per_port" },
  { CLAP_PARAM_REQUIRES_PROCESS, "requires_process" },
  { CLAP_PARAM_IS_ENUM, "enum" },
};

/* JSON has no infinity: a bound the plugin leaves open is null */
static void put_number(double v) {
  if (isfinite(v)) fprintf(g_out, "%.17g", v);
  else fputs("null", g_out);
}

/* an enum parameter's labels: value_to_text at every whole value of its range */
static void put_labels(const clap_plugin_t *p, const clap_plugin_params_t *params, const clap_param_info_t *info) {
  fputs(",\"labels\":[", g_out);
  int first = 1;
  if (params->value_to_text && isfinite(info->min_value) && isfinite(info->max_value) &&
      info->max_value - info->min_value < MAX_ENUM_LABELS) {
    for (double v = ceil(info->min_value); v <= info->max_value; v += 1.0) {
      char text[CLAP_NAME_SIZE];
      memset(text, 0, sizeof text);
      if (!params->value_to_text(p, info->id, v, text, sizeof text)) continue;
      text[sizeof text - 1] = '\0';
      fprintf(g_out, "%s{\"value\":", first ? "" : ",");
      put_number(v);
      fputs(",\"label\":", g_out);
      put_string(text);
      fputc('}', g_out);
      first = 0;
    }
  }
  fputc(']', g_out);
}

static void scan_params(const clap_plugin_t *p) {
  const clap_plugin_params_t *params = p->get_extension(p, CLAP_EXT_PARAMS);
  const uint32_t n = params ? params->count(p) : 0;
  int first = 1;
  fputs("\"params\":[", g_out);
  for (uint32_t i = 0; i < n; i++) {
    clap_param_info_t info;
    memset(&info, 0, sizeof info);
    if (!params->get_info(p, i, &info)) continue;
    info.name[sizeof info.name - 1] = '\0';
    info.module[sizeof info.module - 1] = '\0';
    fprintf(g_out, "%s\n{\"id\":%u,\"name\":", first ? "" : ",", info.id);
    put_string(info.name);
    fputs(",\"module\":", g_out);
    put_string(info.module);
    fputs(",\"min\":", g_out);
    put_number(info.min_value);
    fputs(",\"max\":", g_out);
    put_number(info.max_value);
    fputs(",\"default\":", g_out);
    put_number(info.default_value);
    fputs(",\"flags\":[", g_out);
    int f1 = 1;
    for (size_t k = 0; k < sizeof PARAM_FLAGS / sizeof PARAM_FLAGS[0]; k++) {
      if (!(info.flags & PARAM_FLAGS[k].bit)) continue;
      fprintf(g_out, "%s\"%s\"", f1 ? "" : ",", PARAM_FLAGS[k].name);
      f1 = 0;
    }
    fputc(']', g_out);
    if (info.flags & CLAP_PARAM_IS_ENUM) put_labels(p, params, &info);
    fputc('}', g_out);
    first = 0;
  }
  fputs(first ? "]" : "\n]", g_out);
}

/* the remote-control pages, each eight slots, an empty slot null */
static void scan_remote_controls(const clap_plugin_t *p) {
  const clap_plugin_remote_controls_t *rc = p->get_extension(p, CLAP_EXT_REMOTE_CONTROLS);
  if (!rc) rc = p->get_extension(p, CLAP_EXT_REMOTE_CONTROLS_COMPAT);
  const uint32_t n = rc ? rc->count(p) : 0;
  int first = 1;
  fputs("\"remote_controls\":[", g_out);
  for (uint32_t i = 0; i < n; i++) {
    clap_remote_controls_page_t page;
    memset(&page, 0, sizeof page);
    if (!rc->get(p, i, &page)) continue;
    page.section_name[sizeof page.section_name - 1] = '\0';
    page.page_name[sizeof page.page_name - 1] = '\0';
    fprintf(g_out, "%s{\"id\":%u,\"section\":", first ? "" : ",", page.page_id);
    put_string(page.section_name);
    fputs(",\"name\":", g_out);
    put_string(page.page_name);
    fputs(",\"params\":[", g_out);
    for (uint32_t k = 0; k < CLAP_REMOTE_CONTROLS_COUNT; k++) {
      if (k) fputc(',', g_out);
      if (page.param_ids[k] == CLAP_INVALID_ID) fputs("null", g_out);
      else fprintf(g_out, "%u", page.param_ids[k]);
    }
    fprintf(g_out, "],\"forPreset\":%s}", page.is_for_preset ? "true" : "false");
    first = 0;
  }
  fputc(']', g_out);
}

static void scan_audio_ports(const clap_plugin_t *p) {
  const clap_plugin_audio_ports_t *ports = p->get_extension(p, CLAP_EXT_AUDIO_PORTS);
  fputs("\"audio_ports\":{", g_out);
  for (int dir = 0; dir < 2; dir++) {
    const bool input = dir == 0;
    const uint32_t n = ports ? ports->count(p, input) : 0;
    int first = 1;
    fprintf(g_out, "%s\"%s\":[", dir ? "," : "", input ? "inputs" : "outputs");
    for (uint32_t i = 0; i < n; i++) {
      clap_audio_port_info_t info;
      memset(&info, 0, sizeof info);
      if (!ports->get(p, i, input, &info)) continue;
      info.name[sizeof info.name - 1] = '\0';
      fprintf(g_out, "%s{\"id\":%u,\"name\":", first ? "" : ",", info.id);
      put_string(info.name);
      fprintf(g_out, ",\"role\":\"%s\",\"channels\":%u,\"port_type\":", (info.flags & CLAP_AUDIO_PORT_IS_MAIN) ? "main" : "aux", info.channel_count);
      if (info.port_type) put_string(info.port_type);
      else fputs("null", g_out);
      fputc('}', g_out);
      first = 0;
    }
    fputc(']', g_out);
  }
  fputc('}', g_out);
}

static const struct { uint32_t bit; const char *name; } NOTE_DIALECTS[] = {
  { CLAP_NOTE_DIALECT_CLAP, "clap" },
  { CLAP_NOTE_DIALECT_MIDI, "midi" },
  { CLAP_NOTE_DIALECT_MIDI_MPE, "midi_mpe" },
  { CLAP_NOTE_DIALECT_MIDI2, "midi2" },
};

/* each note port with the dialects it supports, as clap_note_port_info states them */
static void scan_note_ports(const clap_plugin_t *p, const clap_plugin_note_ports_t *notes) {
  fputs("\"note_port_info\":{", g_out);
  for (int dir = 0; dir < 2; dir++) {
    const bool input = dir == 0;
    const uint32_t n = notes ? notes->count(p, input) : 0;
    int first = 1;
    fprintf(g_out, "%s\"%s\":[", dir ? "," : "", input ? "inputs" : "outputs");
    for (uint32_t i = 0; i < n; i++) {
      clap_note_port_info_t info;
      memset(&info, 0, sizeof info);
      if (!notes->get(p, i, input, &info)) continue;
      info.name[sizeof info.name - 1] = '\0';
      fprintf(g_out, "%s{\"id\":%u,\"name\":", first ? "" : ",", info.id);
      put_string(info.name);
      fputs(",\"dialects\":[", g_out);
      int d1 = 1;
      for (size_t k = 0; k < sizeof NOTE_DIALECTS / sizeof NOTE_DIALECTS[0]; k++) {
        if (!(info.supported_dialects & NOTE_DIALECTS[k].bit)) continue;
        fprintf(g_out, "%s\"%s\"", d1 ? "" : ",", NOTE_DIALECTS[k].name);
        d1 = 0;
      }
      fputs("]}", g_out);
      first = 0;
    }
    fputc(']', g_out);
  }
  fputc('}', g_out);
}

static void scan_plugin(const clap_plugin_factory_t *factory, const clap_plugin_descriptor_t *d) {
  fputs("{\"id\":", g_out);
  put_string(d->id);
  fputs(",\"name\":", g_out);
  put_string(d->name);
  fputs(",\"vendor\":", g_out);
  put_string(d->vendor);
  fputs(",\"version\":", g_out);
  put_string(d->version);
  fputs(",\"description\":", g_out);
  put_string(d->description);
  fputs(",\"url\":", g_out);
  put_string(d->url);
  fputs(",\"features\":", g_out);
  put_strings(d->features, count_strings(d->features));
  const clap_plugin_t *p = factory->create_plugin(factory, &g_clap_host, d->id);
  if (!p || !p->init(p)) {
    if (p) p->destroy(p);
    fputs(",\"error\":\"plugin failed to create or init\"}", g_out);
    return;
  }
  fputc(',', g_out);
  scan_params(p);
  fputc(',', g_out);
  scan_remote_controls(p);
  fputc(',', g_out);
  scan_audio_ports(p);
  const clap_plugin_note_ports_t *notes = p->get_extension(p, CLAP_EXT_NOTE_PORTS);
  fprintf(g_out, ",\"note_ports\":{\"inputs\":%u,\"outputs\":%u}", notes ? notes->count(p, true) : 0, notes ? notes->count(p, false) : 0);
  fputc(',', g_out);
  scan_note_ports(p, notes);
  /* a plugin not yet activated may say 0, so 0 is left out as unknown; whether it reports a latency at all is the extension */
  const clap_plugin_latency_t *latency = p->get_extension(p, CLAP_EXT_LATENCY);
  const uint32_t frames = latency ? latency->get(p) : 0;
  fprintf(g_out, ",\"latency_extension\":%s", latency ? "true" : "false");
  if (frames) fprintf(g_out, ",\"latency\":%u", frames);
  fputc('}', g_out);
  p->destroy(p);
}

static void put_file_error(const char *path, const char *reason) {
  fputs("{\"path\":", g_out);
  put_string(path);
  fputs(",\"error\":", g_out);
  put_string(reason);
  fputc('}', g_out);
}

/* one file's entry, written from the child */
static void scan_file_entry(const char *path) {
  char local[PATH_MAX];
  /* dlopen searches the library path for a name with no slash, and the file is here */
  const char *open_as = strchr(path, '/') || snprintf(local, sizeof local, "./%s", path) >= (int)sizeof local ? path : local;
  void *so = dlopen(open_as, RTLD_NOW | RTLD_LOCAL);
  if (!so) {
    put_file_error(path, dlerror());
    return;
  }
  const clap_plugin_entry_t *entry = dlsym(so, "clap_entry");
  if (!entry || !clap_version_is_compatible(entry->clap_version) || !entry->init(open_as)) {
    put_file_error(path, "no usable clap_entry");
    return;
  }
  const clap_plugin_factory_t *factory = entry->get_factory(CLAP_PLUGIN_FACTORY_ID);
  const uint32_t n = factory ? factory->get_plugin_count(factory) : 0;
  int first = 1;
  fputs("{\"path\":", g_out);
  put_string(path);
  /* the bytes the plugins were read from, the key a scanned descriptor is named by */
  char sha256[PHD_SHA256_HEX_LEN + 1];
  const int fd = open(open_as, O_RDONLY | O_CLOEXEC);
  if (fd >= 0 && phd_pin_fd_digest(fd, sha256) == 0) {
    fputs(",\"sha256\":", g_out);
    put_string(sha256);
  }
  if (fd >= 0) close(fd);
  fputs(",\"plugins\":[", g_out);
  for (uint32_t i = 0; i < n; i++) {
    const clap_plugin_descriptor_t *d = factory->get_plugin_descriptor(factory, i);
    if (!d || !d->id) continue;
    fputs(first ? "\n" : ",\n", g_out);
    scan_plugin(factory, d);
    first = 0;
  }
  fputs(first ? "]}" : "\n]}", g_out);
  entry->deinit();
}

/* the file scanned in a child; a child that dies or hangs is the reason */
static void scan_file(const char *path) {
  int fds[2], status = 0;
  fflush(g_out);
  if (pipe(fds) != 0) {
    put_file_error(path, "no pipe for the scan");
    return;
  }
  const pid_t pid = fork();
  if (pid < 0) {
    close(fds[0]);
    close(fds[1]);
    put_file_error(path, "no process for the scan");
    return;
  }
  if (pid == 0) {
    close(fds[0]);
    /* what a plugin prints goes to stderr, never into the document */
    dup2(STDERR_FILENO, STDOUT_FILENO);
    alarm(SCAN_TIMEOUT_S);
    g_out = fdopen(fds[1], "w");
    scan_file_entry(path);
    fflush(g_out);
    _exit(0);
  }
  close(fds[1]);
  size_t size = 0, cap = 65536;
  char *data = malloc(cap);
  for (;;) {
    if (size == cap) data = realloc(data, cap *= 2);
    const ssize_t got = read(fds[0], data + size, cap - size);
    if (got < 0 && errno == EINTR) continue;
    if (got <= 0) break;
    size += (size_t)got;
  }
  close(fds[0]);
  waitpid(pid, &status, 0);
  char reason[128];
  if (WIFEXITED(status) && WEXITSTATUS(status) == 0 && size > 0) {
    fwrite(data, 1, size, g_out);
  } else if (WIFSIGNALED(status)) {
    if (WTERMSIG(status) == SIGALRM) snprintf(reason, sizeof reason, "timed out after %i s", SCAN_TIMEOUT_S);
    else snprintf(reason, sizeof reason, "crashed with signal %i (%s)", WTERMSIG(status), strsignal(WTERMSIG(status)));
    put_file_error(path, reason);
  } else {
    put_file_error(path, "the scan ended without a result");
  }
  free(data);
}

struct list { char **items; size_t count; };

static void list_add(struct list *l, char *item) {
  l->items = realloc(l->items, (l->count + 1) * sizeof *l->items);
  l->items[l->count++] = item;
}

static int by_name(const void *a, const void *b) { return strcmp(*(char *const *)a, *(char *const *)b); }

static int is_clap(const char *name) {
  const size_t n = strlen(name), m = strlen(CLAP_SUFFIX);
  return n > m && !strcmp(name + n - m, CLAP_SUFFIX);
}

/* the .clap files under a directory, in name order */
static void walk(const char *dir, struct list *files) {
  struct list names = { NULL, 0 };
  DIR *h = opendir(dir);
  if (!h) return;
  struct dirent *e;
  while ((e = readdir(h)))
    if (strcmp(e->d_name, ".") && strcmp(e->d_name, "..")) list_add(&names, strdup(e->d_name));
  closedir(h);
  qsort(names.items, names.count, sizeof *names.items, by_name);
  for (size_t i = 0; i < names.count; i++) {
    char *path;
    struct stat st;
    if (asprintf(&path, "%s/%s", dir, names.items[i]) < 0) continue;
    if (stat(path, &st) == 0 && S_ISDIR(st.st_mode)) {
      walk(path, files);
      free(path);
    } else if (stat(path, &st) == 0 && S_ISREG(st.st_mode) && is_clap(names.items[i])) {
      list_add(files, path);
    } else {
      free(path);
    }
    free(names.items[i]);
  }
  free(names.items);
}

static int scan(int n, char **paths) {
  struct list files = { NULL, 0 };
  int readable = 0, first = 1;
  for (int i = 0; i < n; i++) {
    struct stat st;
    if (stat(paths[i], &st) != 0) continue;
    readable++;
    if (S_ISDIR(st.st_mode)) walk(paths[i], &files);
    else list_add(&files, strdup(paths[i]));
  }
  fputs("{\"scanner\":\"clap-qualify\",\"version\":\"1\",\"files\":[", g_out);
  for (size_t i = 0; i < files.count; i++) {
    fputs(first ? "\n" : ",\n", g_out);
    scan_file(files.items[i]);
    first = 0;
  }
  fputs(first ? "]}\n" : "\n]}\n", g_out);
  if (!readable) {
    fprintf(stderr, "clap-qualify: no path could be read\n");
    return 1;
  }
  return 0;
}

/* ---- the program ---- */

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

  /* the footprint comes first and from children of their own, so no instance before it has grown this process */
  {
    int feature = 0;
    for (const char *const *ft = d->features; ft && *ft; ft++)
      if (!strcmp(*ft, CLAP_PLUGIN_FEATURE_INSTRUMENT)) feature = 1;
    for (uint32_t r = 0; r < o->n_rates; r++) footprint_rate(factory, d, o->rates[r], o->frames, feature, o, &f.footprint[r]);
  }

  /* OMX_PROBE_MEMORY_ONLY: the footprint is all this run takes. No instance of this process, no sweep, no cost. The runner
   * makes one grid point per key of clap.latency, so those keys are written, with figures nothing reads: plugin-qualify
   * takes only `memory` from such a run (src/qualify-rejudge.ts). */
  if (getenv("OMX_PROBE_MEMORY_ONLY")) {
    for (uint32_t r = 0; r < o->n_rates; r++) {
      if (f.footprint[r].got || strcmp(f.footprint[r].unmeasured, "refused-instantiation")) f.headless_ok = 1;
      f.cost[r].unmeasured = "not-attempted", f.cost[r].detail = "a memory-only run takes the footprint alone";
    }
    struct integrity none = { "not-attempted", "a memory-only run takes no pin", "" };
    put_head(d->id, path, sha256);
    put_facts(d, &f, o->frames);
    put_integrity(o->path, d->version, sha256, &none);
    fprintf(g_out, "}\n");
    return f.headless_ok ? 0 : 2;
  }

  struct integrity pin = { "refused-instantiation", "create_plugin or init failed", "" };
  const clap_plugin_t *p = factory->create_plugin(factory, &g_clap_host, d->id);
  if (!p || !p->init(p)) {
    if (p) p->destroy(p);
    put_head(d->id, path, sha256);
    put_facts(d, &f, o->frames);
    put_integrity(o->path, d->version, sha256, &pin);
    fprintf(g_out, "}\n");
    return 2;
  }
  f.headless_ok = 1;
  g_host.plugin = p;
  g_host.plugin_thread_pool = p->get_extension(p, CLAP_EXT_THREAD_POOL);
  integrity_layout(p, &pin);
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
    rows[n_rows++] = (struct param_row){ info.id, info.min_value, info.max_value, info.cookie, (info.flags & CLAP_PARAM_IS_STEPPED) != 0 };
  }
  f.params = n_rows;

  struct interposer ip;
  f.interposer = interposer_find(&ip);
  if (f.interposer) ip.reset();
  {
    int clap_d = 0, midi_d = 0;
    f.latency_note = note_dialect(p, &clap_d, &midi_d) ? (clap_d ? 0 : 1) : -1;
  }
  for (uint32_t r = 0; r < o->n_rates && f.headless_ok; r++)
    measure_rate(p, o->rates[r], o->frames, o->blocks, rows, n_rows, f.interposer ? &ip : NULL, &f, r);
  if (f.interposer) {
    ip.counts(&f.allocations, &f.locks, &f.syscalls);
    f.n_events = ip.events(f.events, OMX_RT_EV_MAX);
  }
  int clap_dialect = 0, midi_too = 0;
  f.note_dialect = f.headless_ok ? note_dialect(p, &clap_dialect, &midi_too) : NULL;
  if (f.note_dialect) {
    if (f.interposer) ip.reset();
    for (uint32_t r = 0; r < o->n_rates && f.headless_ok; r++)
      note_sweep_rate(p, o->rates[r], o->frames, o->blocks, clap_dialect, midi_too, f.interposer ? &ip : NULL, &f);
    if (f.interposer) {
      ip.counts(&f.note_allocations, &f.note_locks, &f.note_syscalls);
      f.n_note_rt_events = ip.events(f.note_rt_events, OMX_RT_EV_MAX);
    }
  }
  /* the cost arm: an instrument (a note input, and no main audio input or the instrument feature) holds notes, one the
   * sweep could not play is not timed; anything else, an effect with a note input too, is timed on noise alone */
  int instrument_feature = 0;
  for (const char *const *ft = d->features; ft && *ft; ft++)
    if (!strcmp(*ft, CLAP_PLUGIN_FEATURE_INSTRUMENT)) instrument_feature = 1;
  const int instrument = f.note_inputs > 0 && (f.main_in == 0 || instrument_feature);
  f.cost_notes = instrument && f.note_dialect != NULL;
  for (uint32_t r = 0; r < o->n_rates && f.headless_ok; r++) {
    if (instrument && !f.note_dialect) {
      f.cost[r].unmeasured = "notes-unplayable", f.cost[r].detail = "a note input in no dialect the prober speaks";
      continue;
    }
    cost_rate(p, o->rates[r], o->frames, o->blocks, rows, n_rows, clap_dialect, o, &f, r);
  }
  p->destroy(p);
  put_head(d->id, path, sha256);
  put_facts(d, &f, o->frames);
  put_integrity(o->path, d->version, sha256, &pin);
  fprintf(g_out, "}\n");
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

/* --offer: a comma list of OFFERABLE ids; any other word is a usage error */
static int parse_offer(const char *s) {
  char *copy = strdup(s), *save = NULL;
  int rc = copy ? 0 : -1;
  for (char *tok = copy ? strtok_r(copy, ",", &save) : NULL; tok && rc == 0; tok = strtok_r(NULL, ",", &save)) {
    size_t k = 0;
    while (k < OFFERABLE_COUNT && strcmp(tok, OFFERABLE[k].id)) k++;
    if (k == OFFERABLE_COUNT) rc = -1;
    else g_offered[k] = 1;
  }
  free(copy);
  return rc;
}

static int usage(const char *name) {
  fprintf(stderr,
          "usage: %s --rates <r,...> [--block <frames>] [--blocks <n>] [--offer <ext,...>] [--probe-notes <n>] [--hold <n>]\n"
          "          <path.clap> [<id>]   (--probe-notes and --hold: 1 to " STR(NOTE_KEYS_MAX) " notes)\n"
          "       %s --json <path>...   (the scan: a .clap file, or a directory searched for them)\n",
          name, name);
  return 2;
}

int main(int argc, char **argv) {
  g_out = stdout;
  if (argc >= 2 && !strcmp(argv[1], "--json")) return scan(argc - 2, argv + 2);
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
    } else if (!strcmp(argv[a], "--offer")) {
      if (parse_offer(argv[a + 1]) != 0) return usage(argv[0]);
    } else if (!strcmp(argv[a], "--probe-notes")) {
      if (parse_u32(argv[a + 1], &o.probe_notes) != 0 || o.probe_notes > NOTE_KEYS_MAX) return usage(argv[0]);
    } else if (!strcmp(argv[a], "--hold")) {
      if (parse_u32(argv[a + 1], &o.hold) != 0 || o.hold > NOTE_KEYS_MAX) return usage(argv[0]);
    } else {
      return usage(argv[0]);
    }
  }
  if (o.n_rates == 0 || a >= argc || argc - a > 2) return usage(argv[0]);
  o.path = argv[a];
  o.id = a + 1 < argc ? argv[a + 1] : NULL;
  /* the count plugin-qualify's memory-only run gives an instrument that declares none, as lv2_measure reads it */
  if (getenv("OMX_PROBE_MEMORY_ONLY") && !o.probe_notes && getenv("OMX_PROBE_NOTES") && parse_u32(getenv("OMX_PROBE_NOTES"), &o.probe_notes) != 0) o.probe_notes = 0;
  if (o.probe_notes > NOTE_KEYS_MAX) o.probe_notes = NOTE_KEYS_MAX;

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
  /* the lines go to a private copy of stdout, and stdout itself to stderr, before any plugin code runs: what a plugin
   * prints (Six Sines writes its start-up to stdout) can never enter or tear a line, as in the scan's child */
  {
    fflush(stdout);
    const int out = dup(STDOUT_FILENO);
    FILE *lines = out >= 0 && dup2(STDERR_FILENO, STDOUT_FILENO) >= 0 ? fdopen(out, "w") : NULL;
    if (lines) g_out = lines;
  }

  const long before_load = rss_kb();
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
  g_load_kb = grew(before_load);
  const clap_plugin_factory_t *factory = entry->get_factory(CLAP_PLUGIN_FACTORY_ID);
  int status = 0, found = 0;
  const uint32_t n = factory ? factory->get_plugin_count(factory) : 0;
  for (uint32_t i = 0; i < n; i++) {
    const clap_plugin_descriptor_t *d = factory->get_plugin_descriptor(factory, i);
    if (!d || !d->id || (o.id && strcmp(o.id, d->id))) continue;
    found = 1;
    fflush(g_out);
    if (qualify_plugin(factory, d, path, sha256, &o) != 0) status = 2;
    fflush(g_out);
  }
  entry->deinit();
  dlclose(so);
  if (!found) {
    fprintf(stderr, "%s: %s holds no plugin%s%s\n", argv[0], path, o.id ? " " : "", o.id ? o.id : "");
    return 2;
  }
  return status;
}
