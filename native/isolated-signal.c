/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com> */
/* The isolated step's signal (plugin-qualify#249): a sine into every audio input of a JACK client, a note held on its MIDI
 * inputs for an instrument, and what comes out of its audio outputs over a window:
 *   isolated_signal <client> <ms>
 * prints one JSON line, {"latencyFrames":n,"xruns":n,"finite":bool,"silent":bool}. Exit 2 when the server or the client's
 * ports could not be had: nothing was learned about the plugin. */
#include <jack/jack.h>
#include <jack/midiport.h>
#include <math.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define MAX_PORTS 16
#define SINE_HZ 1000.0
#define SINE_PEAK 0.25f
#define SILENCE_PEAK 1e-5f
#define NOTE 60
#define NOTE_VELOCITY 100

static jack_port_t *g_out, *g_midi, *g_in[MAX_PORTS];
static int g_inputs;
static double g_phase, g_step;
static atomic_int g_xruns, g_note_sent, g_nonfinite;
static _Atomic float g_peak;

static int on_process(jack_nframes_t n, void *arg) {
  (void)arg;
  float *out = jack_port_get_buffer(g_out, n);
  for (jack_nframes_t i = 0; i < n; i++) {
    out[i] = SINE_PEAK * (float)sin(g_phase);
    g_phase += g_step;
    if (g_phase > 2.0 * M_PI) g_phase -= 2.0 * M_PI;
  }
  void *midi = jack_port_get_buffer(g_midi, n);
  jack_midi_clear_buffer(midi);
  if (!atomic_exchange(&g_note_sent, 1)) {
    unsigned char on[3] = {0x90, NOTE, NOTE_VELOCITY};
    jack_midi_event_write(midi, 0, on, sizeof on);
  }
  float peak = g_peak;
  for (int p = 0; p < g_inputs; p++) {
    const float *in = jack_port_get_buffer(g_in[p], n);
    for (jack_nframes_t i = 0; i < n; i++) {
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
  char pattern[256];
  snprintf(pattern, sizeof pattern, "^%s:", argv[1]);
  jack_client_t *c = jack_client_open("omx-isolated-signal", JackNoStartServer, NULL);
  if (c == NULL) {
    fprintf(stderr, "no JACK server\n");
    return 2;
  }
  g_step = 2.0 * M_PI * SINE_HZ / jack_get_sample_rate(c);
  g_out = jack_port_register(c, "out", JACK_DEFAULT_AUDIO_TYPE, JackPortIsOutput, 0);
  g_midi = jack_port_register(c, "midi", JACK_DEFAULT_MIDI_TYPE, JackPortIsOutput, 0);
  const char **outs = jack_get_ports(c, pattern, JACK_DEFAULT_AUDIO_TYPE, JackPortIsOutput);
  const char **ins = jack_get_ports(c, pattern, JACK_DEFAULT_AUDIO_TYPE, JackPortIsInput);
  const char **midis = jack_get_ports(c, pattern, JACK_DEFAULT_MIDI_TYPE, JackPortIsInput);
  if (g_out == NULL || g_midi == NULL || outs == NULL) {
    fprintf(stderr, "%s has no audio output\n", argv[1]);
    jack_client_close(c);
    return 2;
  }
  for (int i = 0; outs[i] != NULL && g_inputs < MAX_PORTS; i++) {
    char name[32];
    snprintf(name, sizeof name, "in_%d", g_inputs + 1);
    g_in[g_inputs] = jack_port_register(c, name, JACK_DEFAULT_AUDIO_TYPE, JackPortIsInput, 0);
    if (g_in[g_inputs] != NULL) g_inputs++;
  }
  jack_set_process_callback(c, on_process, NULL);
  jack_set_xrun_callback(c, on_xrun, NULL);
  if (jack_activate(c) != 0) {
    fprintf(stderr, "could not activate\n");
    jack_client_close(c);
    return 2;
  }
  for (int i = 0; ins != NULL && ins[i] != NULL; i++) jack_connect(c, jack_port_name(g_out), ins[i]);
  for (int i = 0; midis != NULL && midis[i] != NULL; i++) jack_connect(c, jack_port_name(g_midi), midis[i]);
  for (int i = 0; i < g_inputs; i++) jack_connect(c, outs[i], jack_port_name(g_in[i]));
  long ms = atol(argv[2]);
  struct timespec window = {ms / 1000, (ms % 1000) * 1000000L};
  nanosleep(&window, NULL);
  jack_latency_range_t range = {0, 0};
  jack_port_get_latency_range(jack_port_by_name(c, outs[0]), JackCaptureLatency, &range);
  float peak = g_peak;
  printf("{\"latencyFrames\":%u,\"xruns\":%d,\"finite\":%s,\"silent\":%s}\n", range.max, atomic_load(&g_xruns),
         atomic_load(&g_nonfinite) ? "false" : "true", peak < SILENCE_PEAK ? "true" : "false");
  jack_free(outs);
  if (ins != NULL) jack_free(ins);
  if (midis != NULL) jack_free(midis);
  jack_client_close(c);
  return 0;
}
