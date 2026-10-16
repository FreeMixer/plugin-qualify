# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
#
# The CLAP prober, the LV2 measurer, the interposer both run under and the fixture plugins their tests
# qualify.
#
#   make -C native           build/clap-qualify, build/lv2_measure, build/lv2_host_probe, build/rt_interpose.so,
#                            build/fixtures/{rt-safe,rt-unsafe,controls,params-2048,params-2049,info-fails,leaky-delay,undeclared-delay}.clap,
#                            build/fixtures/{synth,synth-alloc,synth-midi}.clap,
#                            build/fixtures/fail-alloc.so,
#                            build/fixtures/lv2/{rt-safe,rt-unsafe,host-faithfulness}.lv2
#   build/lv2_measure_options_test    the measurer's feature options oracle
#   make -C native asan      build/asan/lv2_measure, the measurer under AddressSanitizer, for the tests'
#                            leak check; never installed, and not in `all` (Fedora's gcc lacks libasan)
#   make -C native deps      fetch the CLAP and plugin-hostd headers at the pinned tags into deps/, the
#                            omx-contract header the LV2 measurer reads its rates from, and omx-clap-core's
#                            LV2 feature provider (libomx-clap-lv2), built and installed into deps/
#   make -C native install DESTDIR=... LIBEXECDIR=...   the prober, the measurer, the interposer and the LV2 host
#                            probe, for a package
#
# The CLAP headers come from `pkg-config clap` (Fedora clap-devel), else deps/clap; plugin-hostd's pin
# header from `pkg-config plugin-hostd` (plugin-hostd-devel), else deps/plugin-hostd. omx-contract's limits
# header from `pkg-config omx-contract` (omx-contract-devel, libomx-contract-dev), else deps/omx-contract. lilv and the LV2
# headers from `pkg-config lilv-0` (lilv-devel, liblilv-dev). The LV2 measurer's host features are omx-clap-core's
# provider, `pkg-config omx-clap-lv2` (omx-clap-lv2-devel, libomx-clap-lv2-dev), else deps/omx-clap-lv2.

CC ?= cc
PKG_CONFIG ?= pkg-config
BUILD ?= build

CLAP_REF := 1.2.6
PLUGIN_HOSTD_REF := v0.1.4
# the omx-contract `make deps` fetches where no omx-contract-devel is installed: the packages' floor, so the build
# reads the contract the packages do.
OMX_CONTRACT_VERSION := 2.10.1
# the omx-clap-core whose LV2 feature provider `make deps` builds where no omx-clap-lv2-devel is installed: the
# packages' floor
OMX_CLAP_CORE_VERSION := 0.8.0
# the omx-dsp headers the measurers (omx_lin_to_db_d) and omx-clap-core's provider read: the packages' floor
OMX_DSP_VERSION := 0.21.0

ifeq ($(shell $(PKG_CONFIG) --exists clap && echo true),true)
CLAP_CFLAGS ?= $(shell $(PKG_CONFIG) --cflags clap)
else
CLAP_CFLAGS ?= -Ideps/clap/include
endif
ifeq ($(shell $(PKG_CONFIG) --exists plugin-hostd && echo true),true)
PLUGIN_HOSTD_CFLAGS ?= $(shell $(PKG_CONFIG) --cflags plugin-hostd)
else
PLUGIN_HOSTD_CFLAGS ?= -Ideps/plugin-hostd/include
endif

# the measurer's rates are omx-contract's OMX_DECLARED_RATES, from <omxcontract/omx_contract_limits.h>
ifeq ($(shell $(PKG_CONFIG) --exists omx-contract && echo true),true)
OMX_CONTRACT_CFLAGS ?= $(shell $(PKG_CONFIG) --cflags omx-contract)
else
OMX_CONTRACT_CFLAGS ?= -Ideps/omx-contract/include
endif

# omx-dsp's headers, the level conversions the measurers call (omx_lin_to_db_d): the installed omx-dsp-devel /
# libomxdsp-dev, else the headers `make deps` fetches
ifeq ($(shell $(PKG_CONFIG) --exists omxdsp && echo true),true)
OMX_DSP_CFLAGS ?= $(shell $(PKG_CONFIG) --cflags omxdsp)
else
OMX_DSP_CFLAGS ?= -Ideps/omx-dsp/include
endif

