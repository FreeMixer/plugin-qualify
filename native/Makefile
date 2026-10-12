# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
#
# The CLAP prober, the interposer it runs under and the fixture plugins its tests qualify.
#
#   make -C native           build/clap-qualify, build/rt_interpose.so, build/fixtures/{rt-safe,rt-unsafe,controls}.clap
#   make -C native deps      fetch the CLAP and plugin-hostd headers at the pinned tags into deps/
#   make -C native install DESTDIR=... LIBEXECDIR=...   the prober and the interposer, for a package
#
# The CLAP headers come from `pkg-config clap` (Fedora clap-devel), else deps/clap; plugin-hostd's pin
# header from `pkg-config plugin-hostd` (plugin-hostd-devel), else deps/plugin-hostd.

CC ?= cc
PKG_CONFIG ?= pkg-config
BUILD ?= build

CLAP_REF := 1.2.6
PLUGIN_HOSTD_REF := v0.1.4

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

LIBEXECDIR ?= /usr/libexec/plugin-qualify

CFLAGS ?= -O2 -g
CFLAGS += -std=gnu11 -Wall -Wextra -Werror=implicit-function-declaration -Werror=return-type

all: $(BUILD)/clap-qualify $(BUILD)/rt_interpose.so $(BUILD)/fixtures/rt-safe.clap $(BUILD)/fixtures/rt-unsafe.clap \
	$(BUILD)/fixtures/controls.clap

$(BUILD) $(BUILD)/fixtures:
	mkdir -p $@

# -rdynamic is not needed: the interposer's symbols are found through the preload, never exported by the prober
$(BUILD)/clap-qualify: clap-qualify.c rt-interpose.h | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) $(CLAP_CFLAGS) $(PLUGIN_HOSTD_CFLAGS) $(LDFLAGS) -o $@ $< -ldl -lm

$(BUILD)/rt_interpose.so: rt-interpose.c rt-interpose.h | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) $(LDFLAGS) -shared -fPIC -o $@ $< -ldl -lpthread

$(BUILD)/fixtures/rt-safe.clap: fixtures/gain.c | $(BUILD)/fixtures
	$(CC) $(CPPFLAGS) $(CFLAGS) $(CLAP_CFLAGS) -shared -fPIC -fvisibility=hidden $(LDFLAGS) -o $@ $<

$(BUILD)/fixtures/rt-unsafe.clap: fixtures/gain.c | $(BUILD)/fixtures
	$(CC) $(CPPFLAGS) $(CFLAGS) $(CLAP_CFLAGS) -DFIXTURE_ALLOCATES -shared -fPIC -fvisibility=hidden $(LDFLAGS) -o $@ $<

$(BUILD)/fixtures/controls.clap: fixtures/controls.c | $(BUILD)/fixtures
	$(CC) $(CPPFLAGS) $(CFLAGS) $(CLAP_CFLAGS) -shared -fPIC -fvisibility=hidden $(LDFLAGS) -o $@ $<

deps:
	./fetch-deps.sh deps $(CLAP_REF) $(PLUGIN_HOSTD_REF)

# the fixtures are the tests' own, never installed
install: $(BUILD)/clap-qualify $(BUILD)/rt_interpose.so
	install -d $(DESTDIR)$(LIBEXECDIR)
	install -m 0755 $(BUILD)/clap-qualify $(DESTDIR)$(LIBEXECDIR)/clap-qualify
	install -m 0644 $(BUILD)/rt_interpose.so $(DESTDIR)$(LIBEXECDIR)/rt_interpose.so

clean:
	rm -rf $(BUILD)

.PHONY: all deps install clean
