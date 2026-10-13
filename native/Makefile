# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
#
# The CLAP prober, the LV2 measurer, the interposer both run under and the fixture plugins their tests
# qualify.
#
#   make -C native           build/clap-qualify, build/lv2_measure, build/lv2_host_probe, build/rt_interpose.so,
#                            build/fixtures/{rt-safe,rt-unsafe,controls}.clap,
#                            build/fixtures/lv2/{rt-safe,rt-unsafe,host-faithfulness}.lv2
#   build/lv2_measure_features_test   the measurer's features oracle, run from native/
#   make -C native asan      build/asan/lv2_measure, the measurer under AddressSanitizer, for the tests'
#                            leak check; never installed, and not in `all` (Fedora's gcc lacks libasan)
#   make -C native deps      fetch the CLAP and plugin-hostd headers at the pinned tags into deps/, and
#                            the omx-contract header openmixer's LV2 measurer reads
#   build/parity/lv2_measure openmixer's LV2 measurer (parity/openmixer, kept as it was there), built with
#                            these flags when deps/ holds that header: the parity test runs it beside ours
#   make -C native install DESTDIR=... LIBEXECDIR=...   the prober, the measurer and the interposer, for a package
#
# The CLAP headers come from `pkg-config clap` (Fedora clap-devel), else deps/clap; plugin-hostd's pin
# header from `pkg-config plugin-hostd` (plugin-hostd-devel), else deps/plugin-hostd. lilv and the LV2
# headers from `pkg-config lilv-0` (lilv-devel, liblilv-dev).

CC ?= cc
PKG_CONFIG ?= pkg-config
BUILD ?= build

CLAP_REF := 1.2.6
PLUGIN_HOSTD_REF := v0.1.4
# the omx-contract openmixer's LV2 measurer built against at the commit it was taken from (parity/openmixer/BLOBS)
OMX_CONTRACT_VERSION := 2.3.0

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

LILV_CFLAGS ?= $(shell $(PKG_CONFIG) --cflags lilv-0)
LILV_LIBS ?= $(shell $(PKG_CONFIG) --libs lilv-0)
LV2_CFLAGS ?= $(shell $(PKG_CONFIG) --cflags lv2 2>/dev/null)

LIBEXECDIR ?= /usr/libexec/plugin-qualify

CFLAGS ?= -O2 -g
CFLAGS += -std=gnu11 -Wall -Wextra -Werror=implicit-function-declaration -Werror=return-type


all: $(BUILD)/clap-qualify $(BUILD)/lv2_measure $(BUILD)/lv2_host_probe $(BUILD)/lv2_measure_features_test $(BUILD)/rt_interpose.so $(BUILD)/fixtures/rt-safe.clap $(BUILD)/fixtures/rt-unsafe.clap \
	$(BUILD)/fixtures/controls.clap $(BUILD)/fixtures/lv2/rt-safe.lv2/gain.so $(BUILD)/fixtures/lv2/rt-unsafe.lv2/gain.so \
	$(BUILD)/fixtures/lv2/host-faithfulness.lv2/host-faithfulness.so
	@# asked when the recipe runs, so `make deps all` builds it from what deps just fetched
	@if [ -f deps/omx-contract/include/omxcontract/omx_contract_limits.h ]; then $(MAKE) --no-print-directory $(BUILD)/parity/lv2_measure; fi

$(BUILD) $(BUILD)/fixtures:
	mkdir -p $@

# -rdynamic is not needed: the interposer's symbols are found through the preload, never exported by the prober
$(BUILD)/clap-qualify: clap-qualify.c rt-interpose.h | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) $(CLAP_CFLAGS) $(PLUGIN_HOSTD_CFLAGS) $(LDFLAGS) -o $@ $< -ldl -lm

LV2_MEASURE_SRC := lv2-measure.c lv2-measure-features.c lv2-measure-pin.c
LV2_MEASURE_HDR := lv2-measure-features.h lv2-measure-pin.h lv2-measure-rates.h rt-interpose.h

# as openmixer built it: no FMA contraction, so a figure is the same on every architecture and compiler
$(BUILD)/lv2_measure: $(LV2_MEASURE_SRC) $(LV2_MEASURE_HDR) | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) -ffp-contract=off $(PLUGIN_HOSTD_CFLAGS) $(LILV_CFLAGS) $(LDFLAGS) -o $@ $(LV2_MEASURE_SRC) \
		$(LILV_LIBS) -lpthread -lm -ldl

