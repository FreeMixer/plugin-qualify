// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * lv2-measure-rates.h — the rates lv2-measure instantiates and runs each plugin at: omx-contract's
 * STANDARD_SAMPLE_RATES (omx-contract 2.3.0, the pin openmixer built this measurer against), the
 * two names its <omxcontract/omx_contract_limits.h> gives them. The parity test runs this build
 * against openmixer's, compiled with that header, so a list that drifts from it turns the test red.
 */
#ifndef LV2_MEASURE_RATES_H
#define LV2_MEASURE_RATES_H

#define OMX_DECLARED_RATE_COUNT 6u
static const float OMX_DECLARED_RATES[OMX_DECLARED_RATE_COUNT] = { 44100.0f, 48000.0f, 88200.0f, 96000.0f, 176400.0f, 192000.0f };

#endif
