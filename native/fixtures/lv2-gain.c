// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * The LV2 measurer's fixture plugin: a mono gain with one control, built twice.
 *
 *   rt-safe.lv2    run() touches only its ports: the known RT-safe plugin.
 *   rt-unsafe.lv2  built with -DFIXTURE_ALLOCATES, run() also allocates and frees a scratch buffer
 *                  every block: the known RT-unsafe plugin.
 *
 * Nothing else differs but the URI, so a measurement that tells them apart is the interposer's count.
 */
#include <stdlib.h>
#include <string.h>

#include <lv2/core/lv2.h>

/* leaks.lv2: built with -DFIXTURE_LEAKS_KB, run() also takes that many KB every block and never gives them back.
 * large-activate.lv2: built with -DFIXTURE_ACTIVATE_MB, activate() takes that many MiB, touched, held until cleanup.
 * activate-reads.lv2: built with -DFIXTURE_ACTIVATE_READS, activate() reads its gain control, as swh's IIR filters
 * (lowpass_iir and its kin) read theirs: a host that activates before it connects the ports crashes it.
 * abi-breaker.lv2: built with -DFIXTURE_ABI_BREAKER, its third run() returns with callee-saved registers changed, as the
 * LSP limiters' did on a Raspberry Pi 5 (d15): in assembly, after the C run has returned, since no C function can.
 * needs-display.lv2: built with -DFIXTURE_NEEDS_DISPLAY, instantiate() aborts when no display and no Qt platform is
 * named, as a Qt plugin does (synthv1, samplv1, padthv1, drumkv1: "no Qt platform plugin could be initialized"). */
#if defined FIXTURE_LEAKS_KB
#define FIXTURE_URI "urn:plugin-qualify:fixture:lv2-leaks"
#elif defined FIXTURE_ACTIVATE_MB
#define FIXTURE_URI "urn:plugin-qualify:fixture:lv2-large-activate"
#elif defined FIXTURE_ACTIVATE_READS
#define FIXTURE_URI "urn:plugin-qualify:fixture:lv2-activate-reads"
#elif defined FIXTURE_ABI_BREAKER
#define FIXTURE_URI "urn:plugin-qualify:fixture:lv2-abi-breaker"
#elif defined FIXTURE_NEEDS_DISPLAY
#define FIXTURE_URI "urn:plugin-qualify:fixture:lv2-needs-display"
#elif defined FIXTURE_SPACED
#define FIXTURE_URI "urn:plugin-qualify:fixture:lv2-spaced"
#elif defined FIXTURE_ALLOCATES
#define FIXTURE_URI "urn:plugin-qualify:fixture:lv2-rt-unsafe"
/* through a volatile pointer, so the compiler cannot pair the malloc with the free and drop both */
static void *(*volatile fixture_malloc)(size_t) = malloc;
static void (*volatile fixture_free)(void *) = free;
#else
#define FIXTURE_URI "urn:plugin-qualify:fixture:lv2-rt-safe"
#endif

enum { PORT_GAIN, PORT_IN, PORT_OUT };

struct gain {
  const float *gain;
  const float *in;
  float *out;
#ifdef FIXTURE_ACTIVATE_MB
  char *held;
#endif
};

static LV2_Handle instantiate(const LV2_Descriptor *d, double rate, const char *path, const LV2_Feature *const *features) {
  (void)d; (void)rate; (void)path; (void)features;
#ifdef FIXTURE_NEEDS_DISPLAY
  if (getenv("QT_QPA_PLATFORM") == NULL && getenv("DISPLAY") == NULL && getenv("WAYLAND_DISPLAY") == NULL) abort();
#endif
  return calloc(1, sizeof(struct gain));
}

static void connect_port(LV2_Handle h, uint32_t port, void *data) {
  struct gain *g = h;
  switch (port) {
  case PORT_GAIN: g->gain = data; break;
  case PORT_IN: g->in = data; break;
  case PORT_OUT: g->out = data; break;
  default: break;
  }
}

static void activate(LV2_Handle h) {
  (void)h;
#ifdef FIXTURE_ACTIVATE_READS
  static volatile float read_at_activate;
  read_at_activate = *((struct gain *)h)->gain;
  (void)read_at_activate;
#endif
#ifdef FIXTURE_ACTIVATE_MB
  const size_t bytes = (size_t)FIXTURE_ACTIVATE_MB << 20;
  char *block = malloc(bytes);
  if (block != NULL) memset(block, 1, bytes);
  *(char *volatile *)&((struct gain *)h)->held = block;
#endif
}

static void run(LV2_Handle h, uint32_t frames) {
  struct gain *g = h;
#ifdef FIXTURE_LEAKS_KB
  /* touched through a volatile pointer and kept in a static: a compiler may drop a memset into memory nothing reads, and
   * the leak is then never resident (gcc 13 on Ubuntu 24.04 did) */
  static char *volatile leaked;
  volatile char *leak = malloc((size_t)FIXTURE_LEAKS_KB << 10);
  if (leak != NULL) {
    for (size_t i = 0; i < ((size_t)FIXTURE_LEAKS_KB << 10); i += 1024) leak[i] = 1;
    leaked = (char *)leak;
    (void)leaked;
  }
#endif
#ifdef FIXTURE_ALLOCATES
  fixture_free(fixture_malloc(frames * sizeof(float)));
#endif
  const float k = *g->gain;
  for (uint32_t i = 0; i < frames; i++) g->out[i] = g->in[i] * k;
}

static void deactivate(LV2_Handle h) { (void)h; }
static void cleanup(LV2_Handle h) { free(h); }
static const void *extension_data(const char *uri) { (void)uri; return NULL; }

#ifdef FIXTURE_ABI_BREAKER
__attribute__((visibility("hidden"))) int fixture_abi_break;
__attribute__((visibility("hidden"))) void fixture_run_c(LV2_Handle h, uint32_t frames);
void fixture_run_breaking(LV2_Handle h, uint32_t frames);
void fixture_run_c(LV2_Handle h, uint32_t frames) {
  static unsigned calls;
  run(h, frames);
  fixture_abi_break = ++calls == 3;
}
#if defined(__aarch64__)
__asm__(".text\n.p2align 2\n.hidden fixture_run_breaking\n.globl fixture_run_breaking\nfixture_run_breaking:\n"
        " stp x29, x30, [sp, #-16]!\n mov x29, sp\n bl fixture_run_c\n ldp x29, x30, [sp], #16\n"
        " adrp x9, fixture_abi_break\n ldr w9, [x9, :lo12:fixture_abi_break]\n cbz w9, 1f\n"
        " mov x10, #0x7ead\n mov x19, x10\n fmov d15, x10\n1: ret\n");
#elif defined(__x86_64__)
__asm__(".text\n.p2align 4\n.hidden fixture_run_breaking\n.globl fixture_run_breaking\nfixture_run_breaking:\n"
        " subq $8, %rsp\n call fixture_run_c\n addq $8, %rsp\n cmpl $0, fixture_abi_break(%rip)\n je 1f\n"
        " movq $0x7ead, %rbx\n movq $0x7ead, %r15\n1: ret\n");
#endif
#define FIXTURE_RUN fixture_run_breaking
#else
#define FIXTURE_RUN run
#endif

static const LV2_Descriptor descriptor = {
  FIXTURE_URI, instantiate, connect_port, activate, FIXTURE_RUN, deactivate, cleanup, extension_data,
};

LV2_SYMBOL_EXPORT const LV2_Descriptor *lv2_descriptor(uint32_t index) { return index == 0 ? &descriptor : NULL; }
