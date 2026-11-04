/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
 *
 * jack-compare: the JACK side of the host comparison (tools/compare-host.mjs), the same for every host.
 *
 *   jack_compare ports                    every port on the graph, as JSON: [{"name","input","type"}], type audio|midi|other
 *   jack_compare latency <client:port>    {"capture":[min,max],"playback":[min,max]} of that port, in frames
 *   jack_compare tone <client:port> ...   a 440 Hz sine at -12 dBFS into those audio inputs
 *   jack_compare notes <client:port> ...  notes into those MIDI inputs: keys 36 to 65 in turn, each held 250 ms
 *
 * tone and notes print "ready" once linked and run until their standard input closes. The notes are the keys the
 * adapter run plays (tools/mod-host-admit.mjs), since a drum kit answers only the keys it maps. Exit 0; 1 with the
 * reason on stderr. libjack is opened at run time and no server is ever started, as jack_peak does.
 */
#include <dlfcn.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MAX_PORTS 64
#define DEADLINE_S 3600u
#define JACK_NO_START_SERVER 1
#define JACK_PORT_IS_INPUT 1ul
#define JACK_PORT_IS_OUTPUT 2ul
#define JACK_AUDIO_TYPE "32 bit float mono audio"
#define JACK_MIDI_TYPE "8 bit raw midi"
#define JACK_CAPTURE_LATENCY 0
#define JACK_PLAYBACK_LATENCY 1
#define NOTE_FIRST 36
#define NOTE_COUNT 30
#define NOTE_VELOCITY 100

typedef struct client client_t;
typedef struct port port_t;
typedef struct { uint32_t min, max; } range_t;
static client_t *(*p_client_open)(const char *, int, int *, ...);
static int (*p_client_close)(client_t *);
static int (*p_set_process)(client_t *, int (*)(uint32_t, void *), void *);
static int (*p_activate)(client_t *);
static port_t *(*p_port_register)(client_t *, const char *, const char *, unsigned long, unsigned long);
static void *(*p_port_buffer)(port_t *, uint32_t);
static int (*p_connect)(client_t *, const char *, const char *);
static const char *(*p_port_name)(const port_t *);
static const char **(*p_get_ports)(client_t *, const char *, const char *, unsigned long);
static port_t *(*p_port_by_name)(client_t *, const char *);
static int (*p_port_flags)(const port_t *);
static const char *(*p_port_type)(const port_t *);
static void (*p_latency_range)(port_t *, int, range_t *);
static uint32_t (*p_sample_rate)(client_t *);
static void (*p_free)(void *);
static void (*p_midi_clear)(void *);
static int (*p_midi_write)(void *, uint32_t, const unsigned char *, size_t);

static port_t *g_out;
static int g_notes;
static double g_phase, g_step;
static uint64_t g_frame;
static uint32_t g_rate;

static int refuse(const char *why, const char *what)
{
  fprintf(stderr, "jack_compare: %s%s%s\n", why, what ? ": " : "", what ? what : "");
  return 1;
}

/* [audio] the tone, or the notes: one key at a time, on for 250 ms of each 300 */
static int process(uint32_t n, void *arg)
{
  (void)arg;
  if (!g_notes) {
    float *y = p_port_buffer(g_out, n);
    for (uint32_t i = 0; i < n; i++) {
      y[i] = (float)(0.25 * sin(g_phase));
      g_phase += g_step;
      if (g_phase > 2.0 * M_PI) g_phase -= 2.0 * M_PI;
    }
  } else {
    void *buf = p_port_buffer(g_out, n);
    uint64_t period = (uint64_t)g_rate * 3 / 10, held = (uint64_t)g_rate / 4;
    p_midi_clear(buf);
    for (uint32_t i = 0; i < n; i++) {
      uint64_t f = g_frame + i, at = f % period;
      unsigned char key = (unsigned char)(NOTE_FIRST + (f / period) % NOTE_COUNT);
      if (at == 0) {
        unsigned char on[3] = {0x90, key, NOTE_VELOCITY};
        p_midi_write(buf, i, on, 3);
      } else if (at == held) {
        unsigned char off[3] = {0x80, key, 0};
        p_midi_write(buf, i, off, 3);
      }
    }
  }
  g_frame += n;
  return 0;
}

static void json_string(const char *s)
{
  putchar('"');
  for (; *s; s++) {
    if (*s == '"' || *s == '\\') putchar('\\');
    if ((unsigned char)*s < 0x20) printf("\\u%04x", *s);
    else putchar(*s);
  }
  putchar('"');
}

