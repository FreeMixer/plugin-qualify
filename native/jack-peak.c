/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
 *
 * jack-peak: the peak on JACK output ports over a window. The adapter run plays an instrument a note and reads what comes
 * out here (tools/mod-host-admit.mjs), since a plugin that runs and takes notes can still give nothing.
 *
 *   jack_peak <client:port> ...
 *
 * It links each port to an input of its own and prints "ready" once they are linked. The window ends when its standard
 * input closes, and it prints {"peak":<largest magnitude, linear>,"frames":<frames read>}. Exit 0; 1 with the reason on
 * stderr when JACK or a port cannot be had, and no server is ever started. libjack is opened at run time: it is on every
 * machine with a JACK server and nowhere else this package runs, and nothing else here needs it.
 */
#include <dlfcn.h>
#include <math.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#define MAX_PORTS 64
/* a window longer than any caller's: a caller that went away never leaves a client on the server */
#define DEADLINE_S 30u
#define JACK_NO_START_SERVER 1
#define JACK_PORT_IS_INPUT 1ul
#define JACK_AUDIO_TYPE "32 bit float mono audio"

typedef struct client client_t;
typedef struct port port_t;
static client_t *(*p_client_open)(const char *, int, int *, ...);
static int (*p_client_close)(client_t *);
static int (*p_set_process)(client_t *, int (*)(uint32_t, void *), void *);
static int (*p_activate)(client_t *);
static port_t *(*p_port_register)(client_t *, const char *, const char *, unsigned long, unsigned long);
static void *(*p_port_buffer)(port_t *, uint32_t);
static int (*p_connect)(client_t *, const char *, const char *);
static const char *(*p_port_name)(const port_t *);

static port_t *g_in[MAX_PORTS];
static int g_ports;
static _Atomic float g_peak;
static _Atomic uint64_t g_frames;

/* [audio] the largest magnitude of every input this cycle; a NaN is not a level and is never the peak */
static int process(uint32_t n, void *arg)
{
  float peak = atomic_load_explicit(&g_peak, memory_order_relaxed);

  (void)arg;
  for (int k = 0; k < g_ports; k++) {
    const float *x = p_port_buffer(g_in[k], n);

    for (uint32_t i = 0; i < n; i++)
      if (fabsf(x[i]) > peak) peak = fabsf(x[i]);
  }
  atomic_store_explicit(&g_peak, peak, memory_order_relaxed);
  atomic_fetch_add_explicit(&g_frames, n, memory_order_relaxed);
  return 0;
}

static int refuse(const char *why, const char *what)
{
  fprintf(stderr, "jack_peak: %s%s%s\n", why, what ? ": " : "", what ? what : "");
  return 1;
}

int main(int argc, char **argv)
{
  void *lib;
  client_t *client;
  int status = 0;
  char byte;

  if (argc < 2 || argc - 1 > MAX_PORTS) return refuse("usage: jack_peak <client:port> ...", NULL);
  lib = dlopen("libjack.so.0", RTLD_NOW);
  if (!lib) return refuse("no libjack", dlerror());
  *(void **)&p_client_open = dlsym(lib, "jack_client_open");
  *(void **)&p_client_close = dlsym(lib, "jack_client_close");
  *(void **)&p_set_process = dlsym(lib, "jack_set_process_callback");
  *(void **)&p_activate = dlsym(lib, "jack_activate");
  *(void **)&p_port_register = dlsym(lib, "jack_port_register");
  *(void **)&p_port_buffer = dlsym(lib, "jack_port_get_buffer");
  *(void **)&p_connect = dlsym(lib, "jack_connect");
  *(void **)&p_port_name = dlsym(lib, "jack_port_name");
  if (!p_client_open || !p_client_close || !p_set_process || !p_activate || !p_port_register || !p_port_buffer || !p_connect || !p_port_name)
    return refuse("this libjack lacks a call", NULL);
  alarm(DEADLINE_S);
  client = p_client_open("jack_peak", JACK_NO_START_SERVER, &status);
  if (!client) return refuse("no JACK server", NULL);
  g_ports = argc - 1;
  for (int k = 0; k < g_ports; k++) {
    char name[32];

    snprintf(name, sizeof(name), "in_%d", k + 1);
    g_in[k] = p_port_register(client, name, JACK_AUDIO_TYPE, JACK_PORT_IS_INPUT, 0);
    if (!g_in[k]) return refuse("a port was refused", name);
  }
  p_set_process(client, process, NULL);
  if (p_activate(client) != 0) return refuse("the client did not activate", NULL);
  for (int k = 0; k < g_ports; k++)
    if (p_connect(client, argv[k + 1], p_port_name(g_in[k])) != 0) return refuse("no such port", argv[k + 1]);
  puts("ready");
  fflush(stdout);
  while (read(STDIN_FILENO, &byte, 1) > 0)
    ;
  printf("{\"peak\":%.9g,\"frames\":%llu}\n", (double)atomic_load_explicit(&g_peak, memory_order_relaxed),
         (unsigned long long)atomic_load_explicit(&g_frames, memory_order_relaxed));
  fflush(stdout);
  p_client_close(client);
  return 0;
}
