/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
 *
 * lv2-host-probe — a REAL LV2 host for one plugin, so the plugin's host-facing half is tested
 * by a host and not by itself.
 *
 * WHY THIS EXISTS. `hrp_lv2.test.c` drives the shell's CORE and drives it directly: it calls
 * analyse() itself, so it proves the DSP and proves nothing at all about the boilerplate that
 * makes the DSP reachable from a host — the manifest lilv has to parse, the ports it has to
 * bind, `instantiate`'s allocation, `extension_data` handing back the worker interface, and the
 * schedule/work/respond/work_response round trip that is the only reason analysis ever happens.
 * That is a real dead-path risk: every one of those could be wrong with the DSP tier fully
 * green, which is this repo's oldest recurring defect.
 *
 * So this discovers the plugin the way a host does — lilv, the same library mod-host links —
 * loads it from its bundle by URI, supplies a genuine `work:schedule` backed by a REAL second
 * thread, and drives audio through `run()` in quanta. Nothing here includes hrp_lv2.h; the
 * plugin is reached only through `libomx-hrp.so` and its TTL, which is the point.
 *
 *   make -C native              (builds native/build/lv2_host_probe)
 *   native/build/lv2_host_probe <bundle-dir> [plugin-uri]
 *
 * Exit 0 when the plugin loaded, ran, and its worker actually produced a correction that
 * changed the audio; 1 when a claim failed; 2 when the plugin could not be found or
 * instantiated at all. A host that cannot find it and a host that found a silent plugin are
 * different failures and are reported as different exits.
 */
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <lilv/lilv.h>
#include <lv2/core/lv2.h>
#include <lv2/worker/worker.h>

#define RATE 48000u
#define SECONDS 18u
#define FRAMES (RATE * SECONDS)
#define QUANTUM 256u
static const double F0_HZ = 216.796875;
#define HARMONICS 5
#define HOT_HARMONIC 4
#define HOT_EXCESS_DB 10.0
#define TEACH_SECONDS 6.0
#define RING_ON 1.0
#define RING_PERIOD 3.0
#define RAMP_SECONDS 0.05

static const double LADDER[HARMONICS] = {0.315, 0.14, 0.105, 0.07, 0.056};

static float g_in[FRAMES], g_engaged[FRAMES], g_bypassed[FRAMES];

static double ring_at(double t) {
  if (t < TEACH_SECONDS) return 0.0;
  const double phase = fmod(t - TEACH_SECONDS, RING_PERIOD);
  if (phase >= RING_ON) return 0.0;
  double v = 1.0;
  if (phase < RAMP_SECONDS) v = phase / RAMP_SECONDS;
  if (phase > RING_ON - RAMP_SECONDS) v = (RING_ON - phase) / RAMP_SECONDS;
  return v < 0.0 ? 0.0 : v;
}

static void synth(void) {
  const double hot = pow(10.0, HOT_EXCESS_DB / 20.0);
  for (uint32_t i = 0; i < FRAMES; i++) {
    const double ring = ring_at((double)i / RATE);
    double x = 0.0;
    for (int k = 1; k <= HARMONICS; k++) {
      double amp = LADDER[k - 1];
      if (k == HOT_HARMONIC) amp *= 1.0 + ring * (hot - 1.0);
      x += amp * sin(2.0 * M_PI * k * F0_HZ * (double)i / RATE);
    }
    g_in[i] = (float)x;
  }
}

/* Narrowband level at `hz` over a span, dB — measured off the host's OUTPUT buffer. */
static double level_db_at(const float *x, uint32_t from, uint32_t n, double hz) {
  double re = 0.0, im = 0.0;
  for (uint32_t i = 0; i < n; i++) {
    const double w = 2.0 * M_PI * hz * (double)(from + i) / RATE;
    re += (double)x[from + i] * cos(w);
    im += (double)x[from + i] * sin(w);
  }
  const double mag = 2.0 * sqrt(re * re + im * im) / (double)n;
  return 20.0 * log10(mag < 1e-12 ? 1e-12 : mag);
}

/* ---- the host's worker ------------------------------------------------------------------
 *
 * Deliberately the SHAPE a real host uses and not a shortcut: schedule_work is called from the
 * audio thread and must not block, so it hands the job to another thread; the response comes
 * back through a second queue that the audio thread drains before its next run(). If the plugin
 * relied on work() running inline — the mistake this probe exists to catch — it would deadlock
 * or read a response that never arrived, and the measured delta would be zero. */
#define JOB_MAX 32
#define MSG_MAX 4096

typedef struct {
  uint32_t size;
  unsigned char body[MSG_MAX];
} Msg;

typedef struct {
  Msg q[JOB_MAX];
  int head, tail;
  pthread_mutex_t lock;
  pthread_cond_t cond;
} Queue;

static void queue_init(Queue *q) {
  q->head = q->tail = 0;
  pthread_mutex_init(&q->lock, NULL);
  pthread_cond_init(&q->cond, NULL);
}

