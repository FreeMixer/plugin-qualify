#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
"""
Offline plugin-latency benchmark for openmixer.

For each plugin in a scanned catalog that reports an `lv2:latency` output port
(found by scan.py), this instantiates the plugin **offline** with lilv — no JACK,
no PipeWire, no mod-host — connects silence buffers, runs a few blocks, and reads
the latency port's value (the plugin's reported latency, in frames). The figure is
merged back into the catalog under `latency.{reportedFrames,reportedMs,sampleRate}`
so the operator can weigh a plugin by its REAL latency before inserting it.

Why offline lilv and not mod-host: mod-host's `param_get` refuses output control
ports outright (`resp -103`, invalid symbol — it only reads *input* params), and
its `monitor_output` feedback channel is change-driven, so a genuinely-zero port
never reports and is indistinguishable from "not measured". Probing in-process
reads the port buffer directly after `run()`: zero is zero, unknown is unknown.
It also keeps the live rig untouched by construction — the plugin never connects
to an audio server, so nothing can reach the speakers, and the running mixer's
mod-host is never involved.

The probing runs in a **worker subprocess** so one finicky plugin (a lookahead
pitch-shifter, say) can only crash the worker, never the batch: the parent records
the in-flight plugin as failed with a reason, respawns the worker, and carries on.
A per-plugin timeout bounds a plugin that simply never answers. `--isolate` goes
further and gives each plugin its own throwaway worker, at the cost of reloading
the LV2 world per plugin; the default reuses one worker and only respawns after a
crash. The parsing + merge (`parse_worker_line`, `merge_latency`, `annotate`) are
pure and unit-tested with fixtures (no LV2 needed), per the latency-curation
design; the smoke test drives the whole batch loop through a stub `--worker-cmd`.

The run is still gated (`--run` / `OPENMIXER_BENCH=1`): it needs the host's real
LV2 plugins installed, so CI must not attempt it.

Usage:
  benchmark.py --in data/catalog.json --out data/catalog.json --run
  benchmark.py --in data/catalog.json --rate 48000 --run     # explicit rate
  benchmark.py --in data/catalog.json --run --isolate        # fresh worker each
  benchmark.py --in data/catalog.json --dry-run              # list what would run
"""
import argparse
import json
import os
import select
import shlex
import subprocess
import sys
import time
from collections import namedtuple

# `COST_REFERENCE_RATE` and `QUANTUM_FRAMES` are the rig's canonical-rate and quantum
# declarations (with the rate list and timeouts), generated from `src/qualify-declarations.ts` because this script cannot import
# a TS module (2026-09-17 declare-derive audit, F8) — see `_declarations.py`'s own header for the
# regenerate/verify commands.
from _declarations import (BOOT_TIMEOUT_S, COST_REFERENCE_RATE, COST_TIMEOUT_S,
                           MEASURE_BASE_RATE, OPERATIONAL_RATE_FLOOR, PLUGIN_TIMEOUT_S,
                           QUALIFY_RATES, QUANTUM_FRAMES)

try:  # numpy is only needed by the worker (and as a fast path in the pure helpers)
    import numpy as _np
except ImportError:  # pragma: no cover - CI runs the pure tests without numpy
    _np = None

DEFAULT_RATE = MEASURE_BASE_RATE
# The rate the flat/back-compat fields (`measuredFrames`, `measuredMs`) are quoted
# at. Every rate the product supports is measured; this one is merely the anchor
# older consumers keep reading.
REFERENCE_RATE = MEASURE_BASE_RATE
# The rates a multi-rate run measures by default: the two the product actually
# runs at plus the two ends of the supported span. A plugin's scaling class is
# DERIVED from how its numbers move across these, never assumed.
DEFAULT_RATES = tuple(QUALIFY_RATES)
# Scaling-class tolerances. Frames: 2 frames or 1 %, whichever is larger (a
# resampling plugin can land a frame either side).
SCALING_TOL_FRAMES = 2.0
SCALING_TOL_FRAMES_REL = 0.01
# Milliseconds: 0.1 ms or 2 %. The absolute figure is what a fixed-TIME look-ahead
# quantised to a power-of-two buffer needs — x42-dpl holds 1.33 ms as 64/128/256
# frames at 48/96/192 kHz but can only manage 56 (not 58.8) at 44.1, a 0.06 ms
# stagger that is not a different scaling law. It stays an order of magnitude
# under anything the 5 ms tier boundary can notice.
SCALING_TOL_MS = 0.1
SCALING_TOL_MS_REL = 0.02
# Coherence floor for the `nonconforming` flag, in milliseconds. A set of readings
# that fits neither scaling law says something worth flagging only if the disagreement
# could reach a mix; under this floor the flag fires on the onset detector's own noise
# and devalues itself where rate-dependence is real.
#
# 2 ms is the per-channel latency budget of
# `docs/design/latency-budget-and-plugin-curation.md` — the amount ONE plugin is
# allowed to spend — not a number tuned to this dataset. The measured population
# happens to leave it unambiguous: over the 124 plugins that read non-zero at any
# rate, the `nonconforming` set is bimodal in its worst-rate latency, nine plugins
# between 0.34 and 1.13 ms (every one a non-linear waveshaper: the guitarix amp/
# distortion models and ZamTube) and then nothing at all until 2.59 ms. The only
# plugins inside that empty band — x42-dpl (1.33 ms), the Bode frequency shifter
# (1.54), the Hilbert transformer (2.25) — all fit a law cleanly, so no coherent
# plugin sits near the floor and moving it anywhere in the gap changes no verdict.
COHERENCE_BUDGET_MS = 2.0
# Blocks of this many frames are run through the plugin before the latency port is
# read — some plugins only settle their reported latency after processing starts.
# `QUANTUM_FRAMES` is the rig's own quantum declaration (imported above); this is that fact
# under the name this file's probing code already uses.
DEFAULT_BLOCK = QUANTUM_FRAMES
DEFAULT_RUN_CYCLES = 4
# Per-plugin probe timeout: a plugin that never answers is recorded as failed
# rather than hanging the whole batch.
DEFAULT_TIMEOUT = float(PLUGIN_TIMEOUT_S)
# Worker boot timeout: loading the LV2 world (600+ plugins) takes a few seconds.
DEFAULT_BOOT_TIMEOUT = float(BOOT_TIMEOUT_S)

# --measure mode: the round-trip probe feeds a unit impulse and reads back the
# ACTUAL latency (onset index), rather than trusting the declared lv2:latency port.
DEFAULT_MEASURE_BLOCK = 512
# Absolute onset backstop, referenced to the unit-amplitude input impulse: -180 dBFS.
# Only a response whose PEAK stays under this counts as silent, so a genuinely quiet
# plugin (say -100 dBFS out) is still measured rather than written off.
MEASURE_THRESHOLD = 1e-9
# Relative onset criterion: the onset is the first sample within 80 dB of the
# response's own peak. Referencing the plugin's own answer (not a fixed floor) is
# what keeps a DC offset or denormal fuzz from reading as an early onset.
ONSET_RELATIVE = 1e-4
# How many output frames to capture per plugin. A declared-0 plugin uses the
# default; a plugin that declares a large latency gets a window that comfortably
# exceeds it (else its onset would fall past the end and read as "silent").
DEFAULT_CAPTURE_FRAMES = 16384
MAX_CAPTURE_FRAMES = 524288

# Sustained-signal fallback: a plugin that gates, expands or compresses by
# threshold passes NO impulse at its default settings, so the impulse probe reads
# it as silent and it lands in `unclassified` for ever. The fallback holds a tone
# on the input long enough for the detector to open, then times the impulse that
# follows while the gate is still within its release.
PREROLL_SECONDS = 0.25
PREROLL_TONE_HZ = 1000.0
PREROLL_TONE_AMP = 0.5  # -6 dBFS: above any plausible default gate threshold

# --- CPU-cost pass (--cost) ----------------------------------------------------
# Bumped whenever a change here would move the numbers; recorded in the run
# provenance so a stale figure can be told from a fresh one.
COST_PROBER_VERSION = "cost/1"
# The block the cost figure is quoted at. 512 frames is what the console's own
# live target uses, and cost per sample is only weakly block-dependent above a
# couple of hundred frames — but it IS quoted, never implied.
DEFAULT_COST_BLOCK = 512
# Blocks run and TIMED before the steady-state window opens. Their timings are
# discarded (only their median is kept, as evidence the discard was warranted):
# the first blocks pay for lazy allocation, filter-table building, cold i-cache
# and the branch predictor still learning the plugin's inner loops. 64 is the
# empirically-derived figure — see docs/design/plugin-cpu-cost.md for the
# convergence run that chose it.
DEFAULT_COST_WARMUP = 64
# Ceiling on timed blocks per plugin per rate. More blocks buy a better tail
# estimate; past a few hundred they only buy wall-clock across 958 plugins x 4 rates.
DEFAULT_COST_BLOCKS = 512
# Floor on timed blocks: below this a p95 is a single sample's opinion.
COST_MIN_BLOCKS = 64
# Per-plugin per-rate wall-time budget. A cheap plugin runs the full ceiling; an
# expensive one stops at COST_MIN_BLOCKS-or-more once it has spent this long, which
# is what keeps a convolution reverb from eating the sweep.
COST_TARGET_SECONDS = 0.25
# The stimulus: a sustained 1 kHz sine at -6 dBFS held on EVERY audio input, phase
# continuous across blocks. Silence is not a valid cost stimulus — a plugin that
# short-circuits on it (or that runs its whole DSP into denormals) reports a cost
# that has nothing to do with what it does under signal, the same trap the impulse
# latency probe hit.
COST_TONE_HZ = 1000.0
COST_TONE_AMP = 0.5
# The high percentile reported next to the median. p95, not p99 or max: with
# COST_MIN_BLOCKS..DEFAULT_COST_BLOCKS timed blocks a p99 is the 1st-to-5th worst
# sample and a max is exactly one sample, so both are dominated by whatever the OS
# did to us once (a migration, an interrupt, an SMI). p95 still exposes a plugin
# whose tail is genuinely fat — the one that xruns mid-show — while being a stable
# statistic at this sample count.
COST_PERCENTILE = 95.0
# Cost is anchored at the rig's canonical rate: the headline figure the operator asked for is
# "how many of these fit in one core at the rig's rate". `COST_REFERENCE_RATE` is imported above
# from `_declarations.py` — the same fact `cpu-cost.ts` declares, not a second 96000 literal.
# A cost probe runs many more blocks than a latency probe; give it room.
DEFAULT_COST_TIMEOUT = float(COST_TIMEOUT_S)
# Iterations of the empty-call loop that measures the harness's own timing floor.
COST_CALIBRATION_ITERS = 512

# What measure_offline returns: measured latencies, the plugins that failed (each
# with a human reason) so one finicky plugin never silently drops the batch,
# whatever else the worker said about a measurement (which stimulus it took), and
# what the worker said about ITSELF at boot (the cost pass's timing floor and the
# cpu it managed to pin to — provenance that has to survive back to the caller).
BenchmarkResult = namedtuple("BenchmarkResult",
                             ["measured", "failures", "details", "workerInfo"],
                             defaults=({}, {}))


def latency_port_symbol(descriptor):
    """The plugin's lv2:latency output-port symbol, or None (set by scan.py)."""
    lat = descriptor.get("latency")
    if isinstance(lat, dict):
        return lat.get("portSymbol")
    return None


def benchmark_targets(catalog):
    """Descriptors that report a latency port — the only ones worth benchmarking."""
    return [d for d in catalog if latency_port_symbol(d) is not None]


def format_job(uri, symbol):
    """One job line for the worker: tab-separated so URIs stay unambiguous."""
    return f"{uri}\t{symbol}"


def parse_worker_line(line):
    """Parse one worker reply line into a dict, or None for garbage.

    The worker speaks JSON lines: `{"ready": true}` once after loading the LV2
    world, then per job either `{"uri": …, "frames": <float>}` on success or
    `{"uri": …, "error": "<reason>"}` on a soft failure. Anything unparseable
    (a crashing plugin can spray text onto stdout) yields None — the caller
    treats the read as failed, never guesses a number.
    """
    if not line:
        return None
    try:
        out = json.loads(line)
    except (ValueError, TypeError):
        return None
    return out if isinstance(out, dict) else None


def format_measure_job(declared_frames, sweep=()):
    """The job payload a MEASURE worker receives: declared-latency hint + sweep list.

    Encoded as JSON so the sweep list rides along without a second protocol; a bare
    number is still accepted ({@link parse_measure_job}) so an older job line, and
    the stub workers the tests drive, keep working.
    """
    if not sweep:
        return str(float(declared_frames or 0.0))
    return json.dumps({"declared": float(declared_frames or 0.0), "sweep": list(sweep)})


