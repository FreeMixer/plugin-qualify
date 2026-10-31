/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com> */
/* The isolated step's signal (plugin-qualify#249): a sine into every audio input of a JACK client, notes held on its MIDI
 * inputs for an instrument, and what comes out of its audio outputs over a window, read from before the first note. The
 * notes start once the links are made, which an instrument needs to hear them, and walk a wide range of keys across the
 * window, each held: a drum kit answers only its mapped keys, and a patch slow to start is never restarted:
 *   isolated_signal <client> <ms>
 * prints one JSON line, {"latencyFrames":n,"xruns":n,"finite":bool,"silent":bool,"midiInputsLinked":n}. Exit 2 when the server or the client's
 * ports could not be had: nothing was learned about the plugin. libjack is opened at run time, as jack_peak opens it: the
 * package needs it only on a machine with a JACK server. */
#include <dlfcn.h>
#include <math.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define MAX_PORTS 16
#define SINE_HZ 1000.0
#define SINE_PEAK 0.25f
#define SILENCE_PEAK 1e-5f
/* the same keys as tools/mod-host-admit.mjs plays */
#define NOTE_FIRST 36
#define NOTE_COUNT 30
#define NOTE_VELOCITY 100
#define JACK_NO_START_SERVER 1
#define JACK_PORT_IS_INPUT 1ul
#define JACK_PORT_IS_OUTPUT 2ul
#define JACK_CAPTURE_LATENCY 0
#define JACK_AUDIO_TYPE "32 bit float mono audio"
#define JACK_MIDI_TYPE "8 bit raw midi"

typedef struct client client_t;
typedef struct port port_t;
struct latency_range { uint32_t min, max; };
static client_t *(*p_client_open)(const char *, int, int *, ...);
static int (*p_client_close)(client_t *);
static int (*p_set_process)(client_t *, int (*)(uint32_t, void *), void *);
static int (*p_set_xrun)(client_t *, int (*)(void *), void *);
static int (*p_activate)(client_t *);
static port_t *(*p_port_register)(client_t *, const char *, const char *, unsigned long, unsigned long);
static void *(*p_port_buffer)(port_t *, uint32_t);
static int (*p_connect)(client_t *, const char *, const char *);
static const char *(*p_port_name)(const port_t *);
static port_t *(*p_port_by_name)(client_t *, const char *);
static const char **(*p_get_ports)(client_t *, const char *, const char *, unsigned long);
static void (*p_free)(void *);
static uint32_t (*p_sample_rate)(client_t *);
static void (*p_latency_range)(port_t *, int, struct latency_range *);
static void (*p_midi_clear)(void *);
static int (*p_midi_write)(void *, uint32_t, const unsigned char *, size_t);

static port_t *g_out, *g_midi, *g_in[MAX_PORTS];
static int g_inputs;
static double g_phase, g_step;
static atomic_int g_xruns, g_notes_due, g_nonfinite;
static int g_notes_sent;
static _Atomic float g_peak;

static int on_process(uint32_t n, void *arg) {
  (void)arg;
  float *out = p_port_buffer(g_out, n);
  for (uint32_t i = 0; i < n; i++) {
    out[i] = SINE_PEAK * (float)sin(g_phase);
    g_phase += g_step;
    if (g_phase > 2.0 * M_PI) g_phase -= 2.0 * M_PI;
  }
  void *midi = p_port_buffer(g_midi, n);
  p_midi_clear(midi);
  if (g_notes_sent < atomic_load(&g_notes_due)) {
    unsigned char on[3] = {0x90, (unsigned char)(NOTE_FIRST + g_notes_sent), NOTE_VELOCITY};
    p_midi_write(midi, 0, on, sizeof on);
    g_notes_sent++;
  }
  float peak = g_peak;
  for (int p = 0; p < g_inputs; p++) {
    const float *in = p_port_buffer(g_in[p], n);
    for (uint32_t i = 0; i < n; i++) {
      if (!isfinite(in[i])) atomic_store(&g_nonfinite, 1);
      else if (fabsf(in[i]) > peak) peak = fabsf(in[i]);
    }
  }
  g_peak = peak;
  return 0;
}