static int queue_push(Queue *q, uint32_t size, const void *body) {
  if (size > MSG_MAX) return 0;
  pthread_mutex_lock(&q->lock);
  const int next = (q->tail + 1) % JOB_MAX;
  if (next == q->head) {
    pthread_mutex_unlock(&q->lock);
    return 0; /* full: a host drops, it does not block the audio thread */
  }
  q->q[q->tail].size = size;
  memcpy(q->q[q->tail].body, body, size);
  q->tail = next;
  pthread_cond_signal(&q->cond);
  pthread_mutex_unlock(&q->lock);
  return 1;
}

static int queue_pop(Queue *q, Msg *out) {
  pthread_mutex_lock(&q->lock);
  if (q->head == q->tail) {
    pthread_mutex_unlock(&q->lock);
    return 0;
  }
  *out = q->q[q->head];
  q->head = (q->head + 1) % JOB_MAX;
  pthread_mutex_unlock(&q->lock);
  return 1;
}

typedef struct {
  Queue jobs;      /* audio thread -> worker */
  Queue responses; /* worker -> audio thread */
  LilvInstance *instance;
  const LV2_Worker_Interface *iface;
  volatile int running;
  unsigned long jobs_scheduled; /* audio thread only */
  unsigned long jobs_done;      /* worker writes, audio thread reads: __atomic */
} Host;

static LV2_Worker_Status host_respond(LV2_Worker_Respond_Handle handle, uint32_t size,
                                      const void *data) {
  Host *h = (Host *)handle;
  return queue_push(&h->responses, size, data) ? LV2_WORKER_SUCCESS : LV2_WORKER_ERR_NO_SPACE;
}

static void *worker_thread(void *arg) {
  Host *h = (Host *)arg;
  while (h->running) {
    Msg job;
    if (!queue_pop(&h->jobs, &job)) {
      struct timespec ts = {0, 200000L}; /* 0.2 ms */
      nanosleep(&ts, NULL);
      continue;
    }
    h->iface->work(lilv_instance_get_handle(h->instance), host_respond, h, job.size, job.body);
    __atomic_add_fetch(&h->jobs_done, 1, __ATOMIC_RELEASE);
  }
  return NULL;
}

static Host g_host;

static LV2_Worker_Status host_schedule(LV2_Worker_Schedule_Handle handle, uint32_t size,
                                       const void *data) {
  Host *h = (Host *)handle;
  if (!queue_push(&h->jobs, size, data)) return LV2_WORKER_ERR_NO_SPACE;
  h->jobs_scheduled++;
  return LV2_WORKER_SUCCESS;
}

static int g_fail = 0;
static void claim(int ok, const char *what) {
  printf("  %s %s\n", ok ? "ok  " : "FAIL", what);
  if (!ok) g_fail++;
}

