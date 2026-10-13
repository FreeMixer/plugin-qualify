// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * Stands in for openmixer's console limits header when its copy of the LV2 measurer is built for the
 * parity test. Of it, the measurer reads only OMX_DECLARED_RATES and OMX_DECLARED_RATE_COUNT, which it
 * takes from omx-contract's header: so this includes that header, at the version openmixer pinned,
 * and nothing of openmixer's own.
 */
#include <omxcontract/omx_contract_limits.h>