def parse_measure_job(arg):
    """Parse a MEASURE job payload → `{"declared": float, "sweep": [symbol, …]}`. Pure.

    Accepts both encodings ({@link format_measure_job}) and never raises: garbage
    degrades to "measure at the defaults with no hint", which is the safe reading.
    """
    text = (arg or "").strip()
    if text.startswith("{"):
        try:
            job = json.loads(text)
        except ValueError:
            job = {}
        if isinstance(job, dict):
            try:
                declared = float(job.get("declared") or 0.0)
            except (ValueError, TypeError):
                declared = 0.0
            sweep = job.get("sweep")
            return {"declared": declared,
                    "sweep": [str(s) for s in sweep] if isinstance(sweep, list) else []}
    try:
        return {"declared": float(text), "sweep": []}
    except ValueError:
        return {"declared": 0.0, "sweep": []}


def merge_latency(descriptor, frames, sample_rate):
    """Return a copy of `descriptor` with measured latency merged into `latency`.

    Preserves the scanner's `portSymbol`; adds `reportedFrames`, `reportedMs`,
    `sampleRate`. `frames=None` leaves the descriptor's latency block untouched
    (a read that failed must not erase a port symbol or fake a zero).
    """
    out = dict(descriptor)
    base = dict(out.get("latency") or {})
    if frames is not None and sample_rate and sample_rate > 0:
        base["reportedFrames"] = frames
        base["reportedMs"] = (frames / sample_rate) * 1000.0
        base["sampleRate"] = sample_rate
    if base:
        out["latency"] = base
    return out


def annotate(catalog, measured, sample_rate):
    """Apply `measured` ({uri: frames}) onto a catalog → a new annotated catalog.

    Pure: no subprocesses. The benchmark's batch loop produces `measured`; this
    folds it in. A uri absent from `measured` is passed through unchanged.
    """
    out = []
    for d in catalog:
        frames = measured.get(d["uri"])
        out.append(merge_latency(d, frames, sample_rate) if frames is not None else d)
    return out


def peak_abs(samples):
    """Largest |value| in `samples` (0.0 when empty). Pure; numpy fast path."""
    if _np is not None and isinstance(samples, _np.ndarray):
        return float(_np.max(_np.abs(samples))) if samples.size else 0.0
    peak = 0.0
    for v in samples:
        a = abs(v)
        if a > peak:
            peak = a
    return peak


def first_above(samples, level):
    """Index of the first sample whose |value| exceeds `level`, or None. Pure."""
    if _np is not None and isinstance(samples, _np.ndarray):
        hits = _np.flatnonzero(_np.abs(samples) > level)
        return int(hits[0]) if hits.size else None
    for i, v in enumerate(samples):
        if abs(v) > level:
            return i
    return None


def dc_level(samples):
    """A robust constant-offset estimate for `samples`: their median. Pure.

    The median, not the mean: an impulse response is sparse, so the median lands
    on the plugin's resting output (the DC offset it leaks) and is barely moved by
    the response itself, whereas the mean is dragged by a long tail. Subtracting it
    is what stops a leaked offset from reading as an onset at frame 0.
    """
    if _np is not None and isinstance(samples, _np.ndarray):
        return float(_np.median(samples)) if samples.size else 0.0
    ordered = sorted(samples)
    n = len(ordered)
    if n == 0:
        return 0.0
    mid = n // 2
    return ordered[mid] if n % 2 else (ordered[mid - 1] + ordered[mid]) / 2.0


def detect_onset(samples, threshold=MEASURE_THRESHOLD, relative=ONSET_RELATIVE):
    """Index of the response's onset, or None when there is no response.

    Pure + unit-tested: this is the actual round-trip latency recovery. `samples`
    is the plugin's RESIDUAL response to a unit impulse fed at frame 0 — the
    impulse pass minus a silent-input baseline pass, so anything the plugin emits
    regardless of the stimulus (a DC offset, denormal fuzz, idle hiss) is already
    common-moded out. Any sequence of floats works (a list in tests, a numpy array
    in the probe); the returned index IS the measured latency in frames.

    Three steps, all referenced to the signal rather than to a magic constant:

    - any constant offset ({@link dc_level}) is subtracted first, so a plugin that
      leaks DC from frame 0 does not read as "onset 0, zero latency";
    - the centred response must PEAK above `threshold`, an absolute backstop
      referenced to the unit-amplitude input impulse (-180 dBFS). Below that there
      is no answer to time and the result is `None` (silent — not "0 frames"). The
      backstop is deliberately far below the audible floor so a genuinely quiet
      response (-100 dBFS) is still measured;
    - the onset is then the first sample within `relative` of that peak, so a
      precursor 80 dB down (denormal fuzz, filter warm-up) cannot pull the onset
      earlier than the real arrival.

    A plain plugin returns 0/1, a linear-phase EQ its half-window, a look-ahead
    limiter its look-ahead; a 100%-wet reverb returns ~0 (its tail is not latency).
    The acknowledged corner is a plugin whose response to an impulse is a sustained
    DC STEP: its median is the step, which centring removes. Nothing in the scanned
    958 behaves that way, and the probe's differential pass would keep it honest.
    """
    dc = dc_level(samples)
    if not dc:
        centred = samples
    elif _np is not None and isinstance(samples, _np.ndarray):
        centred = samples - dc
    else:
        centred = [v - dc for v in samples]
    peak = peak_abs(centred)
    if peak <= threshold:
        return None
    return first_above(centred, max(threshold, relative * peak))


def residual(response, baseline):
    """`response - baseline`, elementwise, over the common length. Pure.

    The differential measurement: the same plugin run twice, once with the impulse
    and once with silence. Whatever it emits either way (DC, denormals, idle noise,
    a deterministic LFO) cancels, leaving only what the impulse caused.
    """
    if _np is not None and isinstance(response, _np.ndarray) and isinstance(baseline, _np.ndarray):
        n = min(response.size, baseline.size)
        return response[:n] - baseline[:n]
    return [a - b for a, b in zip(response, baseline)]


def capture_frames(declared_frames, rate=DEFAULT_RATE):
    """How many output frames to capture for a plugin declaring `declared_frames`.

    Comfortably exceeds the declared value so a genuine large latency isn't
    truncated (which would misread as silent), floored at DEFAULT_CAPTURE_FRAMES
    for the common declared-0 case and capped at MAX_CAPTURE_FRAMES to bound the
    run. Pure so it can be reasoned about without instantiating anything.

    The floor and the cap scale with `rate`: the window is a span of TIME, and a
    fixed-time plugin's latency in frames doubles when the rate doubles, so a
    window frozen at the 48 kHz frame count would truncate at 96/192 kHz and
    misread a real look-ahead as silence.
    """
    scale = max(1.0, float(rate) / DEFAULT_RATE)
    base = int(declared_frames) if declared_frames and declared_frames > 0 else 0
    floor = int(DEFAULT_CAPTURE_FRAMES * scale)
    cap = int(MAX_CAPTURE_FRAMES * scale)
    return min(max(floor, base * 3 + 2048), cap)


# --- the parameter sweep -------------------------------------------------------
# Latency is frequently A CONTROL: a look-ahead time, an FFT window size, an
# oversampling factor. Sweeping every control of every plugin is not affordable
# (5399 candidate ports over the 958 scanned, and each measurement is two renders),
# so candidates are ranked by how specifically their name points at a latency
# mechanism and only the top few per plugin are measured. Ordered most-specific
# first; the rank IS the tuple order.
SWEEP_KEYWORDS = (
    "lookahead", "look-ahead", "look ahead", "latency", "fft", "linphase",
    "linear phase", "oversampl", "window", "taps", "tap ", "order", "predelay",
    "pre-delay", "buffer size", "block size", "resolution", "precision",
    "length", "size", "quality", "mode",
)
# Per-plugin cap on swept controls. Three covers every plugin that has a genuine
# latency control (the rest of the matches are algorithm/voicing switches) and
# keeps the sweep to a few thousand extra measurements rather than tens of
# thousands. Note "delay" is deliberately NOT a keyword: a delay line's time
# control moves the onset because moving the onset IS the effect, and 1998 ports
# would have matched it.
SWEEP_MAX_CONTROLS = 3
# A control counts as latency-bearing when it moves the onset by more than this.
SWEEP_MIN_DELTA_FRAMES = 2.0


def sweep_candidates(params, limit=SWEEP_MAX_CONTROLS):
    """The control symbols worth sweeping for latency, most-promising first. Pure.

    `params` is a scanned descriptor's `params` list. A candidate must be a control
    port with a real range (a fixed `min == max` cannot move anything) and a name or
    symbol naming a latency mechanism ({@link SWEEP_KEYWORDS}). At most `limit` are
    returned — this is a cost bound, and the ranking is what makes the bound safe.
    """
    ranked = []
    for index, p in enumerate(params):
        if p.get("kind") != "control":
            continue
        mn, mx = p.get("min"), p.get("max")
        if mn is None or mx is None or mn == mx:
            continue
        text = f"{p.get('symbol', '')} {p.get('name', '')}".lower()
        for rank, keyword in enumerate(SWEEP_KEYWORDS):
            if keyword in text:
                ranked.append((rank, index, p["symbol"]))
                break
    ranked.sort()
    return [symbol for _rank, _index, symbol in ranked[:limit]]


def summarise_sweep(default_frames, swept, rate, min_delta=SWEEP_MIN_DELTA_FRAMES):
    """Fold a sweep's raw points into the catalog's `paramSweep` block, or None. Pure.

    `swept` maps a control symbol to `{"min": frames, "max": frames}` — the latency
    measured with that one control pinned to each end of its range, everything else
    at its default. Only controls that MOVE the latency by more than `min_delta`
    are kept: the point of the sweep is to find which controls are latency-bearing,
    and recording the ones that are not would bury that in noise. Returns None when
    no control moved anything, so the vast majority of plugins carry no block at all.

    The surviving block carries the full span (`minFrames`/`maxFrames` in frames and
    milliseconds) so a UI can tell an operator what raising look-ahead will cost.
    """
    moving = {}
    for symbol, points in sorted(swept.items()):
        values = [v for v in (points.get("min"), points.get("max")) if v is not None]
        if not values:
            continue
        if max(abs(v - default_frames) for v in values) <= min_delta:
            continue
        moving[symbol] = {"minFrames": float(min(values)), "maxFrames": float(max(values))}
    if not moving:
        return None
    span = [default_frames]
    for entry in moving.values():
        span += [entry["minFrames"], entry["maxFrames"]]
    lo, hi = min(span), max(span)
    return {
        "rate": int(rate),
        "defaultFrames": float(default_frames),
        "defaultMs": float(default_frames) / rate * 1000.0,
        "minFrames": float(lo),
        "minMs": float(lo) / rate * 1000.0,
        "maxFrames": float(hi),
        "maxMs": float(hi) / rate * 1000.0,
        "controls": moving,
    }


def control_default(default, minimum, maximum):
    """A sane value for a control-input port: its lv2:default, else the midpoint.

    `default`/`minimum`/`maximum` are lilv range nodes (any may be None). The
    default is authoritative; with no default, the midpoint of the declared range
    keeps the plugin in a normal operating point; failing that, 0.0.
    """
    if default is not None:
        try:
            return float(str(default))
        except (ValueError, TypeError):
            pass
    try:
        return (float(str(minimum)) + float(str(maximum))) / 2.0
    except (ValueError, TypeError):
        return 0.0


def _within(values, absolute, relative):
    """True when `values` all agree to within `absolute` or `relative` of their mean."""
    lo, hi = min(values), max(values)
    tol = max(absolute, relative * (sum(values) / len(values)))
    return (hi - lo) <= tol


def unreliable_readings(per_rate):
    """The readings in `per_rate` that are physically impossible → {rate: reason}. Pure.

    A reading is evidence only if some latency could have produced it. One kind
    cannot: **a 0-frame reading from a plugin that measured non-zero at another
    rate.** Both scaling laws map zero to zero — a constant frame count of 0 stays
    0, and 0 ms is 0 ms at every rate — so no single latency yields 0 here and 16
    frames there. What produces it is the onset detector, on a plugin whose impulse
    response is not a fixed filter: a non-linear waveshaper (an amp or distortion
    model) with internal oversampling answers a unit impulse differently at each
    rate, and the first sample within the relative arrival threshold lands
    somewhere else each time — or, at 96 kHz, on sample 0.

    Guarded against the case that IS legitimate: sub-frame rounding. A true latency
    of 0.4 frames honestly reads 0 at 48 kHz and 1 at 192. So a zero is condemned
    only when the SMALLEST non-zero evidence, projected onto this rate under the more
    forgiving of the two laws, still exceeds a whole frame — i.e. even the kindest
    reading of the other rates says a frame should have been visible here.

    Reasons are short, machine-readable and stored on the plugin, so the next reader
    of the catalog inherits the finding rather than re-deriving it.
    """
    points = {int(r): float(f) for r, f in per_rate.items() if f is not None}
    nonzero = [(r, f) for r, f in points.items() if f > 0.0]
    if not nonzero:
        return {}
    out = {}
    for rate, frames in points.items():
        if frames != 0.0:
            continue
        # fixed-frame projects f frames onto this rate; fixed-time projects f*rate/r.
        implied = min(min(f, f * rate / r) for r, f in nonzero)
        if implied >= 1.0:
            out[rate] = "impossible-zero"
    return dict(sorted(out.items()))