# the LV2 host features: <omx-clap-lv2/omx_lv2_features.h> and the static libomx-clap-lv2
ifeq ($(shell $(PKG_CONFIG) --exists omx-clap-lv2 && echo true),true)
OMX_CLAP_LV2_CFLAGS ?= $(shell $(PKG_CONFIG) --cflags omx-clap-lv2)
OMX_CLAP_LV2_LIBS ?= $(shell $(PKG_CONFIG) --libs omx-clap-lv2)
else
OMX_CLAP_LV2_CFLAGS ?= -Ideps/omx-clap-lv2/include
OMX_CLAP_LV2_LIBS ?= deps/omx-clap-lv2/lib/libomx-clap-lv2.a -ldl -lpthread -lm
endif

LILV_CFLAGS ?= $(shell $(PKG_CONFIG) --cflags lilv-0)
LILV_LIBS ?= $(shell $(PKG_CONFIG) --libs lilv-0)
LV2_CFLAGS ?= $(shell $(PKG_CONFIG) --cflags lv2 2>/dev/null)

LIBEXECDIR ?= /usr/libexec/plugin-qualify

CFLAGS ?= -O2 -g
CFLAGS += -std=gnu11 -Wall -Wextra -Werror=implicit-function-declaration -Werror=return-type


all: $(BUILD)/clap-qualify $(BUILD)/lv2_measure $(BUILD)/lv2_host_probe $(BUILD)/lv2_measure_options_test $(BUILD)/rt_interpose.so $(BUILD)/fixtures/rt-safe.clap $(BUILD)/fixtures/rt-unsafe.clap \
	$(BUILD)/fixtures/controls.clap $(BUILD)/fixtures/params-2048.clap $(BUILD)/fixtures/params-2049.clap \
	$(BUILD)/fixtures/info-fails.clap $(BUILD)/fixtures/leaky-delay.clap $(BUILD)/fixtures/undeclared-delay.clap \
	$(BUILD)/fixtures/synth.clap $(BUILD)/fixtures/synth-alloc.clap $(BUILD)/fixtures/synth-midi.clap \
	$(BUILD)/fixtures/fail-alloc.so \
	$(BUILD)/fixtures/lv2/rt-safe.lv2/gain.so $(BUILD)/fixtures/lv2/rt-unsafe.lv2/gain.so \
	$(BUILD)/fixtures/lv2/host-faithfulness.lv2/host-faithfulness.so

$(BUILD) $(BUILD)/fixtures:
	mkdir -p $@

# -rdynamic is not needed: the interposer's symbols are found through the preload, never exported by the prober
$(BUILD)/clap-qualify: clap-qualify.c rt-interpose.h | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) $(CLAP_CFLAGS) $(PLUGIN_HOSTD_CFLAGS) $(LDFLAGS) -o $@ $< -ldl -lm

LV2_MEASURE_SRC := lv2-measure.c lv2-measure-options.c lv2-measure-pin.c
LV2_MEASURE_HDR := lv2-measure-options.h lv2-measure-pin.h rt-interpose.h

# as openmixer built it: no FMA contraction, so a figure is the same on every architecture and compiler
$(BUILD)/lv2_measure: $(LV2_MEASURE_SRC) $(LV2_MEASURE_HDR) | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) -ffp-contract=off $(OMX_CONTRACT_CFLAGS) $(OMX_DSP_CFLAGS) $(PLUGIN_HOSTD_CFLAGS) $(OMX_CLAP_LV2_CFLAGS) $(LILV_CFLAGS) \
		$(LDFLAGS) -o $@ $(LV2_MEASURE_SRC) $(OMX_CLAP_LV2_LIBS) $(LILV_LIBS) -lpthread -lm -ldl

# the same, under AddressSanitizer: the leak check runs it on every way out of main
asan: $(BUILD)/asan/lv2_measure

$(BUILD)/asan/lv2_measure: $(LV2_MEASURE_SRC) $(LV2_MEASURE_HDR) | $(BUILD)
	mkdir -p $(@D)
	$(CC) $(CPPFLAGS) $(CFLAGS) -fsanitize=address -fno-omit-frame-pointer -ffp-contract=off $(OMX_CONTRACT_CFLAGS) $(OMX_DSP_CFLAGS) $(PLUGIN_HOSTD_CFLAGS) \
		$(OMX_CLAP_LV2_CFLAGS) $(LILV_CFLAGS) $(LDFLAGS) -o $@ $(LV2_MEASURE_SRC) $(OMX_CLAP_LV2_LIBS) $(LILV_LIBS) -lpthread -lm -ldl