int main(int argc, char **argv) {
  const char *bundle = argc > 1 ? argv[1] : "lv2/omx-hrp.lv2/";
  const char *uri = argc > 2 ? argv[2] : "urn:openmixer:hrp";
  synth();

  LilvWorld *world = lilv_world_new();
  char *abs_bundle = realpath(bundle, NULL);
  if (!abs_bundle) {
    fprintf(stderr, "no such bundle: %s\n", bundle);
    return 2;
  }
  char uri_buf[4096];
  snprintf(uri_buf, sizeof(uri_buf), "file://%s/", abs_bundle);
  LilvNode *bundle_uri = lilv_new_uri(world, uri_buf);
  lilv_world_load_bundle(world, bundle_uri);

  const LilvPlugins *plugins = lilv_world_get_all_plugins(world);
  LilvNode *plugin_uri = lilv_new_uri(world, uri);
  const LilvPlugin *plugin = lilv_plugins_get_by_uri(plugins, plugin_uri);
  if (!plugin) {
    fprintf(stderr, "lilv could not find %s in %s\n", uri, uri_buf);
    return 2;
  }
  printf("lv2-host-probe: lilv found %s in %s\n", uri, uri_buf);

  const uint32_t n_ports = lilv_plugin_get_num_ports(plugin);
  printf("  ports: %u\n", n_ports);

  /* Two runs: engaged (bypass 0) and bypassed (bypass 1), same audio, same host. */
  for (int engaged = 1; engaged >= 0; engaged--) {
    Host *h = &g_host;
    memset(h, 0, sizeof(*h));
    queue_init(&h->jobs);
    queue_init(&h->responses);

    LV2_Worker_Schedule schedule = {h, host_schedule};
    LV2_Feature schedule_feature = {LV2_WORKER__schedule, &schedule};
    const LV2_Feature *features[] = {&schedule_feature, NULL};

    LilvInstance *inst = lilv_plugin_instantiate(plugin, (double)RATE, features);
    if (!inst) {
      fprintf(stderr, "instantiate failed\n");
      return 2;
    }
    h->instance = inst;
    h->iface =
        (const LV2_Worker_Interface *)lilv_instance_get_extension_data(inst, LV2_WORKER__interface);
    if (engaged) claim(h->iface != NULL, "the plugin hands back a work:interface");
    if (!h->iface) return 2;

    /* Control values: bypass, family=strings(8), amount=1, bands=8. */
    float ctl_bypass = engaged ? 0.0f : 1.0f;
    float ctl_family = 8.0f, ctl_amount = 1.0f, ctl_bands = 8.0f, ctl_latency = -1.0f;
    static float audio_in[QUANTUM], audio_out[QUANTUM];
    lilv_instance_connect_port(inst, 0, audio_in);
    lilv_instance_connect_port(inst, 1, audio_out);
    lilv_instance_connect_port(inst, 2, &ctl_bypass);
    lilv_instance_connect_port(inst, 3, &ctl_family);
    lilv_instance_connect_port(inst, 4, &ctl_amount);
    lilv_instance_connect_port(inst, 5, &ctl_bands);
    lilv_instance_connect_port(inst, 6, &ctl_latency);

    h->running = 1;
    int worker_late = 0;
    pthread_t tid;
    pthread_create(&tid, NULL, worker_thread, h);

    lilv_instance_activate(inst);
    float *dst = engaged ? g_engaged : g_bypassed;
    for (uint32_t off = 0; off + QUANTUM <= FRAMES; off += QUANTUM) {
      /* Drain the worker's responses on the AUDIO thread, as a host does. */
      Msg r;
      while (queue_pop(&h->responses, &r))
        h->iface->work_response(lilv_instance_get_handle(inst), r.size, r.body);
      memcpy(audio_in, g_in + off, QUANTUM * sizeof(float));
      lilv_instance_run(inst, QUANTUM);
      memcpy(dst + off, audio_out, QUANTUM * sizeof(float));
      /* A real host gives the worker a whole quantum of wall clock, which is always enough on
       * real hardware. So the probe waits for the job it handed over to be done rather than
       * guessing how long that takes: a fixed 0.12 ms read 0.00 dB at the resonance under
       * qemu-aarch64 (231 of 421 passes) where native x86 and arm read -2.5 dB. Bounded, so a
       * dead worker is a failed claim and not a hang. */
      struct timespec ts = {0, 120000L};
      nanosleep(&ts, NULL);
      for (int waited = 0; __atomic_load_n(&h->jobs_done, __ATOMIC_ACQUIRE) < h->jobs_scheduled; waited++) {
        if (waited == 20000) { worker_late = 1; break; } /* 20000 x 0.1 ms = 2 s */
        struct timespec poll = {0, 100000L};
        nanosleep(&poll, NULL);
      }
      if (worker_late) break;
    }
    lilv_instance_deactivate(inst);
    h->running = 0;
    pthread_join(tid, NULL);
    claim(!worker_late, "the worker finished every job it was handed within 2 s");

    if (engaged) {
      claim(ctl_latency == 0.0f, "the latency port reports 0 (it was written, not left unset)");
      claim(h->jobs_done > 100, "the host's worker thread actually ran the analysis");
      printf("  worker passes: %lu\n", h->jobs_done);
    }
    lilv_instance_free(inst);
  }

  /* Measure inside the last ring episode, off the HOST's output buffers. */
  uint32_t end = FRAMES;
  while (end > 0 && ring_at((double)(end - 1) / RATE) <= 0.99) end--;
  const uint32_t n = RATE / 2u, from = end - n;
  const double want = F0_HZ * HOT_HARMONIC;
  const double e = level_db_at(g_engaged, from, n, want);
  const double b = level_db_at(g_bypassed, from, n, want);
  const double h3e = level_db_at(g_engaged, from, n, F0_HZ * 3.0);
  const double h3b = level_db_at(g_bypassed, from, n, F0_HZ * 3.0);

  {
    /* A positive control before any dB is believed: the engaged run must have CHANGED the
     * audio at all. "Quieter at 4*f0" and "the plugin did nothing" are different facts, and a
     * narrowband measurement alone cannot tell them apart. */
    uint32_t diff = 0;
    double worst = 0.0;
    for (uint32_t i = 0; i < FRAMES; i++) {
      const double d = fabs((double)g_engaged[i] - (double)g_in[i]);
      if (d > 0.0) diff++;
      if (d > worst) worst = d;
    }
    printf("  engaged output differs from input in %u/%u samples, worst %.6f\n", diff, FRAMES,
           worst);
    claim(diff > FRAMES / 10, "the engaged run actually changed the audio");
  }
  printf("  window %.2f-%.2f s | H%d engaged %.2f dBFS, bypassed %.2f dBFS -> %.2f dB\n",
         (double)from / RATE, (double)end / RATE, HOT_HARMONIC, e, b, e - b);
  printf("  steady neighbour H3: %.2f dB\n", h3e - h3b);

  claim(e - b < -1.0, "the engaged plugin is measurably quieter at the resonance");
  claim(fabs(h3e - h3b) < 1.5, "and leaves the steady neighbour alone");
  claim(memcmp(g_in, g_bypassed, FRAMES * sizeof(float)) == 0,
        "the BYPASSED run is the input byte for byte (it racks inert)");

  lilv_node_free(plugin_uri);
  lilv_node_free(bundle_uri);
  lilv_world_free(world);
  free(abs_bundle);
  printf("lv2-host-probe: %s\n", g_fail == 0 ? "PASS" : "FAIL");
  return g_fail == 0 ? 0 : 1;
}