def _fit_scaling(points):
    """The scaling law `points` (rate → frames, coherent readings only) obey. Pure."""
    if not points:
        return "unmeasured"
    if len(points) < 2:
        return "single-rate"
    frames = list(points.values())
    if all(f == 0.0 for f in frames):
        return "zero"
    if _within(frames, SCALING_TOL_FRAMES, SCALING_TOL_FRAMES_REL):
        return "fixed-frame"
    ms = [f / r * 1000.0 for r, f in points.items()]
    if _within(ms, SCALING_TOL_MS, SCALING_TOL_MS_REL):
        return "fixed-time"
    if max(ms) < COHERENCE_BUDGET_MS:
        # incoherent, but every reading fits inside the budget one plugin may spend:
        # nothing a mix can hear turns on which law this obeys, and flagging it would
        # spend the flag's credibility on the detector's noise.
        return "zero"
    return "nonconforming"


def _coherent_points(per_rate):
    """`per_rate` as rate → frames with the {@link unreliable_readings} dropped. Pure."""
    points = {int(r): float(f) for r, f in per_rate.items() if f is not None}
    for rate in unreliable_readings(points):
        del points[rate]
    return points


def _operational_refit(points):
    """The class the operational rates alone give a plugin the full fit flags, or None. Pure.

    A reading below {@link OPERATIONAL_RATE_FLOOR} is informational for the class
    (`lv2-measurement-interchange.md` §1a): it may not make a plugin `nonconforming` on its own.
    So when every reading together fits no law, the readings at and above the floor are fitted
    alone — given at least two of them — and a law found there is the class. None when the full
    fit is not `nonconforming`, or the operational readings flag it too: only the flag is ever
    re-derived, so a fit that holds over every reading is never overturned by fewer points.
    """
    if _fit_scaling(points) != "nonconforming":
        return None
    operational = {r: f for r, f in points.items() if r >= OPERATIONAL_RATE_FLOOR}
    if len(operational) < 2 or len(operational) == len(points):
        return None
    refit = _fit_scaling(operational)
    return None if refit == "nonconforming" else refit


def classify_scaling(per_rate):
    """Derive a plugin's latency SCALING CLASS from measurements at several rates.

    `per_rate` maps sample rate (Hz) → measured latency in frames. The class is
    read off the evidence, never assumed from what the plugin claims to be:

    - `"zero"`          — no latency a mix can notice. Either literally 0 frames at
                          every rate (both laws hold; calling it either would pollute
                          the census), or readings that fit no law but stay inside
                          {@link COHERENCE_BUDGET_MS} at every rate, where the
                          disagreement is the detector's noise and not the plugin's.
    - `"fixed-frame"`   — the frame count is constant, so the millisecond cost
                          HALVES when the rate doubles (an FFT window, a fixed
                          look-ahead buffer, a filter of N taps).
    - `"fixed-time"`    — the millisecond figure is constant, so the frame count
                          DOUBLES with the rate (a 5 ms look-ahead limiter).
    - `"nonconforming"` — fits neither law AT A MAGNITUDE THAT MATTERS. Genuinely
                          interesting (a plugin that switches algorithm by rate, or
                          internally resamples); flagged, never averaged away.
    - `"single-rate"`   — one usable reading; nothing can be derived.
    - `"unmeasured"`    — no rate produced a figure.

    Coherence comes first: readings {@link unreliable_readings} condemns are dropped
    before any law is fitted, because a failed measurement that defines a class is
    worse than no measurement at all — ZamTube's 32/32/**0**/32 is a 32-frame
    fixed-frame plugin with one dropped reading, not a plugin whose latency vanishes
    at 96 kHz and returns at 192.

    When both laws hold at once beyond the all-zero case (a 1-frame plugin, say,
    where 2 frames of tolerance swallows the difference) the frame fit wins: a
    constant tiny frame count is what such plugins actually are.

    `nonconforming` is earned at the operational rates ({@link _operational_refit}): Calf's
    psychoacoustic clipper holds 5.333 ms at 48/96/192 kHz and rounds its 44.1 kHz buffer to
    the 48 kHz frame count — `fixed-time`, with the 44.1 kHz reading kept as informational.
    """
    points = _coherent_points(per_rate)
    refit = _operational_refit(points)
    return refit if refit is not None else _fit_scaling(points)


def scaling_note(per_rate):
    """Why a derived class is not the naive fit over every reading, or None. Pure.

    Machine-readable, stored as `latency.scalingNote`. Two values:
    `"below-budget"`: the surviving readings fit no law, but every one of them is under
    {@link COHERENCE_BUDGET_MS}, so the plugin is called `zero` rather than flagged.
    `perRate` still holds what was actually measured, so no figure is lost — only the
    claim that the disagreement means anything.

    `"informational-rate"`: the full fit flags the plugin, but the operational rates alone obey
    a law ({@link _operational_refit}); the reading below {@link OPERATIONAL_RATE_FLOOR} that
    disagrees stays in `perRate` and the note says why the class ignores it.

    Excluded readings are NOT noted here; they are recorded per rate, with their reason,
    in `latency.unreliableRates`.
    """
    points = _coherent_points(per_rate)
    if len(points) < 2 or all(f == 0.0 for f in points.values()):
        return None
    if _operational_refit(points) is not None:
        return "informational-rate"
    return "below-budget" if _fit_scaling(points) == "zero" else None


def apply_coherence(lat, per_rate):
    """Write the derived class and its coherence findings into a `latency` dict, in place.

    The one place `scalingClass`, `unreliableRates` and `scalingNote` are set together, so
    a fresh measurement (`annotate_per_rate`) and a re-derivation over already-measured
    data (`--reclassify`) cannot drift apart. Absent findings are REMOVED, not left
    stale, so re-running over an older catalog is idempotent.
    """
    lat["scalingClass"] = classify_scaling(per_rate)
    bad = unreliable_readings(per_rate)
    if bad:
        lat["unreliableRates"] = [
            {"rate": rate, "frames": float(per_rate[rate]), "reason": reason}
            for rate, reason in bad.items()
        ]
    else:
        lat.pop("unreliableRates", None)
    note = scaling_note(per_rate)
    if note:
        lat["scalingNote"] = note
    else:
        lat.pop("scalingNote", None)
    return lat


def reclassify(catalog):
    """Re-derive every plugin's scaling class from the `perRate` ALREADY in the catalog. Pure.

    The measurement is the expensive, rig-bound part (958 plugins × 4 rates); the class is
    arithmetic over figures the catalog already holds. When a classification rule changes,
    this replays it over the committed data instead of re-probing hardware, so the diff is
    provably a change of interpretation and not a second, differently-noisy measurement.
    """
    out = []
    for d in catalog:
        lat = d.get("latency")
        per_rate = (lat or {}).get("perRate")
        if not isinstance(lat, dict) or not isinstance(per_rate, dict):
            out.append(d)
            continue
        points = {int(r): float(v["frames"]) for r, v in per_rate.items()
                  if isinstance(v, dict) and v.get("frames") is not None}
        nd = dict(d)
        nd["latency"] = apply_coherence(dict(lat), points)
        out.append(nd)
    return out


def per_rate_block(per_rate):
    """The catalog's `latency.perRate` block: rate (as a string key) → frames + ms."""
    return {
        str(int(rate)): {"frames": float(frames), "ms": float(frames) / int(rate) * 1000.0}
        for rate, frames in sorted(per_rate.items())
        if frames is not None
    }


def annotate_per_rate(catalog, by_rate, reference_rate=REFERENCE_RATE, tol=2):
    """Fold a MULTI-RATE measurement into a catalog → a new annotated catalog. Pure.

    `by_rate` maps sample rate → `{"measured": {uri: frames}, "unmeasurable": {uri: reason}}`
    (one entry per rate the batch ran at). Each plugin gets:

    - `latency.perRate` — every rate that measured, in frames AND milliseconds, so
      no consumer has to re-derive one from the other;
    - `latency.scalingClass` — {@link classify_scaling} over those points;
    - `latency.{measuredFrames,measuredMs,sampleRate}` at `reference_rate`, kept flat
      for consumers written before the per-rate schema existed;
    - `latency.declaredMismatch` against the declared `lv2:latency` port, at the
      reference rate (the rate the port was read at);
    - `latency.unmeasurable` ONLY when NO rate could measure it — a plugin that
      measures at 96 kHz but not at 48 is measured, not quarantined.
    """
    out = []
    for d in catalog:
        uri = d["uri"]
        points = {r: run["measured"][uri] for r, run in by_rate.items()
                  if uri in run.get("measured", {})}
        reasons = {r: run["unmeasurable"][uri] for r, run in by_rate.items()
                   if uri in run.get("unmeasurable", {})}
        if not points and not reasons:
            out.append(d)
            continue
        nd = dict(d)
        lat = dict(nd.get("latency") or {})
        if points:
            lat["perRate"] = per_rate_block(points)
            apply_coherence(lat, points)
            lat.pop("unmeasurable", None)
            stimulus = next(
                (run["details"][uri]["stimulus"] for run in by_rate.values()
                 if uri in run.get("details", {}) and "stimulus" in run["details"][uri]),
                None,
            )
            if stimulus:
                # measured only under an escalated stimulus: the figure describes
                # that operating point, not the plugin sitting at its defaults.
                lat["stimulus"] = stimulus
            else:
                lat.pop("stimulus", None)
            lat.pop("paramSweep", None)
            for rate, run in by_rate.items():
                swept = run.get("details", {}).get(uri, {}).get("sweep")
                if not swept or uri not in run["measured"]:
                    continue
                block = summarise_sweep(float(run["measured"][uri]), swept, rate)
                if block:
                    lat["paramSweep"] = block
            anchor = reference_rate if reference_rate in points else min(points)
            frames = float(points[anchor])
            lat["measuredFrames"] = frames
            lat["measuredMs"] = frames / anchor * 1000.0
            lat["sampleRate"] = anchor
            if anchor == reference_rate:
                # the declared lv2:latency port was read at the reference rate, so
                # that is the only rate the cross-check is a like-for-like compare.
                declared = lat.get("reportedFrames") or 0.0
                lat["declaredMismatch"] = abs(frames - declared) > tol
            else:
                lat.pop("declaredMismatch", None)
        else:
            lat["unmeasurable"] = reasons.get(reference_rate, next(iter(reasons.values())))
        nd["latency"] = lat
        out.append(nd)
    return out


# --- CPU cost: pure aggregation + realtime-budget maths ------------------------


def percentile(values, pct):
    """Linear-interpolated percentile of `values` (unsorted ok). Pure, no numpy.

    Matches the usual "type 7" definition (numpy's default) so a figure computed
    here and one recomputed by a consumer agree. `None` for an empty input — an
    absent statistic is never a zero one.
    """
    data = sorted(float(v) for v in values)
    if not data:
        return None
    if len(data) == 1:
        return data[0]
    pos = (len(data) - 1) * max(0.0, min(100.0, float(pct))) / 100.0
    low = int(pos)
    high = min(low + 1, len(data) - 1)
    return data[low] + (data[high] - data[low]) * (pos - low)


def drop_warmup(block_times, warmup):
    """`(warm, steady)` — the discarded warm-up head and the steady-state tail. Pure.

    The split is positional and deliberately dumb: the FIRST `warmup` timed blocks
    go, whatever they cost. An adaptive "drop until it settles" rule would let a
    plugin that never settles report the tail it happens to like, which is the one
    failure mode a cost figure must not have.
    """
    n = max(0, int(warmup))
    return list(block_times[:n]), list(block_times[n:])


def core_fraction(ns_per_sample, rate):
    """Fraction of ONE core's realtime budget: ns of CPU per sample x samples per second.

    Pure, and the whole normalisation in one line — a plugin costing 20 ns per
    sample at 96 kHz burns 20e-9 * 96000 = 0.19 % of a core. Independent of block
    size by construction, which is why the per-sample figure is what gets stored.
    """
    if rate <= 0:
        return None
    return float(ns_per_sample) * float(rate) / 1e9


def instances_per_core(fraction):
    """How many instances fit in one core's realtime budget at that cost. Pure.

    Floor, not round: 3.9 instances means 3 fit. `None` when the cost is zero or
    negative — "unbounded" is not a number an operator can act on, and reporting a
    huge integer there would be a lie dressed as precision.
    """
    if fraction is None or fraction <= 0.0:
        return None
    return int(1.0 / float(fraction))