# the feature options' oracle, never installed
$(BUILD)/lv2_measure_options_test: lv2_measure_options.test.c lv2-measure-options.c lv2-measure-options.h | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) -Werror $(OMX_CLAP_LV2_CFLAGS) $(LV2_CFLAGS) -I. $(LDFLAGS) -o $@ lv2_measure_options.test.c \
		lv2-measure-options.c $(OMX_CLAP_LV2_LIBS) -ldl -lpthread

$(BUILD)/lv2_host_probe: lv2-host-probe.c | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) $(OMX_CONTRACT_CFLAGS) $(OMX_DSP_CFLAGS) $(LILV_CFLAGS) $(LDFLAGS) -o $@ $< $(LILV_LIBS) -lpthread -lm

$(BUILD)/rt_interpose.so: rt-interpose.c rt-interpose.h | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) $(LDFLAGS) -shared -fPIC -o $@ $< -ldl -lpthread

$(BUILD)/fixtures/rt-safe.clap: fixtures/gain.c | $(BUILD)/fixtures
	$(CC) $(CPPFLAGS) $(CFLAGS) $(CLAP_CFLAGS) -shared -fPIC -fvisibility=hidden $(LDFLAGS) -o $@ $<

$(BUILD)/fixtures/rt-unsafe.clap: fixtures/gain.c | $(BUILD)/fixtures
	$(CC) $(CPPFLAGS) $(CFLAGS) $(CLAP_CFLAGS) -DFIXTURE_ALLOCATES -shared -fPIC -fvisibility=hidden $(LDFLAGS) -o $@ $<

# the host's parameter cap and one past it
$(BUILD)/fixtures/params-%.clap: fixtures/gain.c | $(BUILD)/fixtures
	$(CC) $(CPPFLAGS) $(CFLAGS) $(CLAP_CFLAGS) -DFIXTURE_PARAMS=$* -shared -fPIC -fvisibility=hidden $(LDFLAGS) -o $@ $<

$(BUILD)/fixtures/info-fails.clap: fixtures/gain.c | $(BUILD)/fixtures
	$(CC) $(CPPFLAGS) $(CFLAGS) $(CLAP_CFLAGS) -DFIXTURE_INFO_FAILS -shared -fPIC -fvisibility=hidden $(LDFLAGS) -o $@ $<

# a whole-frame delay read the way omx-pitch lands it at 44.1 kHz, declared and not
FIXTURE_DELAY = 883
$(BUILD)/fixtures/leaky-delay.clap: fixtures/gain.c | $(BUILD)/fixtures
	$(CC) $(CPPFLAGS) $(CFLAGS) $(CLAP_CFLAGS) -DFIXTURE_DELAY=$(FIXTURE_DELAY) -shared -fPIC -fvisibility=hidden $(LDFLAGS) -o $@ $<

$(BUILD)/fixtures/undeclared-delay.clap: fixtures/gain.c | $(BUILD)/fixtures
	$(CC) $(CPPFLAGS) $(CFLAGS) $(CLAP_CFLAGS) -DFIXTURE_DELAY=$(FIXTURE_DELAY) -DFIXTURE_UNDECLARED -shared -fPIC -fvisibility=hidden $(LDFLAGS) -o $@ $<

# the instrument the note sweep plays: clean, allocating on note on, and reading MIDI's dialect alone
$(BUILD)/fixtures/synth.clap: fixtures/synth.c | $(BUILD)/fixtures
	$(CC) $(CPPFLAGS) $(CFLAGS) $(CLAP_CFLAGS) -shared -fPIC -fvisibility=hidden $(LDFLAGS) -o $@ $< -lm
$(BUILD)/fixtures/synth-alloc.clap: fixtures/synth.c | $(BUILD)/fixtures
	$(CC) $(CPPFLAGS) $(CFLAGS) $(CLAP_CFLAGS) -DFIXTURE_ALLOCATES_ON_NOTE -shared -fPIC -fvisibility=hidden $(LDFLAGS) -o $@ $< -lm