# the same, under AddressSanitizer: the leak check runs it on every way out of main
asan: $(BUILD)/asan/lv2_measure

$(BUILD)/asan/lv2_measure: $(LV2_MEASURE_SRC) $(LV2_MEASURE_HDR) | $(BUILD)
	mkdir -p $(@D)
	$(CC) $(CPPFLAGS) $(CFLAGS) -fsanitize=address -fno-omit-frame-pointer -ffp-contract=off $(PLUGIN_HOSTD_CFLAGS) $(LILV_CFLAGS) \
		$(LDFLAGS) -o $@ $(LV2_MEASURE_SRC) $(LILV_LIBS) -lpthread -lm -ldl

# the features' oracle, never installed; it opens the fixtures by these paths, run from native/
$(BUILD)/lv2_measure_features_test: lv2_measure_features.test.c lv2-measure-features.c lv2-measure-features.h | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) -Werror $(LILV_CFLAGS) -I. '-DTEST_LV2_SO="$(BUILD)/fixtures/lv2/rt-safe.lv2/gain.so"' \
		'-DTEST_LV2_URI="urn:plugin-qualify:fixture:lv2-rt-safe"' '-DTEST_CLAP="$(BUILD)/fixtures/rt-safe.clap"' \
		$(LDFLAGS) -o $@ lv2_measure_features.test.c lv2-measure-features.c -ldl -lpthread

# named lv2_measure too: the measurer leaves frames of its own binary, by that name, out of an event's owner
$(BUILD)/parity/lv2_measure: $(addprefix parity/openmixer/,$(LV2_MEASURE_SRC)) parity/omx_console_limits.h | $(BUILD)
	mkdir -p $(@D)
	$(CC) $(CPPFLAGS) $(CFLAGS) -ffp-contract=off -Iparity -Ideps/omx-contract/include $(PLUGIN_HOSTD_CFLAGS) \
		$(LILV_CFLAGS) $(LDFLAGS) -o $@ $(addprefix parity/openmixer/,$(LV2_MEASURE_SRC)) $(LILV_LIBS) -lpthread -lm -ldl

$(BUILD)/lv2_host_probe: lv2-host-probe.c | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) $(LILV_CFLAGS) $(LDFLAGS) -o $@ $< $(LILV_LIBS) -lpthread -lm

$(BUILD)/rt_interpose.so: rt-interpose.c rt-interpose.h | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) $(LDFLAGS) -shared -fPIC -o $@ $< -ldl -lpthread

$(BUILD)/fixtures/rt-safe.clap: fixtures/gain.c | $(BUILD)/fixtures
	$(CC) $(CPPFLAGS) $(CFLAGS) $(CLAP_CFLAGS) -shared -fPIC -fvisibility=hidden $(LDFLAGS) -o $@ $<

$(BUILD)/fixtures/rt-unsafe.clap: fixtures/gain.c | $(BUILD)/fixtures
	$(CC) $(CPPFLAGS) $(CFLAGS) $(CLAP_CFLAGS) -DFIXTURE_ALLOCATES -shared -fPIC -fvisibility=hidden $(LDFLAGS) -o $@ $<

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
	./fetch-deps.sh deps $(CLAP_REF) $(PLUGIN_HOSTD_REF) $(OMX_CONTRACT_VERSION)

# the fixtures are the tests' own, never installed; the interposer is executable so rpm strips it (dh_fixperms clears the bit)
# exactly src/qualify-declarations.ts's NATIVE_TOOLS (src/native-install-dirs.test.ts holds the two together)
install: $(BUILD)/clap-qualify $(BUILD)/lv2_measure $(BUILD)/rt_interpose.so
	install -d $(DESTDIR)$(LIBEXECDIR)
	install -m 0755 $(BUILD)/clap-qualify $(DESTDIR)$(LIBEXECDIR)/clap-qualify
	install -m 0755 $(BUILD)/lv2_measure $(DESTDIR)$(LIBEXECDIR)/lv2_measure
	install -m 0755 $(BUILD)/rt_interpose.so $(DESTDIR)$(LIBEXECDIR)/rt_interpose.so

clean:
	rm -rf $(BUILD)

.PHONY: all asan deps install clean