def summarise_cost(block_times_ns, block_frames, rate, warmup=DEFAULT_COST_WARMUP,
                   pct=COST_PERCENTILE):
    """Fold per-block wall times into one rate's cost record. Pure.

    `block_times_ns` is EVERY timed block including the warm-up head; the split is
    done here (not in the worker) so the record can carry `warmupNsPerSampleMedian`
    as evidence that discarding was warranted rather than assumed.

    Returns `None` when no steady-state block survives — an unmeasurable cost is
    recorded as unmeasurable, never as a cheap one.
    """
    warm, steady = drop_warmup(block_times_ns, warmup)
    if not steady or block_frames <= 0:
        return None
    per_sample = [t / float(block_frames) for t in steady]
    median = percentile(per_sample, 50.0)
    high = percentile(per_sample, pct)
    record = {
        "nsPerSampleMedian": median,
        "nsPerSampleP95": high,
        "nsPerSampleMin": min(per_sample),
        "nsPerSampleMax": max(per_sample),
        "coreFractionMedian": core_fraction(median, rate),
        "coreFractionP95": core_fraction(high, rate),
        "instancesPerCoreP95": instances_per_core(core_fraction(high, rate)),
        "blocks": len(steady),
        "warmupBlocks": len(warm),
        "blockFrames": int(block_frames),
    }
    if warm:
        record["warmupNsPerSampleMedian"] = percentile(
            [t / float(block_frames) for t in warm], 50.0)
    return record


def annotate_cost(catalog, by_rate, reference_rate=COST_REFERENCE_RATE):
    """Fold a multi-rate CPU-cost run into a catalog → a new annotated catalog. Pure.

    `by_rate` maps rate → `{"measured": {uri: record}, "unmeasurable": {uri: reason},
    "failures": {uri: reason}}`. Each plugin gets a `cpuCost` block holding:

    - `perRate` — the full record per rate, keyed by rate as a string;
    - `referenceRate` + the flat `nsPerSampleMedian` / `coreFractionP95` /
      `instancesPerCoreP95` at it, so the headline figure needs no lookup;
    - `unmeasurable` / `failed` ONLY when NO rate produced a figure, with the
      reason. A plugin measured at one rate and not another is measured.

    The provenance (host, CPU, governor, block, stimulus) is NOT copied into every
    descriptor: it is one run-level fact, written alongside by {@link host_provenance}.
    """
    out = []
    for d in catalog:
        uri = d["uri"]
        points = {r: run["measured"][uri] for r, run in by_rate.items()
                  if uri in run.get("measured", {})}
        reasons = {r: run["unmeasurable"][uri] for r, run in by_rate.items()
                   if uri in run.get("unmeasurable", {})}
        failed = {r: run["failures"][uri] for r, run in by_rate.items()
                  if uri in run.get("failures", {})}
        if not points and not reasons and not failed:
            out.append(d)
            continue
        nd = dict(d)
        cost = {}
        if points:
            cost["perRate"] = {str(r): points[r] for r in sorted(points)}
            anchor = reference_rate if reference_rate in points else max(points)
            cost["referenceRate"] = anchor
            for key in ("nsPerSampleMedian", "nsPerSampleP95",
                        "coreFractionMedian", "coreFractionP95",
                        "instancesPerCoreP95"):
                cost[key] = points[anchor][key]
            if any(p.get("silentOutput") for p in points.values()):
                # It ran and it was timed, but it emitted nothing under a signal
                # that should have passed: the figure may describe a short-circuit
                # path rather than the DSP. Flagged, not dropped, not trusted.
                cost["silentOutput"] = True
        elif reasons:
            cost["unmeasurable"] = reasons.get(reference_rate,
                                               next(iter(reasons.values())))
        else:
            cost["failed"] = failed.get(reference_rate, next(iter(failed.values())))
        nd["cpuCost"] = cost
        out.append(nd)
    return out


def cost_census(annotated, reference_rate=COST_REFERENCE_RATE):
    """`(measured, unmeasurable, failed)` URI counts of a cost annotation. Pure."""
    measured = unmeasurable = failed = 0
    for d in annotated:
        cost = d.get("cpuCost")
        if not isinstance(cost, dict):
            continue
        if cost.get("perRate"):
            measured += 1
        elif cost.get("unmeasurable"):
            unmeasurable += 1
        elif cost.get("failed"):
            failed += 1
    return measured, unmeasurable, failed


def parse_cpu_list(text):
    """`"0-7,12"` → `[0,1,2,3,4,5,6,7,12]`. Pure; parses a Linux sysfs cpu list."""
    out = []
    for part in str(text).strip().split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            lo, _dash, hi = part.partition("-")
            try:
                out.extend(range(int(lo), int(hi) + 1))
            except ValueError:
                continue
        else:
            try:
                out.append(int(part))
            except ValueError:
                continue
    return sorted(set(out))


def parse_cpu_model(cpuinfo):
    """The first `model name` line of a /proc/cpuinfo text, or None. Pure."""
    for line in str(cpuinfo).splitlines():
        key, _colon, value = line.partition(":")
        if key.strip() == "model name":
            return value.strip()
    return None


def parse_lv2bench_tsv(text):
    """Parse lv2bench's TSV → `{uri: {"min":s,"mean":s,"max":s,"block":n,"rate":hz}}`. Pure.

    Upstream's columns are `Block Frames Rate Min Mean Max Total Plugin`, all times
    in SECONDS per block. Used only by the cross-check ({@link compare_lv2bench}):
    lv2bench is the independent second opinion our numbers are validated against,
    not a source we import figures from.
    """
    out = {}
    for line in str(text).splitlines():
        cols = line.rstrip("\n").split("\t")
        if len(cols) < 8 or cols[0].strip() == "Block":
            continue
        try:
            out[cols[7].strip()] = {
                "block": int(float(cols[0])),
                "rate": float(cols[2]),
                "min": float(cols[3]),
                "mean": float(cols[4]),
                "max": float(cols[5]),
            }
        except ValueError:
            continue
    return out


def compare_lv2bench(theirs, ours, block_frames=DEFAULT_COST_BLOCK):
    """Cross-check our per-sample medians against lv2bench's per-block means. Pure.

    `theirs` is {@link parse_lv2bench_tsv} output (seconds per block); `ours` maps
    uri → ns per sample. Returns a list of per-URI rows with the ratio ours/theirs,
    sorted by URI, plus every URI only one side has — an agreement report has to
    show its misses or it is just a filtered success story.
    """
    rows = []
    for uri in sorted(set(theirs) | set(ours)):
        their = theirs.get(uri)
        our_ns = ours.get(uri)
        if their is None or our_ns is None:
            rows.append({"uri": uri, "ratio": None,
                         "reason": "only in lv2bench" if our_ns is None
                                   else "only in ours"})
            continue
        # lv2bench quotes seconds per block; normalise to ns per sample at ITS block.
        their_ns = their["mean"] * 1e9 / float(their.get("block") or block_frames)
        rows.append({"uri": uri, "theirNsPerSample": their_ns,
                     "ourNsPerSample": float(our_ns),
                     "ratio": (float(our_ns) / their_ns) if their_ns > 0 else None})
    return rows


def annotate_measured(catalog, measured, unmeasurable, sample_rate, tol=2):
    """Fold measured round-trip latencies into a catalog → a new annotated catalog.

    Pure. For a measured uri, writes `latency.{measuredFrames,measuredMs}` next to
    any existing declared `reportedFrames`, and sets `latency.declaredMismatch`
    when the measured value differs from the declared one (0 if none) by more than
    `tol` frames — the important class being declared-0-but-measured-nonzero. For
    an unmeasurable uri, records `latency.unmeasurable` (the reason). A uri in
    neither map is passed through unchanged.
    """
    out = []
    for d in catalog:
        uri = d["uri"]
        if uri in measured:
            nd = dict(d)
            lat = dict(nd.get("latency") or {})
            frames = float(measured[uri])
            lat["measuredFrames"] = frames
            lat["measuredMs"] = (frames / sample_rate * 1000.0) if sample_rate else None
            lat["sampleRate"] = sample_rate
            declared = lat.get("reportedFrames") or 0.0
            lat["declaredMismatch"] = abs(frames - declared) > tol
            nd["latency"] = lat
            out.append(nd)
        elif uri in unmeasurable:
            nd = dict(d)
            lat = dict(nd.get("latency") or {})
            lat["unmeasurable"] = unmeasurable[uri]
            nd["latency"] = lat
            out.append(nd)
        else:
            out.append(d)
    return out


# --- the worker: offline lilv probing (plugin-host imports live in here) -------

LV2 = "http://lv2plug.in/ns/lv2core#"
ATOM = "http://lv2plug.in/ns/ext/atom#"
URID = "http://lv2plug.in/ns/ext/urid#"
OPTIONS = "http://lv2plug.in/ns/ext/options#"
BUFSZ = "http://lv2plug.in/ns/ext/buf-size#"
PARAMS = "http://lv2plug.in/ns/ext/parameters#"
WORKER = "http://lv2plug.in/ns/ext/worker#"


class _Host:
    """The minimal offline LV2 host the probe needs: a urid map, host options
    (sample rate + block sizes — DPF-based plugins refuse to instantiate without
    them), block-length guarantees, and a stub worker schedule that accepts jobs
    but never runs them (enough to satisfy `worker:schedule` as a required
    feature; a plugin whose latency depends on completed worker jobs simply
    reports its resting value). All ctypes callbacks/structs are kept as
    attributes so nothing is garbage-collected while plugins hold pointers.
    """

    def __init__(self, rate, block):
        import ctypes

        import lilv

        self.urids = {}

        map_fn = ctypes.CFUNCTYPE(ctypes.c_uint32, ctypes.c_void_p, ctypes.c_char_p)
        unmap_fn = ctypes.CFUNCTYPE(ctypes.c_char_p, ctypes.c_void_p, ctypes.c_uint32)
        sched_fn = ctypes.CFUNCTYPE(
            ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p
        )

        self._map_cb = map_fn(lambda _h, uri: self.map_uri(uri))
        self._unmap_cb = unmap_fn(lambda _h, urid: self._unmap(urid))
        self._sched_cb = sched_fn(lambda _h, _size, _data: 0)  # LV2_WORKER_SUCCESS

        class UridMap(ctypes.Structure):
            _fields_ = [("handle", ctypes.c_void_p), ("map", map_fn)]

        class UridUnmap(ctypes.Structure):
            _fields_ = [("handle", ctypes.c_void_p), ("unmap", unmap_fn)]

        class WorkerSchedule(ctypes.Structure):
            _fields_ = [("handle", ctypes.c_void_p), ("schedule_work", sched_fn)]

        class Option(ctypes.Structure):  # LV2_Options_Option
            _fields_ = [
                ("context", ctypes.c_uint32),
                ("subject", ctypes.c_uint32),
                ("key", ctypes.c_uint32),
                ("size", ctypes.c_uint32),
                ("type", ctypes.c_uint32),
                ("value", ctypes.c_void_p),
            ]

        self._map_data = UridMap(None, self._map_cb)
        self._unmap_data = UridUnmap(None, self._unmap_cb)
        self._sched_data = WorkerSchedule(None, self._sched_cb)

        self._rate_val = ctypes.c_float(float(rate))
        self._block_val = ctypes.c_int32(int(block))
        self._seq_size = ctypes.c_int32(16384)
        atom_float = self.map_uri(f"{ATOM}Float")
        atom_int = self.map_uri(f"{ATOM}Int")

        def opt(key, val, typ):
            return Option(0, 0, self.map_uri(key), 4, typ,
                          ctypes.cast(ctypes.byref(val), ctypes.c_void_p))

        self._options = (Option * 6)(
            opt(f"{PARAMS}sampleRate", self._rate_val, atom_float),
            opt(f"{BUFSZ}minBlockLength", self._block_val, atom_int),
            opt(f"{BUFSZ}maxBlockLength", self._block_val, atom_int),
            opt(f"{BUFSZ}nominalBlockLength", self._block_val, atom_int),
            opt(f"{BUFSZ}sequenceSize", self._seq_size, atom_int),
            Option(0, 0, 0, 0, 0, None),  # terminator
        )

        def feature(uri, data):
            ptr = ctypes.cast(ctypes.byref(data), ctypes.c_void_p) if data is not None else None
            return lilv.LV2_Feature(uri.encode(), ptr)

        self._features = [
            feature(f"{URID}map", self._map_data),
            feature(f"{URID}unmap", self._unmap_data),
            feature(f"{OPTIONS}options", self._options),
            feature(f"{WORKER}schedule", self._sched_data),
            feature(f"{BUFSZ}boundedBlockLength", None),
            feature(f"{BUFSZ}fixedBlockLength", None),
            feature(f"{BUFSZ}powerOf2BlockLength", None),
        ]
        arr = ctypes.POINTER(lilv.LV2_Feature) * (len(self._features) + 1)
        self.features = arr(*[ctypes.pointer(f) for f in self._features], None)

        self.world = lilv.World()
        self.world.load_all()
        self.u = {k: self.world.new_uri(k) for k in (
            LV2 + "AudioPort", LV2 + "ControlPort", LV2 + "CVPort",
            LV2 + "InputPort", LV2 + "OutputPort", ATOM + "AtomPort",
        )}
        self.rate = rate
        self.block = block
        self.seq_urid = self.map_uri(f"{ATOM}Sequence")

    def map_uri(self, uri):
        u = uri.decode() if isinstance(uri, bytes) else str(uri)
        if u not in self.urids:
            self.urids[u] = len(self.urids) + 1
        return self.urids[u]

    def _unmap(self, urid):
        for k, v in self.urids.items():
            if v == urid:
                return k.encode()
        return None