$(BUILD)/fixtures/synth-midi.clap: fixtures/synth.c | $(BUILD)/fixtures
	$(CC) $(CPPFLAGS) $(CFLAGS) $(CLAP_CFLAGS) -DFIXTURE_MIDI_ONLY -shared -fPIC -fvisibility=hidden $(LDFLAGS) -o $@ $< -lm
# a preload failing one chosen allocation, for the prober's out-of-memory paths
$(BUILD)/fixtures/fail-alloc.so: fixtures/fail-alloc.c | $(BUILD)/fixtures
	$(CC) $(CPPFLAGS) $(CFLAGS) -shared -fPIC -fvisibility=hidden $(LDFLAGS) -o $@ $<

$(BUILD)/fixtures/controls.clap: fixtures/controls.c | $(BUILD)/fixtures
	$(CC) $(CPPFLAGS) $(CFLAGS) $(CLAP_CFLAGS) -shared -fPIC -fvisibility=hidden $(LDFLAGS) -o $@ $<

# an LV2 fixture is its bundle: the turtle copied beside the shared object it names
$(BUILD)/fixtures/lv2/rt-safe.lv2/gain.so: fixtures/lv2-gain.c fixtures/rt-safe.lv2/manifest.ttl fixtures/rt-safe.lv2/gain.ttl
	mkdir -p $(@D)
	cp fixtures/rt-safe.lv2/manifest.ttl fixtures/rt-safe.lv2/gain.ttl $(@D)/
	$(CC) $(CPPFLAGS) $(CFLAGS) $(LV2_CFLAGS) -shared -fPIC -fvisibility=hidden $(LDFLAGS) -o $@ $<

$(BUILD)/fixtures/lv2/rt-unsafe.lv2/gain.so: fixtures/lv2-gain.c fixtures/rt-unsafe.lv2/manifest.ttl fixtures/rt-unsafe.lv2/gain.ttl
	mkdir -p $(@D)
	cp fixtures/rt-unsafe.lv2/manifest.ttl fixtures/rt-unsafe.lv2/gain.ttl $(@D)/
	$(CC) $(CPPFLAGS) $(CFLAGS) $(LV2_CFLAGS) -DFIXTURE_ALLOCATES -shared -fPIC -fvisibility=hidden $(LDFLAGS) -o $@ $<

# five plugins, each demanding one thing of the measuring host: options, a worker, patch:Set, a
# bounded sweep, a stdout of its own
$(BUILD)/fixtures/lv2/host-faithfulness.lv2/host-faithfulness.so: fixtures/lv2-host-faithfulness.c \
		fixtures/host-faithfulness.lv2/manifest.ttl fixtures/host-faithfulness.lv2/host-faithfulness.ttl
	mkdir -p $(@D)
	cp fixtures/host-faithfulness.lv2/manifest.ttl fixtures/host-faithfulness.lv2/host-faithfulness.ttl $(@D)/
	$(CC) $(CPPFLAGS) $(CFLAGS) $(LV2_CFLAGS) -shared -fPIC -fvisibility=hidden $(LDFLAGS) -o $@ $<

deps:
	./fetch-deps.sh deps $(CLAP_REF) $(PLUGIN_HOSTD_REF) $(OMX_CONTRACT_VERSION) $(OMX_CLAP_CORE_VERSION) $(OMX_DSP_VERSION)

# the fixtures are the tests' own, never installed; the interposer is executable so rpm strips it (dh_fixperms clears the bit)
# exactly src/qualify-declarations.ts's NATIVE_TOOLS (src/native-install-dirs.test.ts holds the two together)
install: $(BUILD)/clap-qualify $(BUILD)/lv2_measure $(BUILD)/rt_interpose.so $(BUILD)/lv2_host_probe
	install -d $(DESTDIR)$(LIBEXECDIR)
	install -m 0755 $(BUILD)/clap-qualify $(DESTDIR)$(LIBEXECDIR)/clap-qualify
	install -m 0755 $(BUILD)/lv2_measure $(DESTDIR)$(LIBEXECDIR)/lv2_measure
	install -m 0755 $(BUILD)/rt_interpose.so $(DESTDIR)$(LIBEXECDIR)/rt_interpose.so
	install -m 0755 $(BUILD)/lv2_host_probe $(DESTDIR)$(LIBEXECDIR)/lv2_host_probe

clean:
	rm -rf $(BUILD)

.PHONY: all asan deps install clean