static int on_xrun(void *arg) {
  (void)arg;
  atomic_fetch_add(&g_xruns, 1);
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: isolated_signal <client> <ms>\n");
    return 2;
  }
  void *lib = dlopen("libjack.so.0", RTLD_NOW);
  if (lib == NULL) {
    fprintf(stderr, "no libjack: %s\n", dlerror());
    return 2;
  }
  *(void **)&p_client_open = dlsym(lib, "jack_client_open");
  *(void **)&p_client_close = dlsym(lib, "jack_client_close");
  *(void **)&p_set_process = dlsym(lib, "jack_set_process_callback");
  *(void **)&p_set_xrun = dlsym(lib, "jack_set_xrun_callback");
  *(void **)&p_activate = dlsym(lib, "jack_activate");
  *(void **)&p_port_register = dlsym(lib, "jack_port_register");
  *(void **)&p_port_buffer = dlsym(lib, "jack_port_get_buffer");
  *(void **)&p_connect = dlsym(lib, "jack_connect");
  *(void **)&p_port_name = dlsym(lib, "jack_port_name");
  *(void **)&p_port_by_name = dlsym(lib, "jack_port_by_name");
  *(void **)&p_get_ports = dlsym(lib, "jack_get_ports");
  *(void **)&p_free = dlsym(lib, "jack_free");
  *(void **)&p_sample_rate = dlsym(lib, "jack_get_sample_rate");
  *(void **)&p_latency_range = dlsym(lib, "jack_port_get_latency_range");
  *(void **)&p_midi_clear = dlsym(lib, "jack_midi_clear_buffer");
  *(void **)&p_midi_write = dlsym(lib, "jack_midi_event_write");
  if (!p_client_open || !p_client_close || !p_set_process || !p_set_xrun || !p_activate || !p_port_register || !p_port_buffer || !p_connect ||
      !p_port_name || !p_port_by_name || !p_get_ports || !p_free || !p_sample_rate || !p_latency_range || !p_midi_clear || !p_midi_write) {
    fprintf(stderr, "this libjack lacks a call\n");
    return 2;
  }
  char pattern[256];
  snprintf(pattern, sizeof pattern, "^%s:", argv[1]);
  int status = 0;
  client_t *c = p_client_open("omx-isolated-signal", JACK_NO_START_SERVER, &status);
  if (c == NULL) {
    fprintf(stderr, "no JACK server\n");
    return 2;
  }
  g_step = 2.0 * M_PI * SINE_HZ / p_sample_rate(c);
  g_out = p_port_register(c, "out", JACK_AUDIO_TYPE, JACK_PORT_IS_OUTPUT, 0);
  g_midi = p_port_register(c, "midi", JACK_MIDI_TYPE, JACK_PORT_IS_OUTPUT, 0);
  const char **outs = p_get_ports(c, pattern, JACK_AUDIO_TYPE, JACK_PORT_IS_OUTPUT);
  const char **ins = p_get_ports(c, pattern, JACK_AUDIO_TYPE, JACK_PORT_IS_INPUT);
  const char **midis = p_get_ports(c, pattern, JACK_MIDI_TYPE, JACK_PORT_IS_INPUT);
  if (g_out == NULL || g_midi == NULL || outs == NULL) {
    fprintf(stderr, "%s has no audio output\n", argv[1]);
    p_client_close(c);
    return 2;
  }
  for (int i = 0; outs[i] != NULL && g_inputs < MAX_PORTS; i++) {
    char name[32];
    snprintf(name, sizeof name, "in_%d", g_inputs + 1);
    g_in[g_inputs] = p_port_register(c, name, JACK_AUDIO_TYPE, JACK_PORT_IS_INPUT, 0);
    if (g_in[g_inputs] != NULL) g_inputs++;
  }
  p_set_process(c, on_process, NULL);
  p_set_xrun(c, on_xrun, NULL);
  if (p_activate(c) != 0) {
    fprintf(stderr, "could not activate\n");
    p_client_close(c);
    return 2;
  }
  for (int i = 0; ins != NULL && ins[i] != NULL; i++) p_connect(c, p_port_name(g_out), ins[i]);
  int midi_linked = 0;
  for (int i = 0; midis != NULL && midis[i] != NULL; i++)
    if (p_connect(c, p_port_name(g_midi), midis[i]) == 0) midi_linked++;
  for (int i = 0; i < g_inputs; i++) p_connect(c, outs[i], p_port_name(g_in[i]));
  long ms = atol(argv[2]);
  long part = ms / NOTE_COUNT;
  struct timespec step = {part / 1000, (part % 1000) * 1000000L};
  for (int n = 1; n <= NOTE_COUNT; n++) {
    atomic_store(&g_notes_due, n);
    nanosleep(&step, NULL);
  }
  struct latency_range range = {0, 0};
  p_latency_range(p_port_by_name(c, outs[0]), JACK_CAPTURE_LATENCY, &range);
  float peak = g_peak;
  printf("{\"latencyFrames\":%u,\"xruns\":%d,\"finite\":%s,\"silent\":%s,\"midiInputsLinked\":%d}\n", range.max, atomic_load(&g_xruns),
         atomic_load(&g_nonfinite) ? "false" : "true", peak < SILENCE_PEAK ? "true" : "false", midi_linked);
  p_free(outs);
  if (ins != NULL) p_free(ins);
  if (midis != NULL) p_free(midis);
  p_client_close(c);
  return 0;
}