def probe_one(host, uri, symbol, cycles=DEFAULT_RUN_CYCLES):
    """Instantiate one plugin offline, run silence through it, read its latency port.

    Returns `(frames, reason)`: on success `frames` is a float and `reason` is
    None; on a soft failure (not installed, refused instantiation, port symbol
    not found) `frames` is None and `reason` explains it. A plugin that crashes
    outright takes the worker process down — the parent handles that.
    """
    import numpy as np

    import lilv

    plugin = host.world.get_all_plugins().get_by_uri(host.world.new_uri(uri))
    if plugin is None:
        return None, "not installed"
    instance = lilv.Instance(plugin, float(host.rate), host.features)
    if not instance.instance:
        # a required feature we don't provide, or the plugin vetoed the rate.
        del instance.instance  # avoid lilv.py's NULL deref in __del__
        return None, "instantiate failed"
    buffers = []  # keep every connected buffer alive for the plugin's lifetime
    latency_buf = None
    for i in range(plugin.get_num_ports()):
        port = plugin.get_port_by_index(i)
        if port.is_a(host.u[LV2 + "ControlPort"]):
            default, _mn, _mx = port.get_range()
            try:
                val = float(str(default)) if default is not None else 0.0
            except (ValueError, TypeError):
                val = 0.0
            buf = np.array([val], dtype=np.float32)
            if port.is_a(host.u[LV2 + "OutputPort"]) and str(port.get_symbol()) == symbol:
                latency_buf = buf
        elif port.is_a(host.u[ATOM + "AtomPort"]):
            # a minimal valid Atom Sequence: header {size,type} + empty body for
            # inputs; for outputs the size field advertises the buffer capacity.
            cap = 16384
            buf = np.zeros(cap // 4, dtype=np.uint32)
            buf[0] = 8 if port.is_a(host.u[LV2 + "InputPort"]) else cap - 8
            buf[1] = host.seq_urid
        else:
            # audio / CV / anything else: a block of silence is always safe.
            buf = np.zeros(host.block, dtype=np.float32)
        buffers.append(buf)
        instance.connect_port(i, buf)
    if latency_buf is None:
        return None, f"latency port {symbol!r} not found"
    instance.activate()
    for _ in range(cycles):
        instance.run(host.block)
    instance.deactivate()
    return float(latency_buf[0]), None


def audio_port_indices(host, plugin):
    """`(audio_in, audio_out)` port-index lists for a plugin."""
    audio_in, audio_out = [], []
    for i in range(plugin.get_num_ports()):
        port = plugin.get_port_by_index(i)
        if port.is_a(host.u[LV2 + "AudioPort"]):
            if port.is_a(host.u[LV2 + "InputPort"]):
                audio_in.append(i)
            elif port.is_a(host.u[LV2 + "OutputPort"]):
                audio_out.append(i)
    return audio_in, audio_out


def instantiate_connected(host, plugin, overrides=None):
    """Instantiate `plugin` and connect a live buffer to every one of its ports.

    Shared by the latency render ({@link render}) and the cost pass
    ({@link cost_one}) so both probe a plugin set up identically: control inputs at
    their `lv2:default` (or at `overrides`), Atom ports holding a minimal valid
    Sequence, audio/CV ports holding a block of silence the caller then fills.

    Returns `(instance, buffers, None)` — `buffers` maps port index to the numpy
    array connected to it, and MUST be kept alive as long as the instance is — or
    `(None, None, reason)` when the plugin refuses to instantiate.
    """
    import numpy as np

    import lilv

    instance = lilv.Instance(plugin, float(host.rate), host.features)
    if not instance.instance:
        del instance.instance  # avoid lilv.py's NULL deref in __del__
        return None, None, "instantiate failed"

    buffers = {}
    for i in range(plugin.get_num_ports()):
        port = plugin.get_port_by_index(i)
        if port.is_a(host.u[LV2 + "ControlPort"]):
            default, mn, mx = port.get_range()
            val = control_default(default, mn, mx)
            if overrides:
                val = overrides.get(str(port.get_symbol()), val)
            buf = np.array([val], dtype=np.float32)
        elif port.is_a(host.u[ATOM + "AtomPort"]):
            cap = 16384
            buf = np.zeros(cap // 4, dtype=np.uint32)
            buf[0] = 8 if port.is_a(host.u[LV2 + "InputPort"]) else cap - 8
            buf[1] = host.seq_urid
        else:  # audio / CV / anything else: a block of silence
            buf = np.zeros(host.block, dtype=np.float32)
        buffers[i] = buf
        instance.connect_port(i, buf)
    return instance, buffers, None


def is_threshold_control(symbol, name):
    """True when a control port looks like the threshold that keeps a gate shut.

    Pure name matching, deliberately narrow: `threshold`/`thres`/`thresh` in the
    symbol or the label. Pinned to its MINIMUM by the sustained fallback, which is
    the "open the gate via its own controls" half of measuring a processor that
    passes nothing at its defaults.
    """
    text = f"{symbol} {name}".lower()
    return any(k in text for k in ("threshold", "thresh", "thres"))


def render(host, plugin, n_blocks, impulse=True, overrides=None, preroll_blocks=0):
    """Run one fresh instance for `n_blocks` blocks; return its captured output.

    `impulse` selects the stimulus: a unit impulse at frame 0 (the measurement
    pass) or pure silence (the baseline pass whose difference isolates the real
    response). `overrides` maps a control-port SYMBOL to the value to pin it at,
    for the parameter sweep; every other control sits at its `lv2:default`.

    `preroll_blocks` runs that many blocks of a sustained tone through the plugin
    FIRST, discarding the output: a gate or threshold compressor needs a real
    signal before it will pass anything, and the impulse then arrives while the
    detector is still open. The pre-roll is identical on the impulse and baseline
    passes, so whatever it leaves ringing cancels in the difference.

    Returns `(captured, reason)` — a float32 array of `n_blocks * block` frames,
    or `(None, reason)` when the plugin refused to instantiate.
    """
    import numpy as np

    instance, buffers, reason = instantiate_connected(host, plugin, overrides)
    if instance is None:
        return None, reason

    block = host.block
    audio_in, audio_out = audio_port_indices(host, plugin)
    in_buf = buffers[audio_in[0]]   # measure the FIRST in -> FIRST out pair
    out_buf = buffers[audio_out[0]]
    captured = np.empty(n_blocks * block, dtype=np.float32)

    instance.activate()
    if preroll_blocks:
        phase = 2.0 * np.pi * PREROLL_TONE_HZ / float(host.rate)
        for blk in range(preroll_blocks):
            start = blk * block
            in_buf[:] = PREROLL_TONE_AMP * np.sin(
                phase * np.arange(start, start + block, dtype=np.float32))
            instance.run(block)  # output discarded: this only opens the plugin up
    in_buf[:] = 0.0
    if impulse:
        in_buf[0] = 1.0  # 1.0 at frame 0 of the first block only
    for blk in range(n_blocks):
        instance.run(block)
        captured[blk * block:(blk + 1) * block] = out_buf
        in_buf[:] = 0.0  # every subsequent block is silence
    instance.deactivate()
    return captured, None


def measure_one(host, uri, declared_frames=0.0, threshold=MEASURE_THRESHOLD,
                overrides=None, fallback=True):
    """Instantiate one plugin offline and MEASURE its real round-trip latency.

    A DIFFERENTIAL measurement: the plugin is rendered twice from a fresh
    instance, once fed a unit impulse and once fed silence, and the onset is
    detected on the difference. Everything the plugin emits irrespective of the
    stimulus — a DC offset, denormal fuzz, idle hiss, a deterministic internal
    LFO — cancels, so it can neither fake an early onset nor mask a quiet one.
    Control inputs are pinned to their defaults (or to `overrides`, for the
    parameter sweep) so the plugin runs at a stated operating point.

    When the impulse alone produces silence and `fallback` is set, the probe
    escalates rather than giving up: a sustained tone is held on the input first
    (opening a gate / expander / threshold compressor), and failing that the
    plugin's own threshold controls are pinned to their minimum. Either escalation
    is recorded in `stimulus`, since the figure then describes a stated non-default
    operating point instead of the resting one.

    Returns a small dict, exactly one key of:
      {"measuredFrames": <float>}   measured onset (frames), + optional "stimulus"
      {"unmeasurable": <reason>}    no audio in/out (instrument), or silent output
      {"error": <reason>}           not installed / refused / non-finite output
    A plugin that crashes outright takes the worker down — the parent handles it.
    """
    import numpy as np

    plugin = host.world.get_all_plugins().get_by_uri(host.world.new_uri(uri))
    if plugin is None:
        return {"error": "not installed"}

    audio_in, audio_out = audio_port_indices(host, plugin)
    if not audio_in:
        return {"unmeasurable": "no-audio-in"}
    if not audio_out:
        return {"unmeasurable": "no-audio-out"}

    total = capture_frames(declared_frames, host.rate)
    n_blocks = (total + host.block - 1) // host.block

    def attempt(preroll_blocks, controls):
        response, reason = render(host, plugin, n_blocks, impulse=True,
                                  overrides=controls, preroll_blocks=preroll_blocks)
        if response is None:
            return {"error": reason}
        baseline, reason = render(host, plugin, n_blocks, impulse=False,
                                  overrides=controls, preroll_blocks=preroll_blocks)
        if baseline is None:
            return {"error": reason}
        if not (np.all(np.isfinite(response)) and np.all(np.isfinite(baseline))):
            return {"error": "non-finite output"}
        onset = detect_onset(residual(response, baseline), threshold)
        if onset is None:
            return {"unmeasurable": "silent-output"}
        return {"measuredFrames": float(onset)}

    result = attempt(0, overrides)
    if fallback and result.get("unmeasurable") == "silent-output":
        # A gate / expander / threshold compressor passes nothing at rest, so the
        # impulse alone reads silent. Escalate: hold a tone on the input first,
        # then (if it is still shut) open its threshold controls right down. The
        # operating point is no longer the default, so it is recorded.
        preroll = int(PREROLL_SECONDS * host.rate) // host.block
        result = attempt(preroll, overrides)
        if "measuredFrames" in result:
            result["stimulus"] = "sustained"
        elif result.get("unmeasurable") == "silent-output":
            opened = dict(overrides or {})
            opened.update(threshold_overrides(host, plugin))
            if opened != (overrides or {}):
                result = attempt(preroll, opened)
                if "measuredFrames" in result:
                    result["stimulus"] = "sustained+open"
    return result


def timing_floor_ns(iters=COST_CALIBRATION_ITERS):
    """Median cost of the timing instrumentation itself, in ns per timed block.

    The cost loop brackets each `instance.run()` with two `perf_counter_ns()`
    calls, so every plugin figure carries that bracket plus one ctypes dispatch.
    This times the identical bracket around a no-op Python call, which captures the
    clock pair but NOT the ctypes dispatch — so it is a LOWER bound on the harness
    floor, and it is reported as such rather than subtracted from the plugin
    figures. Its job is to say which plugins are simply too cheap to rank apart.
    """
    clock = time.perf_counter_ns

    def noop(_frames):
        return None

    samples = []
    for _ in range(iters):
        t0 = clock()
        noop(0)
        samples.append(clock() - t0)
    return percentile(samples, 50.0)


def cost_one(host, uri, warmup=DEFAULT_COST_WARMUP, max_blocks=DEFAULT_COST_BLOCKS,
             min_blocks=COST_MIN_BLOCKS, target_seconds=COST_TARGET_SECONDS):
    """Instantiate one plugin offline and MEASURE its CPU cost per processed sample.

    A sustained 1 kHz sine at -6 dBFS is held on every audio input, phase-continuous
    across blocks, and the plugin is run block after block as fast as the machine
    will go (this is not a realtime test — it measures how much CPU one block costs,
    which is then normalised into a realtime budget fraction). Every block is timed
    individually with `perf_counter_ns`, so the answer is a DISTRIBUTION: the median
    is what the plugin usually costs, the p95 is what it costs on a bad block, and
    the gap between them is the xrun risk. Signal, not silence: a plugin that
    short-circuits on a silent input would otherwise be recorded as free.

    Buffer filling and every statistic are outside the timed region; the GC is off
    across the loop, so a collection cannot land inside a block and be charged to
    the plugin.

    Returns exactly one of:
      {"blockTimesNs": [...], "silentOutput": bool}   timings, warm-up head first
      {"unmeasurable": <reason>}   no audio in/out — nothing to insert, nothing to cost
      {"error": <reason>}          not installed / refused / non-finite output
    """
    import gc

    import numpy as np

    plugin = host.world.get_all_plugins().get_by_uri(host.world.new_uri(uri))
    if plugin is None:
        return {"error": "not installed"}
    audio_in, audio_out = audio_port_indices(host, plugin)
    if not audio_in:
        return {"unmeasurable": "no-audio-in"}
    if not audio_out:
        return {"unmeasurable": "no-audio-out"}

    instance, buffers, reason = instantiate_connected(host, plugin)
    if instance is None:
        return {"error": reason}

    block = host.block
    ins = [buffers[i] for i in audio_in]
    out_buf = buffers[audio_out[0]]
    phase = 2.0 * np.pi * COST_TONE_HZ / float(host.rate)
    clock = time.perf_counter_ns
    run = instance.run
    ramp = np.arange(block, dtype=np.float32)

    def drive(blk):
        """Hold the tone on every audio input for block `blk`. Never timed."""
        sig = COST_TONE_AMP * np.sin(phase * (blk * block + ramp))
        for buf in ins:
            buf[:] = sig

    times = []
    instance.activate()
    gc_was_on = gc.isenabled()
    gc.disable()
    try:
        blk = 0
        while blk < warmup:
            drive(blk)
            t0 = clock()
            run(block)
            times.append(clock() - t0)
            blk += 1
        spent = 0
        budget = int(target_seconds * 1e9)
        timed = 0
        while timed < max_blocks:
            drive(blk)
            t0 = clock()
            run(block)
            dt = clock() - t0
            times.append(dt)
            spent += dt
            timed += 1
            blk += 1
            if timed >= min_blocks and spent >= budget:
                # bounded on purpose: an expensive plugin gets its floor of blocks
                # and stops, so one convolution reverb cannot eat the whole sweep.
                break
    finally:
        if gc_was_on:
            gc.enable()
    instance.deactivate()

    if not np.all(np.isfinite(out_buf)):
        return {"error": "non-finite output"}
    return {"blockTimesNs": times,
            "silentOutput": bool(np.max(np.abs(out_buf)) == 0.0)}


def control_ranges(host, plugin, symbols):
    """`{symbol: (min, max)}` for the named control input ports of a plugin."""
    wanted = set(symbols)
    out = {}
    for i in range(plugin.get_num_ports()):
        port = plugin.get_port_by_index(i)
        if not (port.is_a(host.u[LV2 + "ControlPort"]) and port.is_a(host.u[LV2 + "InputPort"])):
            continue
        symbol = str(port.get_symbol())
        if symbol not in wanted:
            continue
        _default, mn, mx = port.get_range()
        try:
            out[symbol] = (float(str(mn)), float(str(mx)))
        except (ValueError, TypeError):
            continue
    return out


def sweep_control_latencies(host, uri, declared_frames, base_frames, symbols):
    """Re-measure a plugin with each candidate control pinned to each end of its range.

    Returns `{symbol: {"min": frames, "max": frames}}` — only the ends that
    measured. The capture window is sized off the DEFAULT measurement rather than
    the declared port, generously, because the whole point is that one of these
    controls may multiply the latency and a window sized for the resting value
    would truncate the answer and misread it as silence.
    """
    plugin = host.world.get_all_plugins().get_by_uri(host.world.new_uri(uri))
    if plugin is None:
        return {}
    hint = max(float(declared_frames or 0.0), float(base_frames)) * 8 + 16384
    out = {}
    for symbol, (mn, mx) in control_ranges(host, plugin, symbols).items():
        points = {}
        for end, value in (("min", mn), ("max", mx)):
            res = measure_one(host, uri, hint, overrides={symbol: value}, fallback=False)
            if "measuredFrames" in res:
                points[end] = res["measuredFrames"]
        if points:
            out[symbol] = points
    return out


def threshold_overrides(host, plugin):
    """`{symbol: minimum}` for every threshold-looking control port of a plugin.

    Pinning a gate's threshold to its minimum is the most direct way to make a
    processor that passes nothing at rest pass something — the "open the gate via
    its own controls" fallback.
    """
    out = {}
    for i in range(plugin.get_num_ports()):
        port = plugin.get_port_by_index(i)
        if not (port.is_a(host.u[LV2 + "ControlPort"]) and port.is_a(host.u[LV2 + "InputPort"])):
            continue
        symbol = str(port.get_symbol())
        name = str(port.get_name())
        if not is_threshold_control(symbol, name):
            continue
        _default, mn, _mx = port.get_range()
        try:
            out[symbol] = float(str(mn))
        except (ValueError, TypeError):
            continue
    return out


def worker_main(rate, block, measure=False, cost=False, cpu=None,
                warmup=DEFAULT_COST_WARMUP, blocks=DEFAULT_COST_BLOCKS):
    """The worker loop: JSON-lines protocol over stdio (see parse_worker_line).

    Loads the LV2 world once, announces readiness, then probes one plugin per
    input line. Runs in its own process so a crashing plugin kills only this
    loop; the parent respawns it and skips the culprit.

    In `cost` mode the worker first pins itself to ONE cpu (`cpu`). On a hybrid
    part — this host is an 8 P-core + 16 E-core Arrow Lake, whose two core types
    differ by ~600 MHz of peak clock — an unpinned measurement would silently
    compare plugins that happened to land on different core types, so the pinning
    is not a nicety. It is recorded in the run provenance.
    """
    if cost and cpu is not None:
        try:
            os.sched_setaffinity(0, {int(cpu)})
        except (OSError, ValueError) as e:  # noqa: BLE001 - report, don't die
            sys.stderr.write(f"  could not pin to cpu {cpu}: {e}\n")
    host = _Host(rate, block)
    ready = {"ready": True, "rate": rate}
    if cost:
        ready["timingFloorNs"] = timing_floor_ns()
        ready["cpu"] = sorted(os.sched_getaffinity(0))
    print(json.dumps(ready), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        uri, _tab, arg = line.partition("\t")
        if cost:
            try:
                res = cost_one(host, uri, warmup=warmup, max_blocks=blocks)
            except Exception as e:  # noqa: BLE001 - report, don't die
                res = {"error": f"cost error: {e}"}
            if "blockTimesNs" in res:
                record = summarise_cost(res["blockTimesNs"], host.block, host.rate,
                                        warmup=warmup)
                if record is None:
                    print(json.dumps({"uri": uri, "error": "no steady-state blocks"}),
                          flush=True)
                    continue
                if res.get("silentOutput"):
                    record["silentOutput"] = True
                print(json.dumps({"uri": uri,
                                  "nsPerSample": record["nsPerSampleMedian"],
                                  "cost": record}), flush=True)
            elif "unmeasurable" in res:
                print(json.dumps({"uri": uri,
                                  "error": "unmeasurable:" + res["unmeasurable"]}),
                      flush=True)
            else:
                print(json.dumps({"uri": uri,
                                  "error": res.get("error", "unknown error")}),
                      flush=True)
            continue
        if measure:
            # `arg` is the declared-latency hint (frames) used to size the capture
            # so a genuinely-large latency isn't truncated. Onset is measured, not
            # trusted from the port. Soft failures and "unmeasurable" (instrument
            # / silent) both come back as errors so the parent's batch loop, which
            # only distinguishes frames-vs-error, needs no changes; the parent then
            # splits the "unmeasurable:" prefix back out.
            job = parse_measure_job(arg)
            declared = job["declared"]
            try:
                res = measure_one(host, uri, declared)
                if "measuredFrames" in res and job["sweep"]:
                    swept = sweep_control_latencies(
                        host, uri, declared, res["measuredFrames"], job["sweep"])
                    if swept:
                        res["sweep"] = swept
            except Exception as e:  # noqa: BLE001 - report, don't die
                res = {"error": f"probe error: {e}"}
            if "measuredFrames" in res:
                reply = {"uri": uri, "frames": res["measuredFrames"]}
                for key in ("stimulus", "sweep"):
                    if key in res:
                        reply[key] = res[key]
                print(json.dumps(reply), flush=True)
            elif "unmeasurable" in res:
                print(json.dumps({"uri": uri, "error": "unmeasurable:" + res["unmeasurable"]}), flush=True)
            else:
                print(json.dumps({"uri": uri, "error": res.get("error", "unknown error")}), flush=True)
            continue
        symbol = arg
        try:
            frames, reason = probe_one(host, uri, symbol)
        except Exception as e:  # noqa: BLE001 - report, don't die, on python-level errors
            frames, reason = None, f"probe error: {e}"
        if frames is None:
            print(json.dumps({"uri": uri, "error": reason}), flush=True)
        else:
            print(json.dumps({"uri": uri, "frames": frames}), flush=True)


# --- the parent: batch loop with crash containment -----------------------------


class _Worker:
    """Handle on one worker subprocess: spawn, job/reply exchange, kill."""

    def __init__(self, cmd, boot_timeout):
        self.proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1,
        )
        ready = self._read_line(boot_timeout)
        parsed = parse_worker_line(ready)
        if not (parsed and parsed.get("ready")):
            self.close()
            raise OSError("worker did not become ready")
        # what the worker learned about itself at boot (cost mode: its timing floor
        # and the cpu set it actually got pinned to) — run provenance, not a result.
        self.info = {k: v for k, v in parsed.items() if k != "ready"}

    def _read_line(self, timeout):
        """One stdout line within `timeout` seconds, or None (timeout/EOF; EOF sets `self.eof`)."""
        self.eof = False
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            readable, _, _ = select.select([self.proc.stdout], [], [], remaining)
            if not readable:
                return None
            line = self.proc.stdout.readline()
            if line == "":
                self.eof = True
                return None  # EOF — the worker died
            if line.strip():
                return line

    def probe(self, uri, symbol, timeout):
        """Send one job, wait for its reply. Raises OSError if the worker died."""
        try:
            self.proc.stdin.write(format_job(uri, symbol) + "\n")
            self.proc.stdin.flush()
        except (OSError, ValueError) as e:
            raise OSError(f"worker gone: {e}") from e
        line = self._read_line(timeout)
        if line is None and (self.eof or self.proc.poll() is not None):
            # EOF on the reply channel IS the death: the exit may not be reaped yet (a loaded
            # host), so wait for it rather than reading a not-yet-reaped worker as a timeout.
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            raise OSError(f"worker crashed (exit {self.proc.returncode})")
        return parse_worker_line(line)

    def close(self):
        try:
            if self.proc.poll() is None:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait(timeout=5)
        except OSError:
            pass


def default_worker_cmd(rate, block, measure=False):
    """This same script, in --worker mode, under the same interpreter."""
    cmd = [sys.executable, os.path.abspath(__file__), "--worker",
           "--rate", str(rate), "--block", str(block)]
    if measure:
        cmd.append("--measure")
    return cmd


def describe_latency(uri, value, extra, rate):
    """The batch loop's progress line for a latency probe. Pure."""
    stimulus = extra.get("stimulus") if isinstance(extra, dict) else None
    return (f"  {uri}: {value:.0f} frames ({value / rate * 1000:.3f} ms @ {rate} Hz)"
            + (f" [{stimulus}]" if stimulus else ""))


def describe_cost(uri, value, extra, rate):
    """The batch loop's progress line for a cost probe. Pure."""
    record = extra.get("cost") if isinstance(extra, dict) else None
    p95 = record.get("nsPerSampleP95") if isinstance(record, dict) else None
    blocks = record.get("blocks") if isinstance(record, dict) else None
    fraction = core_fraction(value, rate) or 0.0
    return (f"  {uri}: {value:.2f} ns/sample median"
            + (f", {p95:.2f} p95" if p95 is not None else "")
            + f" ({fraction * 100:.3f} % of a core @ {rate} Hz"
            + (f", {blocks} blocks)" if blocks else ")"))


def measure_offline(targets, rate, worker_cmd, timeout=DEFAULT_TIMEOUT,
                    boot_timeout=DEFAULT_BOOT_TIMEOUT, isolate=False,
                    job_arg=latency_port_symbol, value_key="frames", describe=None):
    """Probe each target in a worker subprocess → BenchmarkResult.

    One finicky plugin must never abort the batch: a plugin that crashes or
    times out is recorded as failed (with a reason), the worker is respawned,
    and the run continues with the remaining plugins. With `isolate=True` every
    plugin gets its own fresh worker (LV2 world reloaded each time) so a crash
    can't even perturb the next measurement; the default reuses one worker and
    only respawns after a crash/timeout.

    `worker_cmd` is the argv used to spawn a worker — injectable so the smoke
    test can drive this whole loop with a stub instead of real LV2 plugins.

    `job_arg`, `value_key` and `describe` are what let the CPU-cost pass reuse this
    loop verbatim instead of forking a second copy of the crash-containment: cost
    jobs carry no per-plugin argument, answer with `nsPerSample` instead of
    `frames`, and log a different line. Everything about spawning, timeouts, desync
    detection and respawn is identical, because it is the same code.
    """
    measured = {}
    failures = {}
    details = {}
    worker_info = {}

    def spawn():
        try:
            return _Worker(worker_cmd, boot_timeout)
        except OSError as e:
            sys.stderr.write(f"  worker spawn failed: {e}\n")
            return None

    worker = None
    try:
        for i, d in enumerate(targets):
            uri = d["uri"]
            symbol = job_arg(d)
            if worker is None:
                worker = spawn()
                if worker is None:
                    for later in targets[i:]:
                        failures.setdefault(later["uri"], "worker unavailable")
                    break
                worker_info = worker_info or worker.info
            try:
                reply = worker.probe(uri, symbol, timeout)
            except OSError as e:
                failures[uri] = f"worker crashed ({e})"
                sys.stderr.write(f"  worker crashed on {uri}: {e}\n")
                worker.close()
                worker = None
                continue
            if reply is None:
                # no reply in time (or garbage): blame the plugin, get a clean
                # worker — the stuck probe may still be wedged inside run().
                failures[uri] = "probe timed out"
                sys.stderr.write(f"  probe timed out: {uri}\n")
                worker.close()
                worker = None
                continue
            if reply.get("uri") != uri:
                failures[uri] = "worker desync"
                sys.stderr.write(f"  worker desync on {uri}: {reply!r}\n")
                worker.close()
                worker = None
                continue
            if value_key in reply:
                value = float(reply[value_key])
                measured[uri] = value
                extra = {k: v for k, v in reply.items() if k not in ("uri", value_key)}
                if extra:
                    details[uri] = extra
                sys.stderr.write(
                    (describe or describe_latency)(uri, value, extra, rate) + "\n")
            else:
                failures[uri] = str(reply.get("error", "unknown error"))
                sys.stderr.write(f"  {failures[uri]}: {uri}\n")
            if isolate and worker is not None:
                worker.close()
                worker = None
    finally:
        if worker is not None:
            worker.close()
    return BenchmarkResult(measured, failures, details, worker_info)


def measure_declared_frames(descriptor):
    """The declared latency (reportedFrames) for a descriptor, else 0.0.

    Comes from a prior declared-latency run; used both to size the capture window
    and to compute declaredMismatch against the fresh measurement.
    """
    lat = descriptor.get("latency")
    if isinstance(lat, dict):
        try:
            return float(lat.get("reportedFrames") or 0.0)
        except (ValueError, TypeError):
            return 0.0
    return 0.0


def split_unmeasurable(failures):
    """Split a failures map into `(unmeasurable, real_failures)`.

    The worker reports "there is nothing to time here" (an instrument, a silent
    output) as an `unmeasurable:<reason>` error so the batch loop, which only
    distinguishes frames-vs-error, needs no special case. Splitting them back out
    keeps a quarantined plugin distinct from a crashed one in the report and in
    the catalog.
    """
    unmeasurable = {u: r.split("unmeasurable:", 1)[1]
                    for u, r in failures.items() if r.startswith("unmeasurable:")}
    real = {u: r for u, r in failures.items() if not r.startswith("unmeasurable:")}
    return unmeasurable, real


def measure_at_rate(catalog, rate, args, sweep=False):
    """Measure every plugin in `catalog` at one sample rate → a per-rate run dict.

    Every plugin is a target (not just those with a declared latency port): the
    whole point is to catch declared-0-but-measured-nonzero. The declared frames
    (and, with `sweep`, the controls worth pinning) ride in the job's second field
    via a shim descriptor, so the worker can size each capture and run the sweep
    without any change to the batch loop.
    """
    block = args.block if args.block != DEFAULT_BLOCK else DEFAULT_MEASURE_BLOCK
    targets = [{"uri": d["uri"],
                "latency": {"portSymbol": format_measure_job(
                    measure_declared_frames(d),
                    sweep_candidates(d.get("params") or []) if sweep else ())}}
               for d in catalog]
    worker_cmd = (shlex.split(args.worker_cmd) if args.worker_cmd
                  else default_worker_cmd(rate, block, measure=True))
    result = measure_offline(targets, rate, worker_cmd,
                             timeout=args.timeout, isolate=args.isolate)
    unmeasurable, failures = split_unmeasurable(result.failures)
    return {"measured": result.measured, "unmeasurable": unmeasurable,
            "failures": failures, "details": result.details}


# --- the CPU-cost run ----------------------------------------------------------


def read_text(path):
    """File contents, or None when it isn't there (sysfs varies by machine)."""
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def performance_cpus():
    """The performance-core cpu ids on a hybrid x86 part, else []. Reads sysfs.

    Intel's hybrid parts expose their two core types as separate PMUs:
    `/sys/devices/cpu_core/cpus` is the P-cores, `cpu_atom` the E-cores. A uniform
    part has neither and the caller falls back to whatever it is allowed to run on.
    """
    text = read_text("/sys/devices/cpu_core/cpus")
    return parse_cpu_list(text) if text else []


def choose_cost_cpu():
    """The cpu to pin the cost worker to: the LAST performance core we may use.

    Last, not first: cpu0 fields most of the machine's interrupt load, and an
    interrupt landing inside a timed block is exactly the tail noise the p95 is
    supposed to be measuring the plugin for, not the kernel.
    """
    allowed = sorted(os.sched_getaffinity(0))
    if not allowed:
        return None
    perf = [c for c in performance_cpus() if c in allowed]
    return (perf or allowed)[-1]


def host_provenance(cpu, rates, block, warmup, blocks, timing_floor_ns_value=None):
    """The machine + settings a cost figure is only meaningful next to.

    A cost number without its host is a decoration: the same plugin is cheaper on a
    P-core than an E-core, cheaper with the performance governor than powersave,
    and cheaper with turbo than without. Everything recorded here is read from the
    machine at run time, never assumed.
    """
    cpuinfo = read_text("/proc/cpuinfo") or ""
    governor = (read_text("/sys/devices/system/cpu/cpu%d/cpufreq/scaling_governor" % cpu)
                if cpu is not None else None)
    max_khz = (read_text("/sys/devices/system/cpu/cpu%d/cpufreq/cpuinfo_max_freq" % cpu)
               if cpu is not None else None)
    no_turbo = read_text("/sys/devices/system/cpu/intel_pstate/no_turbo")
    uname = os.uname()
    perf = performance_cpus()
    return {
        "proberVersion": COST_PROBER_VERSION,
        "measuredAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "host": uname.nodename,
        "kernel": uname.release,
        "python": sys.version.split()[0],
        "cpuModel": parse_cpu_model(cpuinfo),
        "cpuCount": os.cpu_count(),
        "pinnedCpu": cpu,
        "pinnedCpuKind": ("performance" if cpu in perf else "efficiency") if perf else "uniform",
        "pinnedCpuMaxKHz": int(max_khz.strip()) if max_khz and max_khz.strip().isdigit() else None,
        "governor": governor.strip() if governor else None,
        "turboEnabled": (no_turbo.strip() == "0") if no_turbo else None,
        "realtimePriority": False,
        "memoryLocked": False,
        "rates": list(rates),
        "referenceRate": COST_REFERENCE_RATE,
        "blockFrames": block,
        "warmupBlocks": warmup,
        "maxTimedBlocks": blocks,
        "minTimedBlocks": COST_MIN_BLOCKS,
        "targetSecondsPerPlugin": COST_TARGET_SECONDS,
        "percentile": COST_PERCENTILE,
        "stimulus": (f"sustained {COST_TONE_HZ:.0f} Hz sine at "
                     f"{COST_TONE_AMP} full-scale on every audio input, "
                     "phase-continuous across blocks"),
        "controls": "lv2:default on every control input",
        "timingFloorNsPerBlock": timing_floor_ns_value,
        "relativeRankingOnly": True,
        "note": ("A RELATIVE ranking measured on one machine, not a guarantee on "
                 "any other. Customer hardware with a different core, a different "
                 "governor or a busier machine will produce different absolute "
                 "figures; what carries over is the ORDER and the rough ratios."),
    }


def default_cost_worker_cmd(rate, block, cpu, warmup, blocks):
    """This same script, in --worker --cost mode, under the same interpreter."""
    cmd = [sys.executable, os.path.abspath(__file__), "--worker", "--cost",
           "--rate", str(rate), "--block", str(block),
           "--cost-warmup", str(warmup), "--cost-blocks", str(blocks)]
    if cpu is not None:
        cmd += ["--cost-cpu", str(cpu)]
    return cmd


def cost_at_rate(catalog, rate, args, cpu):
    """Measure every plugin's CPU cost at one sample rate → a per-rate run dict.

    Every plugin is a target, including the ones with no audio ports: they come
    back as `unmeasurable` with a reason rather than being filtered out of the run
    silently, so the census at the end accounts for all 958.
    """
    worker_cmd = (shlex.split(args.worker_cmd) if args.worker_cmd
                  else default_cost_worker_cmd(rate, args.cost_block, cpu,
                                               args.cost_warmup, args.cost_blocks))
    # a cost probe runs hundreds of blocks where a latency probe runs a handful, so
    # the latency default would time out honest work; an explicit --timeout wins.
    timeout = DEFAULT_COST_TIMEOUT if args.timeout == DEFAULT_TIMEOUT else args.timeout
    result = measure_offline(catalog, rate, worker_cmd,
                             timeout=timeout, isolate=args.isolate,
                             job_arg=lambda _d: "", value_key="nsPerSample",
                             describe=describe_cost)
    unmeasurable, failures = split_unmeasurable(result.failures)
    measured = {uri: result.details.get(uri, {}).get("cost", {})
                for uri in result.measured}
    return {"measured": measured, "unmeasurable": unmeasurable,
            "failures": failures, "workerInfo": result.workerInfo}


def cost_distribution(annotated, rate=COST_REFERENCE_RATE):
    """`[(uri, nsPerSampleMedian, instancesPerCoreP95)]` at `rate`, cheapest first. Pure."""
    rows = []
    for d in annotated:
        cost = d.get("cpuCost")
        if not isinstance(cost, dict):
            continue
        record = (cost.get("perRate") or {}).get(str(rate))
        if not isinstance(record, dict):
            continue
        rows.append((d["uri"], record["nsPerSampleMedian"],
                     record.get("instancesPerCoreP95")))
    return sorted(rows, key=lambda r: r[1])


def run_cost(catalog, args):
    """Drive the CPU-cost measurement at every requested rate, annotate, write, report.

    Why this and not `lv2bench`, which is installed here and does benchmark LV2
    plugins: lv2bench (lilv 0.26.4) has no sample-rate option at all — it is wired
    to 48 kHz, so the per-rate requirement is simply unmeetable with it; its
    positional PLUGIN_URI argument is ignored, so it cannot be driven one plugin
    per process as a poor man's isolation; it has no crash containment, and on this
    host it segfaults on plugin 35 of 958 and takes the whole run with it; and it
    reports min/mean/max only, where max is one unlucky block and mean hides the
    tail. What it IS good for is an independent second opinion on the 34 plugins it
    survives, which `--cross-check` does against these numbers.
    """
    gated = args.run or os.environ.get("OPENMIXER_BENCH") == "1"
    if not gated:
        sys.stderr.write(
            "refusing to measure cost without --run (or OPENMIXER_BENCH=1).\n"
            f"The probe instantiates the host's real LV2 plugins; {len(catalog)} "
            "plugin(s) would be measured.\n"
        )
        sys.exit(2)

    rates = parse_rates(args.rates) if args.rates else [args.rate]
    cpu = args.cost_cpu if args.cost_cpu is not None else choose_cost_cpu()
    by_rate = {}
    floors = []
    for rate in rates:
        sys.stderr.write(f"== CPU cost of {len(catalog)} plugin(s) at {rate} Hz "
                         f"(block {args.cost_block}, cpu {cpu}) ==\n")
        run = cost_at_rate(catalog, rate, args, cpu)
        by_rate[rate] = run
        floor = run.get("workerInfo", {}).get("timingFloorNs")
        if floor is not None:
            floors.append(floor)
        sys.stderr.write(
            f"  {rate} Hz: measured {len(run['measured'])}  "
            f"unmeasurable {len(run['unmeasurable'])}  failed {len(run['failures'])}\n")

    annotated = annotate_cost(catalog, by_rate)
    text = json.dumps(annotated, indent=2, ensure_ascii=False)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text + "\n")
    else:
        print(text)

    provenance = host_provenance(cpu, rates, args.cost_block, args.cost_warmup,
                                 args.cost_blocks,
                                 percentile(floors, 50.0) if floors else None)
    if args.cost_provenance:
        with open(args.cost_provenance, "w", encoding="utf-8") as f:
            f.write(json.dumps(provenance, indent=2, ensure_ascii=False) + "\n")

    measured, unmeasurable, failed = cost_census(annotated)
    rows = cost_distribution(annotated)
    sys.stderr.write(
        f"cost measured {measured}/{len(catalog)}  unmeasurable {unmeasurable}  "
        f"failed {failed}\n")
    if rows:
        median_row = rows[len(rows) // 2]
        sys.stderr.write(
            f"  at {COST_REFERENCE_RATE} Hz — cheapest {rows[0][0]} "
            f"({rows[0][1]:.2f} ns/sample, {rows[0][2]} instances/core)\n"
            f"  median {median_row[0]} ({median_row[1]:.2f} ns/sample, "
            f"{median_row[2]} instances/core)\n"
            f"  dearest {rows[-1][0]} ({rows[-1][1]:.2f} ns/sample, "
            f"{rows[-1][2]} instances/core)\n")


def run_cross_check(catalog, args):
    """Compare our 48 kHz cost medians against an lv2bench TSV → an agreement report.

    lv2bench is quoted at 48 kHz and dies early, so the overlap is small; that is
    the point of reporting the miss counts alongside the ratios rather than only
    the plugins that agreed.
    """
    text = read_text(args.cross_check)
    if text is None:
        sys.stderr.write(f"cannot read lv2bench TSV: {args.cross_check}\n")
        sys.exit(2)
    theirs = parse_lv2bench_tsv(text)
    ours = {}
    for d in catalog:
        cost = d.get("cpuCost")
        record = (cost or {}).get("perRate", {}).get(str(args.rate))
        if isinstance(record, dict):
            ours[d["uri"]] = record["nsPerSampleMedian"]
    rows = compare_lv2bench(theirs, ours)
    both = [r for r in rows if r.get("ratio")]
    ratios = sorted(r["ratio"] for r in both)
    sys.stderr.write(
        f"cross-check @ {args.rate} Hz: {len(both)} plugin(s) in both, "
        f"{sum(1 for r in rows if r.get('reason') == 'only in lv2bench')} only in "
        f"lv2bench, {sum(1 for r in rows if r.get('reason') == 'only in ours')} "
        "only in ours\n")
    if ratios:
        sys.stderr.write(
            f"  ours/lv2bench ratio: median {percentile(ratios, 50.0):.3f}  "
            f"min {ratios[0]:.3f}  max {ratios[-1]:.3f}\n")
        for row in sorted(both, key=lambda r: r["ratio"]):
            sys.stderr.write(f"    {row['ratio']:6.3f}  {row['uri']}  "
                             f"(ours {row['ourNsPerSample']:.2f} ns/sample, "
                             f"lv2bench {row['theirNsPerSample']:.2f})\n")


def parse_rates(text):
    """`"44100,48000"` → `[44100, 48000]`, deduplicated and ordered. Pure."""
    rates = {int(part) for part in str(text).split(",") if part.strip()}
    return sorted(rates)


def scaling_census(annotated):
    """Count plugins per derived scaling class → an ordered {class: count} dict."""
    census = {}
    for d in annotated:
        lat = d.get("latency")
        if isinstance(lat, dict) and lat.get("scalingClass"):
            cls = lat["scalingClass"]
            census[cls] = census.get(cls, 0) + 1
    return dict(sorted(census.items()))


def param_dependent(annotated):
    """The URIs whose latency the sweep proved a control actually moves."""
    return [d["uri"] for d in annotated
            if isinstance(d.get("latency"), dict) and d["latency"].get("paramSweep")]


def run_reclassify(catalog, args):
    """Replay {@link reclassify} over an already-measured catalog, write it, report the census."""
    before = scaling_census(catalog)
    annotated = reclassify(catalog)
    after = scaling_census(annotated)
    payload = json.dumps(annotated, indent=2, ensure_ascii=False) + "\n"
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(payload)
    else:
        sys.stdout.write(payload)
    excluded = sum(len(d["latency"]["unreliableRates"]) for d in annotated
                   if isinstance(d.get("latency"), dict) and d["latency"].get("unreliableRates"))
    sys.stderr.write(
        f"reclassified from perRate (no plugin was probed)\n"
        f"  before: {before}\n"
        f"  after:  {after}\n"
        f"  {excluded} reading(s) excluded as unreliable\n"
        + (f"  -> {args.out}\n" if args.out else ""))


def run_measure(catalog, args):
    """Drive the round-trip MEASURE at every requested rate, annotate, write, report.

    The rate loop is the point: a plugin's latency is not one number, and which of
    the two laws it obeys (constant frames vs constant milliseconds) can only be
    read off measurements at more than one rate. Each rate gets its own worker (the
    rate is fixed at instantiation), and the results are folded together by
    {@link annotate_per_rate}, which also derives the scaling class.
    """
    gated = args.run or os.environ.get("OPENMIXER_BENCH") == "1"
    if not gated:
        sys.stderr.write(
            "refusing to measure without --run (or OPENMIXER_BENCH=1).\n"
            f"The probe instantiates the host's real LV2 plugins; {len(catalog)} "
            "plugin(s) would be measured.\n"
        )
        sys.exit(2)

    rates = parse_rates(args.rates) if args.rates else [args.rate]
    by_rate = {}
    all_failures = {}
    # The sweep runs at ONE rate only. Which controls are latency-bearing is a
    # property of the plugin, not of the rate, so paying for it four times over
    # would buy nothing; the reference rate is the one the flat fields quote.
    sweep_rate = REFERENCE_RATE if REFERENCE_RATE in rates else rates[0]
    for rate in rates:
        sweep = args.sweep and rate == sweep_rate
        sys.stderr.write(f"== measuring {len(catalog)} plugin(s) at {rate} Hz"
                         + (" (+ parameter sweep)" if sweep else "") + " ==\n")
        run = measure_at_rate(catalog, rate, args, sweep=sweep)
        by_rate[rate] = run
        for uri, reason in run["failures"].items():
            all_failures.setdefault(uri, {})[rate] = reason
        sys.stderr.write(
            f"  {rate} Hz: measured {len(run['measured'])}  "
            f"unmeasurable {len(run['unmeasurable'])}  failed {len(run['failures'])}\n"
        )

    annotated = annotate_per_rate(catalog, by_rate)
    text = json.dumps(annotated, indent=2, ensure_ascii=False)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text + "\n")
    else:
        print(text)

    # distribution + mismatch summary (the trustworthy-gate payoff)
    measured_any = {u for run in by_rate.values() for u in run["measured"]}
    reference = by_rate.get(REFERENCE_RATE) or by_rate[rates[0]]
    ref_rate = REFERENCE_RATE if REFERENCE_RATE in by_rate else rates[0]
    ms = {u: f / ref_rate * 1000.0 for u, f in reference["measured"].items()}
    live = sum(1 for v in ms.values() if v <= 5.0)
    studio = sum(1 for v in ms.values() if v > 5.0)
    mismatch = [d for d in annotated
                if isinstance(d.get("latency"), dict)
                and d["latency"].get("declaredMismatch")]
    quarantined = [d for d in annotated
                   if isinstance(d.get("latency"), dict)
                   and d["latency"].get("unmeasurable")]
    sys.stderr.write(
        f"measured {len(measured_any)}/{len(catalog)} plugin(s) at >=1 rate"
        + (f" -> {args.out}\n" if args.out else "\n")
    )
    sys.stderr.write(
        f"  at {ref_rate} Hz: live-tier (<=5 ms) {live}   studio (>5 ms) {studio}\n"
        f"  unmeasurable at every rate: {len(quarantined)}   "
        f"failed somewhere: {len(all_failures)}\n"
        f"  declaredMismatch: {len(mismatch)}\n"
        f"  scaling class: {scaling_census(annotated)}\n"
        f"  parameter-dependent latency: {len(param_dependent(annotated))}\n"
    )
    for uri, per_rate in all_failures.items():
        sys.stderr.write(f"  FAIL {uri}: {per_rate}\n")


def main():
    ap = argparse.ArgumentParser(description="Benchmark plugin latency offline via lilv.")
    ap.add_argument("--in", dest="inp", help="input catalog JSON")
    ap.add_argument("--out", help="write annotated catalog here (default: stdout)")
    ap.add_argument("--rate", type=int, default=DEFAULT_RATE, help="sample rate (Hz)")
    ap.add_argument("--rates",
                    help="comma-separated sample rates to MEASURE at, e.g. "
                         f"'{','.join(str(r) for r in DEFAULT_RATES)}'. Each rate is "
                         "measured in full and the scaling class (fixed-frame / "
                         "fixed-time / nonconforming) is derived from how the numbers "
                         "move. Without it, only --rate is measured.")
    ap.add_argument("--block", type=int, default=DEFAULT_BLOCK,
                    help="frames per run() block")
    ap.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT,
                    help="per-plugin probe timeout in seconds")
    ap.add_argument("--sweep", action="store_true",
                    help="also sweep the latency-bearing CONTROLS of each plugin "
                         f"(up to {SWEEP_MAX_CONTROLS} per plugin, ranked by name) at "
                         "each end of their range, and record the resulting latency "
                         "span. Runs at the reference rate only.")
    ap.add_argument("--isolate", action="store_true",
                    help="fresh worker per plugin (slower, fully crash-proof); "
                         "default reuses one worker and respawns on a crash")
    ap.add_argument("--worker-cmd",
                    help="override the worker argv (used by the smoke test)")
    ap.add_argument("--worker", action="store_true",
                    help="internal: run as the probing worker")
    ap.add_argument("--measure", action="store_true",
                    help="MEASURE real round-trip latency (impulse -> onset) for "
                         "every plugin, instead of reading the declared lv2:latency "
                         "port. Writes latency.{measuredFrames,measuredMs} + "
                         "declaredMismatch. Uses a 512-frame block by default.")
    ap.add_argument("--cost", action="store_true",
                    help="MEASURE per-plugin CPU cost: hold a sustained tone on "
                         "every audio input, time each processed block, and record "
                         "the steady-state distribution (median + p95 ns per sample) "
                         "into `cpuCost`, normalised to a fraction of one core's "
                         "realtime budget and to instances-per-core. Honours --rates.")
    ap.add_argument("--cost-block", type=int, default=DEFAULT_COST_BLOCK,
                    help="frames per timed block for --cost "
                         f"(default {DEFAULT_COST_BLOCK})")
    ap.add_argument("--cost-warmup", type=int, default=DEFAULT_COST_WARMUP,
                    help="blocks timed then DISCARDED before the steady-state window "
                         f"(default {DEFAULT_COST_WARMUP})")
    ap.add_argument("--cost-blocks", type=int, default=DEFAULT_COST_BLOCKS,
                    help="ceiling on timed steady-state blocks per plugin per rate "
                         f"(default {DEFAULT_COST_BLOCKS}); a plugin that spends "
                         f"{COST_TARGET_SECONDS} s stops early, never below "
                         f"{COST_MIN_BLOCKS}")
    ap.add_argument("--cost-cpu", type=int,
                    help="pin the cost worker to this cpu (default: the last "
                         "performance core this process may use)")
    ap.add_argument("--cost-provenance",
                    help="write the run's host/CPU/governor/settings provenance here "
                         "as JSON — the machine the cost figures are only meaningful "
                         "next to")
    ap.add_argument("--cross-check",
                    help="compare the catalog's recorded --cost medians against an "
                         "lv2bench TSV (lv2bench -b 512 -n 262144 -s 64 -o FILE) and "
                         "report the agreement. Reads only; measures nothing.")
    ap.add_argument("--run", action="store_true",
                    help="actually probe plugins (needs them installed). "
                         "Also OPENMIXER_BENCH=1.")
    ap.add_argument("--dry-run", action="store_true",
                    help="list the plugins that would be benchmarked, then exit")
    ap.add_argument("--reclassify", action="store_true",
                    help="re-derive scalingClass/unreliableRates/scalingNote from the "
                         "perRate figures already in the catalog. No probing, no LV2, "
                         "no --run: use it when a classification rule changes.")
    args = ap.parse_args()

    if args.worker:
        worker_main(args.rate, args.block if not args.cost else args.cost_block,
                    measure=args.measure, cost=args.cost, cpu=args.cost_cpu,
                    warmup=args.cost_warmup, blocks=args.cost_blocks)
        return

    if not args.inp:
        ap.error("--in is required")

    with open(args.inp, encoding="utf-8") as f:
        catalog = json.load(f)

    if args.cross_check:
        run_cross_check(catalog, args)
        return

    if args.cost:
        run_cost(catalog, args)
        return

    if args.reclassify:
        run_reclassify(catalog, args)
        return

    if args.measure:
        run_measure(catalog, args)
        return

    targets = benchmark_targets(catalog)

    if args.dry_run:
        sys.stderr.write(f"{len(targets)} plugin(s) report a latency port:\n")
        for d in targets:
            sys.stderr.write(f"  {d['uri']}  (port {latency_port_symbol(d)})\n")
        return

    gated = args.run or os.environ.get("OPENMIXER_BENCH") == "1"
    if not gated:
        sys.stderr.write(
            "refusing to run the benchmark without --run (or OPENMIXER_BENCH=1).\n"
            "The probe instantiates the host's real LV2 plugins; run it on a host\n"
            f"that has them installed. {len(targets)} plugin(s) would be "
            "benchmarked (see --dry-run).\n"
        )
        sys.exit(2)

    worker_cmd = (shlex.split(args.worker_cmd) if args.worker_cmd
                  else default_worker_cmd(args.rate, args.block))
    result = measure_offline(targets, args.rate, worker_cmd,
                             timeout=args.timeout, isolate=args.isolate)
    annotated = annotate(catalog, result.measured, args.rate)
    text = json.dumps(annotated, indent=2, ensure_ascii=False)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text + "\n")
        sys.stderr.write(
            f"annotated {len(result.measured)}/{len(targets)} plugin(s) -> {args.out}\n"
        )
    else:
        print(text)

    if result.failures:
        sys.stderr.write(f"{len(result.failures)} plugin(s) failed:\n")
        for uri, reason in result.failures.items():
            sys.stderr.write(f"  {uri}: {reason}\n")


if __name__ == "__main__":
    main()