int main(int argc, char **argv)
{
  void *lib;
  client_t *client;
  int status = 0;
  char byte;

  if (argc < 2) return refuse("usage: jack_compare ports | latency <port> | tone <port>... | notes <port>...", NULL);
  lib = dlopen("libjack.so.0", RTLD_NOW);
  if (!lib) return refuse("no libjack", dlerror());
#define SYM(p, n) *(void **)&p = dlsym(lib, n)
  SYM(p_client_open, "jack_client_open");
  SYM(p_client_close, "jack_client_close");
  SYM(p_set_process, "jack_set_process_callback");
  SYM(p_activate, "jack_activate");
  SYM(p_port_register, "jack_port_register");
  SYM(p_port_buffer, "jack_port_get_buffer");
  SYM(p_connect, "jack_connect");
  SYM(p_port_name, "jack_port_name");
  SYM(p_get_ports, "jack_get_ports");
  SYM(p_port_by_name, "jack_port_by_name");
  SYM(p_port_flags, "jack_port_flags");
  SYM(p_port_type, "jack_port_type");
  SYM(p_latency_range, "jack_port_get_latency_range");
  SYM(p_sample_rate, "jack_get_sample_rate");
  SYM(p_free, "jack_free");
  SYM(p_midi_clear, "jack_midi_clear_buffer");
  SYM(p_midi_write, "jack_midi_event_write");
  if (!p_client_open || !p_client_close || !p_set_process || !p_activate || !p_port_register || !p_port_buffer || !p_connect ||
      !p_port_name || !p_get_ports || !p_port_by_name || !p_port_flags || !p_port_type || !p_latency_range || !p_sample_rate ||
      !p_free || !p_midi_clear || !p_midi_write)
    return refuse("this libjack lacks a call", NULL);
  alarm(DEADLINE_S);
  client = p_client_open("jack_compare", JACK_NO_START_SERVER, &status);
  if (!client) return refuse("no JACK server", NULL);

  if (strcmp(argv[1], "ports") == 0) {
    const char **all = p_get_ports(client, NULL, NULL, 0);
    putchar('[');
    for (int i = 0; all && all[i]; i++) {
      port_t *p = p_port_by_name(client, all[i]);
      const char *t = p ? p_port_type(p) : "";
      printf("%s{\"name\":", i ? "," : "");
      json_string(all[i]);
      printf(",\"input\":%s,\"type\":\"%s\"}", p && (p_port_flags(p) & JACK_PORT_IS_INPUT) ? "true" : "false",
             strcmp(t, JACK_AUDIO_TYPE) == 0 ? "audio" : strcmp(t, JACK_MIDI_TYPE) == 0 ? "midi" : "other");
    }
    puts("]");
    if (all) p_free(all);
    p_client_close(client);
    return 0;
  }
  if (strcmp(argv[1], "latency") == 0) {
    port_t *p = argc == 3 ? p_port_by_name(client, argv[2]) : NULL;
    range_t c = {0, 0}, pb = {0, 0};
    if (!p) return refuse("no such port", argc == 3 ? argv[2] : "(none named)");
    p_latency_range(p, JACK_CAPTURE_LATENCY, &c);
    p_latency_range(p, JACK_PLAYBACK_LATENCY, &pb);
    printf("{\"capture\":[%u,%u],\"playback\":[%u,%u]}\n", c.min, c.max, pb.min, pb.max);
    p_client_close(client);
    return 0;
  }
  if (strcmp(argv[1], "tone") != 0 && strcmp(argv[1], "notes") != 0) return refuse("unknown mode", argv[1]);
  if (argc < 3 || argc - 2 > MAX_PORTS) return refuse("name the ports to feed", NULL);
  g_notes = strcmp(argv[1], "notes") == 0;
  g_rate = p_sample_rate(client);
  g_step = 2.0 * M_PI * 440.0 / (double)g_rate;
  g_out = p_port_register(client, "out", g_notes ? JACK_MIDI_TYPE : JACK_AUDIO_TYPE, JACK_PORT_IS_OUTPUT, 0);
  if (!g_out) return refuse("the port was refused", NULL);
  p_set_process(client, process, NULL);
  if (p_activate(client) != 0) return refuse("the client did not activate", NULL);
  for (int k = 2; k < argc; k++)
    if (p_connect(client, p_port_name(g_out), argv[k]) != 0) return refuse("no such port", argv[k]);
  puts("ready");
  fflush(stdout);
  while (read(STDIN_FILENO, &byte, 1) > 0)
    ;
  p_client_close(client);
  return 0;
}
