#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
"""
Unit tests for the latency benchmark's parsing, annotation, and crash handling.

These run anywhere — no LV2 plugins, no lilv. The pure protocol parsing and the
catalog merge are pinned against fixtures. `measure_offline`'s control flow is
driven through STUB WORKERS (tiny `python3 -c` scripts standing in for the real
lilv prober) so we can prove that one plugin crashing or hanging the worker
mid-batch is recorded and stepped over rather than aborting the whole run — the
failure mode this benchmark exists to survive. A final smoke test drives the
whole CLI (`--run --worker-cmd <stub>`) against a fixture catalog, so the regen
pipeline (targets → probe → annotate → write) is covered end to end without a
single real plugin.

Run:  python3 -m pytest tools/test_benchmark.py
  or: python3 tools/test_benchmark.py
"""
import json
import os
import shlex
import subprocess
import sys
import tempfile
import textwrap
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import benchmark as b  # noqa: E402
from _declarations import OPERATIONAL_RATE_FLOOR  # noqa: E402


# A small fixture catalog: one plugin with a latency port, one without.
FIXTURE = [
    {
        "uri": "http://lsp-plug.in/plugins/lv2/limiter_stereo",
        "name": "LSP Limiter",
        "lv2Class": "Limiter Plugin",
        "audioInputs": 2,
        "audioOutputs": 2,
        "hasMidiIn": False,
        "params": [],
        "latency": {"portSymbol": "out_latency"},
    },
    {
        "uri": "http://lsp-plug.in/plugins/lv2/compressor_stereo",
        "name": "LSP Compressor",
        "lv2Class": "Compressor Plugin",
        "audioInputs": 2,
        "audioOutputs": 2,
        "hasMidiIn": False,
        "params": [],
        # no latency block — a zero-latency plugin
    },
]


def stub_worker(body):
    """A worker argv running `body` (python) per job after announcing readiness.

    `body` sees `line` (the stripped job line) and must print one JSON reply per
    job, like the real worker. Used to simulate measured values, crashes, and
    hangs without any LV2 involvement.
    """
    src = textwrap.dedent("""
        import json, sys
        print(json.dumps({"ready": True}), flush=True)
        for raw in sys.stdin:
            line = raw.strip()
            if not line:
                continue
    """) + textwrap.indent(textwrap.dedent(body), "    ")
    return [sys.executable, "-c", src]


# The standard behaviour body: A/C measure, B crashes the worker, H hangs,
# S soft-fails.
BEHAVIOUR_BODY = """
uri, _, sym = line.partition("\\t")
if uri == "B":
    sys.exit(9)  # simulated: the plugin crashed the worker
if uri == "H":
    import time; time.sleep(60)  # simulated: probe wedged inside run()
if uri == "S":
    print(json.dumps({"uri": uri, "error": "instantiate failed"}), flush=True)
else:
    print(json.dumps({"uri": uri, "frames": {"A": 64.0, "C": 128.0}.get(uri, 0.0)}), flush=True)
"""


class ParseWorkerLine(unittest.TestCase):
    def test_ready_and_result_lines(self):
        self.assertEqual(b.parse_worker_line('{"ready": true}'), {"ready": True})
        self.assertEqual(b.parse_worker_line('{"uri": "u", "frames": 64.0}'),
                         {"uri": "u", "frames": 64.0})
        self.assertEqual(b.parse_worker_line('{"uri": "u", "error": "nope"}'),
                         {"uri": "u", "error": "nope"})

    def test_garbage_is_none_never_guessed(self):
        # a crashing plugin can spray arbitrary text onto stdout.
        self.assertIsNone(b.parse_worker_line(None))
        self.assertIsNone(b.parse_worker_line(""))
        self.assertIsNone(b.parse_worker_line("Segmentation fault"))
        self.assertIsNone(b.parse_worker_line("[1, 2, 3]"))  # JSON but not a dict

    def test_format_job_round_trips_a_uri_with_spaces(self):
        job = b.format_job("urn:some plugin", "out_latency")
        uri, _, sym = job.partition("\t")
        self.assertEqual((uri, sym), ("urn:some plugin", "out_latency"))


class BenchmarkTargets(unittest.TestCase):
    def test_only_plugins_with_a_latency_port(self):
        targets = b.benchmark_targets(FIXTURE)
        self.assertEqual([d["uri"] for d in targets],
                         ["http://lsp-plug.in/plugins/lv2/limiter_stereo"])

    def test_latency_port_symbol(self):
        self.assertEqual(b.latency_port_symbol(FIXTURE[0]), "out_latency")
        self.assertIsNone(b.latency_port_symbol(FIXTURE[1]))


class MergeLatency(unittest.TestCase):
    def test_merges_measured_frames_and_ms(self):
        merged = b.merge_latency(FIXTURE[0], frames=64, sample_rate=48000)
        lat = merged["latency"]
        self.assertEqual(lat["portSymbol"], "out_latency")  # preserved
        self.assertEqual(lat["reportedFrames"], 64)
        self.assertAlmostEqual(lat["reportedMs"], 64 / 48000 * 1000)
        self.assertEqual(lat["sampleRate"], 48000)

    def test_64_frames_at_48k_is_about_1p33ms(self):
        merged = b.merge_latency(FIXTURE[0], 64, 48000)
        self.assertAlmostEqual(merged["latency"]["reportedMs"], 1.3333, places=3)

    def test_none_frames_leaves_latency_untouched(self):
        merged = b.merge_latency(FIXTURE[0], None, 48000)
        self.assertEqual(merged["latency"], {"portSymbol": "out_latency"})
        self.assertNotIn("reportedMs", merged["latency"])

    def test_does_not_mutate_input(self):
        before = dict(FIXTURE[0]["latency"])
        b.merge_latency(FIXTURE[0], 64, 48000)
        self.assertEqual(FIXTURE[0]["latency"], before)


class Annotate(unittest.TestCase):
    def test_applies_measurements_and_passes_others_through(self):
        measured = {"http://lsp-plug.in/plugins/lv2/limiter_stereo": 64}
        out = b.annotate(FIXTURE, measured, 48000)
        # the limiter got annotated …
        limiter = next(d for d in out if d["uri"].endswith("limiter_stereo"))
        self.assertAlmostEqual(limiter["latency"]["reportedMs"], 1.3333, places=3)
        # … the compressor (no measurement) stayed exactly as it was: still no latency.
        comp = next(d for d in out if d["uri"].endswith("compressor_stereo"))
        self.assertNotIn("latency", comp)

    def test_zero_latency_plugin_with_a_port_reads_zero(self):
        # a plugin that DOES report a port but measures 0 frames is genuinely
        # zero-latency — distinct from "no port / unknown".
        measured = {"http://lsp-plug.in/plugins/lv2/limiter_stereo": 0}
        out = b.annotate(FIXTURE, measured, 48000)
        limiter = next(d for d in out if d["uri"].endswith("limiter_stereo"))
        self.assertEqual(limiter["latency"]["reportedFrames"], 0)
        self.assertEqual(limiter["latency"]["reportedMs"], 0.0)


class DetectOnset(unittest.TestCase):
    def test_first_sample_above_threshold_is_the_latency(self):
        # impulse straight through -> onset 0 (a plain gain/utility plugin).
        self.assertEqual(b.detect_onset([1.0, 0.0, 0.0], 1e-6), 0)
        # one-sample delay.
        self.assertEqual(b.detect_onset([0.0, 1.0, 0.0], 1e-6), 1)
        # look-ahead / linear-phase: response arrives after N silent samples.
        self.assertEqual(b.detect_onset([0.0] * 64 + [0.5], 1e-6), 64)

    def test_denormal_floor_is_ignored(self):
        # sub-threshold noise before the real onset must not be picked up.
        self.assertEqual(b.detect_onset([1e-9, -1e-8, 0.0, 0.3], 1e-6), 3)

    def test_negative_going_onset_is_detected_by_magnitude(self):
        self.assertEqual(b.detect_onset([0.0, 0.0, -0.9], 1e-6), 2)

    def test_silent_output_is_none_not_zero(self):
        # a genuinely silent response is unmeasurable, not "0 frames".
        self.assertIsNone(b.detect_onset([0.0, 0.0, 0.0], 1e-6))
        self.assertIsNone(b.detect_onset([], 1e-6))

    def test_leaked_dc_step_does_not_pull_the_onset_early(self):
        # A plugin leaking a small constant offset from frame 0 while the real
        # response arrives at 64. The old fixed 1e-6 floor read this as onset 0
        # (an "everything is zero-latency" false negative on the tier gate).
        samples = [1e-3] * 64 + [0.8] + [1e-3] * 8
        self.assertEqual(b.detect_onset(samples), 64)

    def test_denormal_fuzz_far_below_the_response_peak_is_ignored(self):
        samples = [1e-7, -2e-7, 3e-7] + [0.5]
        self.assertEqual(b.detect_onset(samples), 3)

    def test_a_very_quiet_response_is_measured_not_written_off(self):
        # peak -100 dBFS: far under the old 1e-6 floor, but a real response whose
        # onset (and therefore tier) we can and must recover.
        samples = [0.0] * 32 + [1e-5, -8e-6]
        self.assertEqual(b.detect_onset(samples), 32)

    def test_relative_criterion_scales_with_the_response(self):
        # the same shape scaled by 1e-4 gives the same onset — no magic level.
        loud = [0.0] * 10 + [1.0, 0.5]
        quiet = [v * 1e-4 for v in loud]
        self.assertEqual(b.detect_onset(loud), b.detect_onset(quiet))

    def test_peak_under_the_absolute_backstop_is_silent(self):
        self.assertIsNone(b.detect_onset([1e-12, -1e-12, 5e-13]))


class Residual(unittest.TestCase):
    def test_common_mode_offset_cancels(self):
        # baseline = what the plugin emits with silence in; response = with the
        # impulse. Their difference is what the impulse actually caused.
        base = [0.01, 0.01, 0.01, 0.01]
        resp = [0.01, 0.01, 0.51, 0.01]
        self.assertEqual(list(b.residual(resp, base)), [0.0, 0.0, 0.5, 0.0])
        self.assertEqual(b.detect_onset(b.residual(resp, base)), 2)

    def test_truncates_to_the_common_length(self):
        self.assertEqual(list(b.residual([1.0, 2.0, 3.0], [0.0, 1.0])), [1.0, 1.0])


class DcLevel(unittest.TestCase):
    def test_median_finds_a_leaked_offset_not_the_response(self):
        self.assertAlmostEqual(b.dc_level([0.01] * 9 + [0.9]), 0.01)

    def test_no_offset_is_zero(self):
        self.assertEqual(b.dc_level([0.0, 0.0, 1.0, 0.0]), 0.0)
        self.assertEqual(b.dc_level([]), 0.0)


class PeakAndFirstAbove(unittest.TestCase):
    def test_peak_abs(self):
        self.assertEqual(b.peak_abs([0.1, -0.9, 0.3]), 0.9)
        self.assertEqual(b.peak_abs([]), 0.0)

    def test_first_above(self):
        self.assertEqual(b.first_above([0.0, 0.2, 0.9], 0.1), 1)
        self.assertIsNone(b.first_above([0.0, 0.0], 0.1))


class CaptureFrames(unittest.TestCase):
    def test_declared_zero_uses_the_floor(self):
        self.assertEqual(b.capture_frames(0), b.DEFAULT_CAPTURE_FRAMES)
        self.assertEqual(b.capture_frames(None), b.DEFAULT_CAPTURE_FRAMES)

    def test_large_declared_gets_a_window_that_exceeds_it(self):
        self.assertGreater(b.capture_frames(48000), 48000)

    def test_capped_so_the_run_stays_bounded(self):
        self.assertEqual(b.capture_frames(10**9), b.MAX_CAPTURE_FRAMES)

    def test_window_is_a_time_span_so_it_scales_with_the_rate(self):
        # a fixed-TIME plugin's latency in frames doubles at 96 kHz; the capture
        # window has to follow or the onset falls off the end and reads silent.
        self.assertEqual(b.capture_frames(0, 96000), 2 * b.DEFAULT_CAPTURE_FRAMES)
        self.assertEqual(b.capture_frames(0, 192000), 4 * b.DEFAULT_CAPTURE_FRAMES)
        self.assertEqual(b.capture_frames(10**9, 96000), 2 * b.MAX_CAPTURE_FRAMES)

    def test_rates_below_48k_keep_the_48k_window(self):
        # 44.1 kHz needs no less time than 48; don't shrink the safety margin.
        self.assertEqual(b.capture_frames(0, 44100), b.DEFAULT_CAPTURE_FRAMES)


class ControlDefault(unittest.TestCase):
    def test_prefers_default_then_midpoint_then_zero(self):
        self.assertEqual(b.control_default("0.5", "0.0", "1.0"), 0.5)
        self.assertEqual(b.control_default(None, "0.0", "10.0"), 5.0)
        self.assertEqual(b.control_default(None, None, None), 0.0)


class AnnotateMeasured(unittest.TestCase):
    def test_declared_zero_but_measured_nonzero_is_a_mismatch(self):
        cat = [{"uri": "u", "name": "u"}]  # no declared latency at all
        out = b.annotate_measured(cat, {"u": 512.0}, {}, 48000)
        lat = out[0]["latency"]
        self.assertEqual(lat["measuredFrames"], 512.0)
        self.assertAlmostEqual(lat["measuredMs"], 512 / 48000 * 1000)
        self.assertTrue(lat["declaredMismatch"])

    def test_declared_matches_measured_within_tolerance(self):
        cat = [{"uri": "u", "latency": {"portSymbol": "l", "reportedFrames": 64.0}}]
        out = b.annotate_measured(cat, {"u": 65.0}, {}, 48000)
        self.assertFalse(out[0]["latency"]["declaredMismatch"])
        self.assertEqual(out[0]["latency"]["reportedFrames"], 64.0)  # preserved

    def test_unmeasurable_is_recorded_and_others_pass_through(self):
        cat = [{"uri": "u1", "name": "x"}, {"uri": "u2", "name": "y"}]
        out = b.annotate_measured(cat, {}, {"u1": "no-audio-in"}, 48000)
        self.assertEqual(out[0]["latency"]["unmeasurable"], "no-audio-in")
        self.assertNotIn("latency", out[1])


class ClassifyScaling(unittest.TestCase):
    def test_constant_frames_is_fixed_frame(self):
        # an FFT window / fixed look-ahead buffer: 1024 frames whatever the rate,
        # so the millisecond cost HALVES when the rate doubles.
        self.assertEqual(
            b.classify_scaling({44100: 1024.0, 48000: 1024.0, 96000: 1024.0, 192000: 1024.0}),
            "fixed-frame")

    def test_constant_milliseconds_is_fixed_time(self):
        # a 5 ms look-ahead limiter: the frame count doubles with the rate.
        self.assertEqual(
            b.classify_scaling({48000: 240.0, 96000: 480.0, 192000: 960.0}),
            "fixed-time")

    def test_44k1_fixed_time_is_not_mistaken_for_fixed_frame(self):
        # 5 ms at 44.1 kHz is 220.5 frames — close to 240 but not within tolerance.
        self.assertEqual(b.classify_scaling({44100: 220.0, 48000: 240.0}), "fixed-time")

    def test_all_zero_is_its_own_degenerate_class(self):
        # both laws hold trivially; calling it either would pollute the census.
        self.assertEqual(b.classify_scaling({48000: 0.0, 96000: 0.0}), "zero")

    def test_neither_law_is_flagged_nonconforming_not_averaged(self):
        # e.g. a plugin that switches algorithm above 48 kHz: 64 -> 4096 frames.
        self.assertEqual(b.classify_scaling({48000: 64.0, 96000: 4096.0}), "nonconforming")

    def test_one_rate_derives_nothing_and_says_so(self):
        self.assertEqual(b.classify_scaling({48000: 240.0}), "single-rate")
        self.assertEqual(b.classify_scaling({}), "unmeasured")

    def test_a_frame_of_rounding_still_reads_as_the_same_law(self):
        self.assertEqual(b.classify_scaling({48000: 1024.0, 96000: 1025.0}), "fixed-frame")

    def test_a_power_of_two_quantised_lookahead_is_still_fixed_time(self):
        # x42-dpl as measured: 1.33 ms held as 64/128/256 frames, but 44.1 kHz can
        # only manage 56 rather than 58.8. A 0.06 ms stagger is a quantised buffer,
        # not a different law.
        self.assertEqual(
            b.classify_scaling({44100: 56.0, 48000: 64.0, 96000: 128.0, 192000: 256.0}),
            "fixed-time")

    def test_a_real_law_break_is_still_flagged(self):
        # Calf's 4-band crossover as measured: 2.56 / 2.29 / 2.04 ms across the operational
        # rates themselves — no reading below the floor is needed to break the law.
        self.assertEqual(
            b.classify_scaling({44100: 114.0, 48000: 123.0, 96000: 220.0, 192000: 392.0}),
            "nonconforming")


class UnreliableReadings(unittest.TestCase):
    """The incoherent readings tabulated in issue #338, and the rounding they must not catch."""

    def test_an_interior_zero_between_two_nonzero_rates_is_condemned(self):
        # Gxjcm800pre as measured. No latency reads 16 frames at 48 kHz and 0 at 96.
        self.assertEqual(
            b.unreliable_readings({44100: 17.0, 48000: 16.0, 96000: 0.0, 192000: 40.0}),
            {96000: "impossible-zero"})

    def test_a_trailing_run_of_zeros_under_a_nonzero_rate_is_condemned(self):
        # Tal-Filter as measured: 462 frames at 44.1 kHz and nothing at any higher rate.
        self.assertEqual(
            b.unreliable_readings({44100: 462.0, 48000: 0.0, 96000: 0.0, 192000: 0.0}),
            {48000: "impossible-zero", 96000: "impossible-zero", 192000: "impossible-zero"})

    def test_an_all_zero_plugin_has_nothing_to_contradict(self):
        self.assertEqual(b.unreliable_readings({48000: 0.0, 96000: 0.0, 192000: 0.0}), {})

    def test_sub_frame_rounding_is_not_a_failed_measurement(self):
        # A true latency under one frame at the low rates honestly reads 0 there: 1 frame
        # at 192 kHz is a quarter of a frame at 48. Condemning this would flag half the
        # airwindows set.
        self.assertEqual(
            b.unreliable_readings({44100: 0.0, 48000: 0.0, 96000: 0.0, 192000: 1.0}), {})
        self.assertEqual(
            b.unreliable_readings({44100: 0.0, 48000: 0.0, 96000: 1.0, 192000: 2.0}), {})

    def test_a_zero_a_whole_frame_below_the_kindest_projection_is_condemned(self):
        # 3 frames at 96 kHz is 1.4 frames at 44.1 under the more forgiving law — visible,
        # so the zeros below it are the detector failing, not rounding.
        self.assertEqual(
            b.unreliable_readings({44100: 0.0, 48000: 0.0, 96000: 3.0, 192000: 5.0}),
            {44100: "impossible-zero", 48000: "impossible-zero"})


class CoherentClassification(unittest.TestCase):
    """Issue #338: `nonconforming` must not fire on the onset detector's own noise."""

    def test_a_dropped_reading_does_not_define_a_class(self):
        # ZamTube as measured: a flat 32-frame plugin with one failed reading, not a
        # plugin whose latency vanishes at 96 kHz and comes back at 192.
        per_rate = {44100: 32.0, 48000: 32.0, 96000: 0.0, 192000: 32.0}
        self.assertEqual(b.classify_scaling(per_rate), "fixed-frame")

    def test_sub_millisecond_incoherence_is_zero_class_not_a_flag(self):
        # GxMXR Distortion / GxMuff as measured: non-linear waveshapers whose onset lands
        # somewhere different at every rate, all of it inside a fraction of the budget.
        for per_rate in ({44100: 18.0, 48000: 17.0, 96000: 0.0, 192000: 49.0},
                         {44100: 24.0, 48000: 22.0, 96000: 0.0, 192000: 41.0},
                         {44100: 50.0, 48000: 49.0, 96000: 43.0, 192000: 45.0}):
            self.assertEqual(b.classify_scaling(per_rate), "zero")
            self.assertEqual(b.scaling_note(per_rate), "below-budget")

    def test_one_surviving_reading_derives_nothing(self):
        # Tal-Filter: three readings condemned leaves a single point, and a single point
        # is `single-rate` — not a class, and certainly not a flag.
        self.assertEqual(
            b.classify_scaling({44100: 462.0, 48000: 0.0, 96000: 0.0, 192000: 0.0}),
            "single-rate")

    def test_the_real_families_still_flag(self):
        # The four the flag exists for. Every one is coherent (no impossible reading) and
        # far past the budget, so no coherence rule may touch it.
        for name, per_rate in (
            ("Rubber Band Live", {44100: 2613.0, 48000: 2613.0, 96000: 4661.0, 192000: 8757.0}),
            ("Rubber Band R3", {44100: 7473.0, 48000: 7490.0, 96000: 6300.0, 192000: 14655.0}),
            ("Phaserotate", {44100: 1792.0, 48000: 1792.0, 96000: 2560.0, 192000: 5120.0}),
            ("Calf XOver4Band", {44100: 114.0, 48000: 123.0, 96000: 220.0, 192000: 392.0}),
        ):
            with self.subTest(name):
                self.assertEqual(b.unreliable_readings(per_rate), {})
                self.assertEqual(b.classify_scaling(per_rate), "nonconforming")
                self.assertIsNone(b.scaling_note(per_rate))

    def test_a_law_abiding_plugin_carries_no_note(self):
        self.assertIsNone(b.scaling_note({48000: 240.0, 96000: 480.0, 192000: 960.0}))
        self.assertIsNone(b.scaling_note({48000: 0.0, 96000: 0.0}))


class OperationalRates(unittest.TestCase):
    """Issue #345: a reading below the operational floor is informational for the class.

    The eight below are the reference sweep's own figures: each holds one millisecond figure at
    48/96/192 kHz and rounds its 44.1 kHz buffer to the 48 kHz FRAME count, which alone made it
    `nonconforming`. Spec: `lv2-measurement-interchange.md` §1a.
    """

    ROUNDED_AT_44K1 = (
        ("Calf PsyClipper", {44100: 256.0, 48000: 256.0, 96000: 512.0, 192000: 1024.0}),
        ("x42-Autotune", {44100: 1024.0, 48000: 1024.0, 96000: 2047.0, 192000: 4095.0}),
        ("LSP Multiband Clipper", {44100: 5745.0, 48000: 5892.0, 96000: 11785.0, 192000: 23571.0}),
        ("SWH Lookahead limiter (fixed latency)",
         {44100: 8191.0, 48000: 8191.0, 96000: 16383.0, 192000: 32767.0}),
        ("ReFine", {44100: 512.0, 48000: 512.0, 96000: 1024.0, 192000: 2048.0}),
    )

    ERRATIC_AT_THE_OPERATIONAL_RATES = (
        ("Rubber Band Live", {44100: 2613.0, 48000: 2613.0, 96000: 4661.0, 192000: 8757.0}),
        ("Rubber Band R3", {44100: 7473.0, 48000: 7490.0, 96000: 6300.0, 192000: 14655.0}),
        ("Calf XOver4Band", {44100: 114.0, 48000: 123.0, 96000: 220.0, 192000: 392.0}),
        ("Phaserotate", {44100: 1792.0, 48000: 1792.0, 96000: 2560.0, 192000: 5120.0}),
        ("LSP Beat Breather", {44100: 12584.0, 48000: 13337.0, 96000: 26746.0, 192000: 54784.0}),
        ("airwindows Galactic", {44100: 4593.0, 48000: 4593.0, 96000: 9060.0, 192000: 17992.0}),
        ("airwindows SubsOnly", {44100: 163.0, 48000: 179.0, 96000: 375.0, 192000: 767.0}),
    )

    def test_the_floor_is_the_declared_one(self):
        self.assertEqual(b.OPERATIONAL_RATE_FLOOR, OPERATIONAL_RATE_FLOOR)

    def test_a_44k1_rounding_does_not_flag_a_fixed_time_plugin(self):
        for name, per_rate in self.ROUNDED_AT_44K1:
            with self.subTest(name):
                self.assertEqual(b.classify_scaling(per_rate), "fixed-time")
                self.assertEqual(b.scaling_note(per_rate), "informational-rate")

    def test_the_sub_floor_reading_stays_in_the_record(self):
        lat = b.apply_coherence({}, dict(self.ROUNDED_AT_44K1[0][1]))
        self.assertEqual(lat["scalingClass"], "fixed-time")
        self.assertEqual(lat["scalingNote"], "informational-rate")
        self.assertNotIn("unreliableRates", lat)

    def test_a_plugin_erratic_at_the_operational_rates_stays_flagged(self):
        for name, per_rate in self.ERRATIC_AT_THE_OPERATIONAL_RATES:
            with self.subTest(name):
                self.assertEqual(b.classify_scaling(per_rate), "nonconforming")
                self.assertIsNone(b.scaling_note(per_rate))

    def test_a_fit_that_holds_over_every_reading_is_not_refitted(self):
        # GxMXR Distortion as measured: with the 96 kHz zero condemned, 48 and 192 kHz alone
        # land inside the 0.1 ms tolerance, but every reading together is sub-budget noise.
        per_rate = {44100: 18.0, 48000: 17.0, 96000: 0.0, 192000: 49.0}
        self.assertEqual(b.classify_scaling(per_rate), "zero")
        self.assertEqual(b.scaling_note(per_rate), "below-budget")

    def test_one_operational_reading_cannot_outvote_the_rest(self):
        # A run that measured 44.1 and 48 kHz only has no second operational reading to refit.
        self.assertEqual(b.classify_scaling({44100: 230.0, 48000: 256.0}), "nonconforming")
        self.assertIsNone(b.scaling_note({44100: 230.0, 48000: 256.0}))

    def test_the_floor_moves_the_verdict(self):
        # Perturbation: raise the floor to 96 kHz and Phaserotate (1792 frames at 48, then
        # 26.667 ms at 96 and 192) is a fixed-time plugin over what is left.
        per_rate = dict(self.ERRATIC_AT_THE_OPERATIONAL_RATES[3][1])
        saved = b.OPERATIONAL_RATE_FLOOR
        try:
            b.OPERATIONAL_RATE_FLOOR = 96000
            self.assertEqual(b.classify_scaling(per_rate), "fixed-time")
        finally:
            b.OPERATIONAL_RATE_FLOOR = saved
        self.assertEqual(b.classify_scaling(per_rate), "nonconforming")


class ApplyCoherence(unittest.TestCase):
    def test_records_the_excluded_reading_with_its_reason(self):
        lat = b.apply_coherence({}, {44100: 17.0, 48000: 16.0, 96000: 0.0, 192000: 40.0})
        self.assertEqual(lat["scalingClass"], "zero")
        self.assertEqual(lat["scalingNote"], "below-budget")
        self.assertEqual(lat["unreliableRates"],
                         [{"rate": 96000, "frames": 0.0, "reason": "impossible-zero"}])

    def test_stale_findings_are_cleared_so_a_replay_is_idempotent(self):
        stale = {"unreliableRates": [{"rate": 1, "frames": 0.0, "reason": "impossible-zero"}],
                 "scalingNote": "below-budget"}
        lat = b.apply_coherence(stale, {48000: 240.0, 96000: 480.0})
        self.assertEqual(lat["scalingClass"], "fixed-time")
        self.assertNotIn("unreliableRates", lat)
        self.assertNotIn("scalingNote", lat)


class Reclassify(unittest.TestCase):
    def test_rederives_from_the_perrate_already_in_the_catalog(self):
        cat = [{"uri": "u", "name": "u", "latency": {
            "scalingClass": "nonconforming",
            "perRate": {"44100": {"frames": 32.0, "ms": 0.73},
                        "48000": {"frames": 32.0, "ms": 0.67},
                        "96000": {"frames": 0.0, "ms": 0.0},
                        "192000": {"frames": 32.0, "ms": 0.17}}}}]
        out = b.reclassify(cat)
        self.assertEqual(out[0]["latency"]["scalingClass"], "fixed-frame")
        self.assertEqual(out[0]["latency"]["unreliableRates"][0]["rate"], 96000)
        # the measurement record itself is untouched — only its interpretation changed
        self.assertEqual(out[0]["latency"]["perRate"], cat[0]["latency"]["perRate"])

    def test_a_plugin_without_perrate_is_passed_through(self):
        cat = [{"uri": "u", "name": "u"}, {"uri": "v", "name": "v", "latency": {"reportedMs": 3}}]
        self.assertEqual(b.reclassify(cat), cat)


class ParseRates(unittest.TestCase):
    def test_parses_dedupes_and_orders(self):
        self.assertEqual(b.parse_rates("96000,48000,48000"), [48000, 96000])
        self.assertEqual(b.parse_rates("48000"), [48000])


class AnnotatePerRate(unittest.TestCase):
    def _by_rate(self, frames_by_rate, unmeasurable=None):
        runs = {r: {"measured": {"u": f}, "unmeasurable": {}}
                for r, f in frames_by_rate.items()}
        for rate, reason in (unmeasurable or {}).items():
            runs.setdefault(rate, {"measured": {}, "unmeasurable": {}})
            runs[rate]["measured"].pop("u", None)
            runs[rate]["unmeasurable"]["u"] = reason
        return runs

    def test_records_frames_and_ms_per_rate_plus_the_derived_class(self):
        cat = [{"uri": "u", "name": "u"}]
        out = b.annotate_per_rate(cat, self._by_rate({48000: 240.0, 96000: 480.0}))
        lat = out[0]["latency"]
        self.assertEqual(lat["perRate"]["48000"], {"frames": 240.0, "ms": 5.0})
        self.assertEqual(lat["perRate"]["96000"], {"frames": 480.0, "ms": 5.0})
        self.assertEqual(lat["scalingClass"], "fixed-time")

    def test_a_fixed_frame_plugin_costs_half_the_time_at_96k(self):
        cat = [{"uri": "u", "name": "u"}]
        out = b.annotate_per_rate(cat, self._by_rate({48000: 480.0, 96000: 480.0}))
        per = out[0]["latency"]["perRate"]
        self.assertAlmostEqual(per["48000"]["ms"], 10.0)
        self.assertAlmostEqual(per["96000"]["ms"], 5.0)
        self.assertEqual(out[0]["latency"]["scalingClass"], "fixed-frame")

    def test_flat_fields_stay_at_the_reference_rate_for_old_consumers(self):
        cat = [{"uri": "u", "name": "u"}]
        out = b.annotate_per_rate(cat, self._by_rate({48000: 240.0, 96000: 480.0}))
        lat = out[0]["latency"]
        self.assertEqual(lat["measuredFrames"], 240.0)
        self.assertAlmostEqual(lat["measuredMs"], 5.0)
        self.assertEqual(lat["sampleRate"], b.REFERENCE_RATE)

    def test_declared_cross_check_survives_the_multi_rate_fold(self):
        cat = [{"uri": "u", "latency": {"portSymbol": "l", "reportedFrames": 0.0}}]
        out = b.annotate_per_rate(cat, self._by_rate({48000: 512.0, 96000: 512.0}))
        self.assertTrue(out[0]["latency"]["declaredMismatch"])
        matching = [{"uri": "u", "latency": {"portSymbol": "l", "reportedFrames": 512.0}}]
        out = b.annotate_per_rate(matching, self._by_rate({48000: 512.0}))
        self.assertFalse(out[0]["latency"]["declaredMismatch"])

    def test_measurable_at_one_rate_only_is_measured_not_quarantined(self):
        cat = [{"uri": "u", "name": "u"}]
        out = b.annotate_per_rate(
            cat, self._by_rate({96000: 64.0}, unmeasurable={48000: "silent-output"}))
        lat = out[0]["latency"]
        self.assertNotIn("unmeasurable", lat)
        self.assertEqual(lat["scalingClass"], "single-rate")
        self.assertEqual(lat["measuredFrames"], 64.0)
        self.assertEqual(lat["sampleRate"], 96000)
        # the declared cross-check is only honest at the rate the port was read at.
        self.assertNotIn("declaredMismatch", lat)

    def test_unmeasurable_at_every_rate_stays_quarantined(self):
        cat = [{"uri": "u", "name": "u"}]
        out = b.annotate_per_rate(
            cat, self._by_rate({}, unmeasurable={48000: "no-audio-in", 96000: "no-audio-in"}))
        self.assertEqual(out[0]["latency"]["unmeasurable"], "no-audio-in")
        self.assertNotIn("perRate", out[0]["latency"])

    def test_untouched_plugins_pass_through(self):
        cat = [{"uri": "u", "name": "u"}, {"uri": "other", "name": "o"}]
        out = b.annotate_per_rate(cat, self._by_rate({48000: 1.0}))
        self.assertNotIn("latency", out[1])


def _ctl(symbol, name, mn=0.0, mx=1.0):
    return {"kind": "control", "symbol": symbol, "name": name, "min": mn, "max": mx}


class SweepCandidates(unittest.TestCase):
    def test_picks_the_controls_that_name_a_latency_mechanism(self):
        params = [_ctl("gain", "Gain"), _ctl("lk", "Lookahead"), _ctl("fft_sz", "FFT size")]
        self.assertEqual(b.sweep_candidates(params), ["lk", "fft_sz"])

    def test_a_fixed_control_cannot_move_anything_and_is_skipped(self):
        self.assertEqual(b.sweep_candidates([_ctl("lk", "Lookahead", 5.0, 5.0)]), [])
        self.assertEqual(b.sweep_candidates([{"kind": "control", "symbol": "lk",
                                              "name": "Lookahead"}]), [])

    def test_patch_params_are_not_swept(self):
        self.assertEqual(b.sweep_candidates([{"kind": "patch", "symbol": "ir",
                                              "name": "FFT window", "uri": "u"}]), [])

    def test_capped_per_plugin_most_specific_first(self):
        # an LSP-scale plugin: the cost bound is what makes the sweep affordable,
        # and the ranking is what makes the bound safe.
        params = [_ctl("mode", "Mode"), _ctl("q", "Quality"), _ctl("sz", "Size"),
                  _ctl("lk", "Lookahead"), _ctl("fft", "FFT")]
        self.assertEqual(b.sweep_candidates(params), ["lk", "fft", "sz"])

    def test_a_delay_time_is_deliberately_not_a_candidate(self):
        # moving the onset IS the effect of a delay line, not processing latency —
        # and 1998 ports of the 958 scanned would otherwise have matched.
        self.assertEqual(b.sweep_candidates([_ctl("time", "Delay time")]), [])


class SummariseSweep(unittest.TestCase):
    def test_a_lookahead_control_records_its_span(self):
        block = b.summarise_sweep(240.0, {"lk": {"min": 4.0, "max": 960.0}}, 48000)
        self.assertEqual(block["defaultFrames"], 240.0)
        self.assertEqual((block["minFrames"], block["maxFrames"]), (4.0, 960.0))
        self.assertAlmostEqual(block["maxMs"], 20.0)
        self.assertEqual(block["controls"]["lk"], {"minFrames": 4.0, "maxFrames": 960.0})
        self.assertEqual(block["rate"], 48000)

    def test_controls_that_do_not_move_the_latency_are_dropped(self):
        self.assertIsNone(b.summarise_sweep(240.0, {"mode": {"min": 240.0, "max": 241.0}}, 48000))

    def test_only_the_moving_controls_survive_alongside_a_static_one(self):
        block = b.summarise_sweep(
            240.0, {"mode": {"min": 240.0, "max": 240.0}, "lk": {"min": 0.0, "max": 960.0}}, 48000)
        self.assertEqual(list(block["controls"]), ["lk"])

    def test_a_half_measured_control_still_counts(self):
        # the max end may fail to measure (e.g. it silences the plugin); the min
        # end still proves the control is latency-bearing.
        block = b.summarise_sweep(240.0, {"lk": {"min": 0.0}}, 48000)
        self.assertEqual((block["minFrames"], block["maxFrames"]), (0.0, 240.0))

    def test_nothing_swept_is_no_block_at_all(self):
        self.assertIsNone(b.summarise_sweep(240.0, {}, 48000))


class MeasureJobPayload(unittest.TestCase):
    def test_round_trips_the_declared_hint_and_the_sweep_list(self):
        job = b.parse_measure_job(b.format_measure_job(512.0, ["lk", "fft"]))
        self.assertEqual(job, {"declared": 512.0, "sweep": ["lk", "fft"]})

    def test_a_bare_number_is_still_a_valid_job(self):
        self.assertEqual(b.parse_measure_job("512"), {"declared": 512.0, "sweep": []})
        self.assertEqual(b.format_measure_job(512.0), "512.0")

    def test_garbage_degrades_to_measuring_at_the_defaults(self):
        for bad in ("", None, "nonsense", "{not json"):
            self.assertEqual(b.parse_measure_job(bad), {"declared": 0.0, "sweep": []})

    def test_a_job_line_carrying_a_sweep_still_survives_format_job(self):
        job = b.format_measure_job(0.0, ["lk"])
        uri, _, arg = b.format_job("urn:x", job).partition("\t")
        self.assertEqual(uri, "urn:x")
        self.assertEqual(b.parse_measure_job(arg)["sweep"], ["lk"])


class ParamSweepAnnotation(unittest.TestCase):
    def test_the_sweep_lands_on_the_descriptor_with_its_span(self):
        by_rate = {48000: {"measured": {"u": 240.0}, "unmeasurable": {},
                           "details": {"u": {"sweep": {"lk": {"min": 0.0, "max": 960.0}}}}}}
        out = b.annotate_per_rate([{"uri": "u", "name": "u"}], by_rate)
        sweep = out[0]["latency"]["paramSweep"]
        self.assertEqual(sweep["maxFrames"], 960.0)
        self.assertAlmostEqual(sweep["maxMs"], 20.0)

    def test_a_stale_sweep_is_cleared_when_no_control_moves_anymore(self):
        cat = [{"uri": "u", "latency": {"paramSweep": {"maxFrames": 999.0}}}]
        by_rate = {48000: {"measured": {"u": 240.0}, "unmeasurable": {}, "details": {}}}
        self.assertNotIn("paramSweep", b.annotate_per_rate(cat, by_rate)[0]["latency"])


class IsThresholdControl(unittest.TestCase):
    def test_matches_the_control_that_keeps_a_gate_shut(self):
        self.assertTrue(b.is_threshold_control("thresh", "Threshold"))
        self.assertTrue(b.is_threshold_control("gt_threshold", "Gate threshold"))
        self.assertTrue(b.is_threshold_control("thres", "Thres"))

    def test_does_not_grab_unrelated_controls(self):
        self.assertFalse(b.is_threshold_control("attack", "Attack"))
        self.assertFalse(b.is_threshold_control("ratio", "Ratio"))
        self.assertFalse(b.is_threshold_control("gain", "Makeup gain"))


class SustainedStimulus(unittest.TestCase):
    def test_the_escalated_stimulus_is_recorded_against_the_measurement(self):
        # a gate measured only after a tone opened it: the figure describes THAT
        # operating point, and the catalog has to say so.
        by_rate = {48000: {"measured": {"u": 32.0}, "unmeasurable": {},
                           "details": {"u": {"stimulus": "sustained"}}}}
        out = b.annotate_per_rate([{"uri": "u", "name": "u"}], by_rate)
        self.assertEqual(out[0]["latency"]["stimulus"], "sustained")
        self.assertEqual(out[0]["latency"]["measuredFrames"], 32.0)

    def test_a_plain_impulse_measurement_carries_no_stimulus_marker(self):
        by_rate = {48000: {"measured": {"u": 32.0}, "unmeasurable": {}, "details": {}}}
        out = b.annotate_per_rate([{"uri": "u", "name": "u"}], by_rate)
        self.assertNotIn("stimulus", out[0]["latency"])

    def test_a_stale_stimulus_marker_is_cleared_when_re_measured(self):
        cat = [{"uri": "u", "latency": {"stimulus": "sustained", "measuredFrames": 9.0}}]
        by_rate = {48000: {"measured": {"u": 4.0}, "unmeasurable": {}, "details": {}}}
        self.assertNotIn("stimulus", b.annotate_per_rate(cat, by_rate)[0]["latency"])


class SplitUnmeasurable(unittest.TestCase):
    def test_quarantine_reasons_are_kept_apart_from_real_failures(self):
        un, real = b.split_unmeasurable(
            {"a": "unmeasurable:silent-output", "b": "worker crashed (exit -6)"})
        self.assertEqual(un, {"a": "silent-output"})
        self.assertEqual(real, {"b": "worker crashed (exit -6)"})


def _target(uri, sym="out_latency"):
    """A minimal benchmark target: a descriptor that reports a latency port."""
    return {"uri": uri, "name": uri, "latency": {"portSymbol": sym}}


class MeasureOfflineCrashHandling(unittest.TestCase):
    def test_batch_continues_after_a_plugin_crashes_the_worker(self):
        # The regression: B kills the worker mid-run; A (before) and C (after)
        # must still be measured, B recorded as failed, the worker respawned.
        targets = [_target("A"), _target("B"), _target("C")]
        result = b.measure_offline(targets, 48000, stub_worker(BEHAVIOUR_BODY),
                                   timeout=10, boot_timeout=30)
        self.assertEqual(result.measured, {"A": 64.0, "C": 128.0})
        self.assertIn("B", result.failures)
        self.assertIn("crashed", result.failures["B"])

    def test_soft_failures_are_recorded_without_losing_the_batch(self):
        targets = [_target("S"), _target("C")]
        result = b.measure_offline(targets, 48000, stub_worker(BEHAVIOUR_BODY),
                                   timeout=10, boot_timeout=30)
        self.assertEqual(result.measured, {"C": 128.0})
        self.assertEqual(result.failures["S"], "instantiate failed")

    def test_a_hanging_probe_times_out_and_the_batch_continues(self):
        targets = [_target("A"), _target("H"), _target("C")]
        result = b.measure_offline(targets, 48000, stub_worker(BEHAVIOUR_BODY),
                                   timeout=1.0, boot_timeout=30)
        self.assertEqual(result.measured, {"A": 64.0, "C": 128.0})
        self.assertEqual(result.failures["H"], "probe timed out")

    def test_isolate_gives_each_plugin_a_fresh_worker(self):
        # visible effect: with a worker that can only answer ONE job and then
        # exits, isolate mode still measures every target.
        one_shot = stub_worker("""
            uri, _, sym = line.partition("\\t")
            print(json.dumps({"uri": uri, "frames": 32.0}), flush=True)
            sys.exit(0)
        """)
        targets = [_target("A"), _target("B"), _target("C")]
        result = b.measure_offline(targets, 48000, one_shot,
                                   timeout=10, boot_timeout=30, isolate=True)
        self.assertEqual(result.measured, {"A": 32.0, "B": 32.0, "C": 32.0})
        self.assertEqual(result.failures, {})

    def test_remainder_marked_unavailable_when_the_worker_cannot_boot(self):
        never_ready = [sys.executable, "-c", "import sys; sys.exit(3)"]
        targets = [_target("A"), _target("B")]
        result = b.measure_offline(targets, 48000, never_ready,
                                   timeout=1.0, boot_timeout=5)
        self.assertEqual(result.measured, {})
        self.assertEqual(result.failures,
                         {"A": "worker unavailable", "B": "worker unavailable"})


class CliSmoke(unittest.TestCase):
    def test_full_pipeline_against_a_fixture_catalog(self):
        # scan fixture in → stub-probed frames → annotated catalog out. This is
        # the whole regen pipeline minus lilv, so it runs in CI.
        script = os.path.join(os.path.dirname(__file__), "benchmark.py")
        body = """
        uri, _, sym = line.partition("\\t")
        print(json.dumps({"uri": uri, "frames": 240.0}), flush=True)
        """
        with tempfile.TemporaryDirectory() as tmp:
            inp = os.path.join(tmp, "catalog.json")
            out = os.path.join(tmp, "annotated.json")
            with open(inp, "w", encoding="utf-8") as f:
                json.dump(FIXTURE, f)
            cmd = [sys.executable, script, "--in", inp, "--out", out, "--run",
                   "--rate", "48000",
                   "--worker-cmd", shlex.join(stub_worker(body))]
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            with open(out, encoding="utf-8") as f:
                annotated = json.load(f)
            limiter = next(d for d in annotated if d["uri"].endswith("limiter_stereo"))
            self.assertEqual(limiter["latency"]["reportedFrames"], 240.0)
            self.assertAlmostEqual(limiter["latency"]["reportedMs"], 5.0)
            self.assertEqual(limiter["latency"]["sampleRate"], 48000)
            # the plugin with no latency port is untouched.
            comp = next(d for d in annotated if d["uri"].endswith("compressor_stereo"))
            self.assertNotIn("latency", comp)

    def test_gate_refuses_without_run_flag(self):
        script = os.path.join(os.path.dirname(__file__), "benchmark.py")
        with tempfile.TemporaryDirectory() as tmp:
            inp = os.path.join(tmp, "catalog.json")
            with open(inp, "w", encoding="utf-8") as f:
                json.dump(FIXTURE, f)
            env = {k: v for k, v in os.environ.items() if k != "OPENMIXER_BENCH"}
            proc = subprocess.run([sys.executable, script, "--in", inp],
                                  capture_output=True, text=True, timeout=60, env=env)
            self.assertEqual(proc.returncode, 2)
            self.assertIn("refusing", proc.stderr)


class Percentile(unittest.TestCase):
    """The spread statistic the cost pass reports next to the median."""

    def test_empty_is_none_not_zero(self):
        self.assertIsNone(b.percentile([], 50.0))
        self.assertIsNone(b.percentile([], 95.0))

    def test_single_sample(self):
        self.assertEqual(b.percentile([7.0], 95.0), 7.0)

    def test_linear_interpolation_type7(self):
        self.assertEqual(b.percentile([1, 2, 3, 4], 50.0), 2.5)
        self.assertAlmostEqual(b.percentile(list(range(101)), 95.0), 95.0)

    def test_order_independent(self):
        self.assertEqual(b.percentile([4, 1, 3, 2], 50.0), 2.5)

    def test_out_of_range_clamps(self):
        self.assertEqual(b.percentile([1, 2, 3], -10.0), 1.0)
        self.assertEqual(b.percentile([1, 2, 3], 500.0), 3.0)

    def test_separates_fat_tail_from_median(self):
        blocks = [10.0] * 90 + [1000.0] * 10
        self.assertEqual(b.percentile(blocks, 50.0), 10.0)
        self.assertEqual(b.percentile(blocks, 95.0), 1000.0)

    def test_agrees_with_numpy_when_available(self):
        try:
            import numpy as np
        except ImportError:
            self.skipTest("numpy not installed")
        data = [3.0, 1.5, 9.0, 2.25, 7.75, 0.5, 4.0]
        for pct in (0.0, 25.0, 50.0, 95.0, 99.0, 100.0):
            self.assertAlmostEqual(b.percentile(data, pct),
                                   float(np.percentile(data, pct)), places=9)


class DropWarmup(unittest.TestCase):
    """Warm-up discard: positional and deliberately dumb."""

    def test_splits_head_from_tail(self):
        warm, steady = b.drop_warmup([1, 2, 3, 4, 5], 2)
        self.assertEqual(warm, [1, 2])
        self.assertEqual(steady, [3, 4, 5])

    def test_zero_or_negative_keeps_everything(self):
        self.assertEqual(b.drop_warmup([1, 2, 3], 0)[1], [1, 2, 3])
        self.assertEqual(b.drop_warmup([1, 2, 3], -5)[1], [1, 2, 3])

    def test_warmup_longer_than_run_leaves_nothing_steady(self):
        warm, steady = b.drop_warmup([1, 2], 10)
        self.assertEqual(warm, [1, 2])
        self.assertEqual(steady, [])

    def test_is_not_adaptive_a_late_spike_survives(self):
        # dropping 2 must not reach the expensive block at index 4.
        self.assertIn(900, b.drop_warmup([9, 9, 1, 1, 900, 1], 2)[1])


class RealtimeBudget(unittest.TestCase):
    """ns/sample -> fraction of one core -> instances per core."""

    def test_core_fraction(self):
        self.assertAlmostEqual(b.core_fraction(20.0, 96000), 0.00192, places=10)

    def test_doubles_with_the_rate(self):
        self.assertAlmostEqual(b.core_fraction(10.0, 96000) / b.core_fraction(10.0, 48000),
                               2.0, places=10)

    def test_non_positive_rate_has_no_answer(self):
        self.assertIsNone(b.core_fraction(10.0, 0))
        self.assertIsNone(b.core_fraction(10.0, -48000))

    def test_instances_floor_not_round(self):
        self.assertEqual(b.instances_per_core(0.25), 4)
        self.assertEqual(b.instances_per_core(1 / 3.9), 3)
        self.assertEqual(b.instances_per_core(1.0), 1)

    def test_zero_or_unknown_cost_has_no_instance_count(self):
        self.assertIsNone(b.instances_per_core(0.0))
        self.assertIsNone(b.instances_per_core(-1.0))
        self.assertIsNone(b.instances_per_core(None))


class SummariseCost(unittest.TestCase):
    """Block times -> one rate's cost record."""

    def test_drops_warmup_and_reports_steady_state(self):
        blocks = [5120] * 4 + [512] * 8
        rec = b.summarise_cost(blocks, 512, 48000, warmup=4)
        self.assertEqual(rec["nsPerSampleMedian"], 1.0)
        self.assertEqual(rec["blocks"], 8)
        self.assertEqual(rec["warmupBlocks"], 4)
        self.assertEqual(rec["blockFrames"], 512)

    def test_records_the_warmup_median_as_evidence(self):
        rec = b.summarise_cost([5120, 5120, 512, 512], 512, 48000, warmup=2)
        self.assertEqual(rec["warmupNsPerSampleMedian"], 10.0)
        self.assertEqual(rec["nsPerSampleMedian"], 1.0)

    def test_keeping_the_warmup_would_have_lied(self):
        blocks = [5120] * 4 + [512] * 4
        self.assertEqual(b.summarise_cost(blocks, 512, 48000, warmup=4)["nsPerSampleMedian"], 1.0)
        self.assertEqual(b.summarise_cost(blocks, 512, 48000, warmup=0)["nsPerSampleMedian"], 5.5)

    def test_fat_tail_shows_in_p95_not_the_median(self):
        blocks = [512] * 90 + [51200] * 10
        rec = b.summarise_cost(blocks, 512, 96000, warmup=0)
        self.assertEqual(rec["nsPerSampleMedian"], 1.0)
        self.assertEqual(rec["nsPerSampleP95"], 100.0)
        self.assertEqual(rec["nsPerSampleMax"], 100.0)
        # budgeting on the median would fit ~100x more instances than survive.
        self.assertGreater(b.instances_per_core(rec["coreFractionMedian"]),
                           rec["instancesPerCoreP95"] * 50)

    def test_no_steady_block_is_none_not_a_cheap_zero(self):
        self.assertIsNone(b.summarise_cost([100, 100], 512, 48000, warmup=10))
        self.assertIsNone(b.summarise_cost([100, 100], 0, 48000, warmup=0))

    def test_derived_figures_agree_with_the_primitives(self):
        rec = b.summarise_cost([5120] * 16, 512, 96000, warmup=0)
        self.assertEqual(rec["nsPerSampleMedian"], 10.0)
        self.assertAlmostEqual(rec["coreFractionP95"], b.core_fraction(10.0, 96000), places=12)
        self.assertEqual(rec["instancesPerCoreP95"],
                         b.instances_per_core(b.core_fraction(10.0, 96000)))


def cost_record(ns, rate):
    """A minimal per-rate cost record for annotation tests."""
    return {
        "nsPerSampleMedian": ns,
        "nsPerSampleP95": ns * 1.2,
        "coreFractionMedian": b.core_fraction(ns, rate),
        "coreFractionP95": b.core_fraction(ns * 1.2, rate),
        "instancesPerCoreP95": b.instances_per_core(b.core_fraction(ns * 1.2, rate)),
        "blocks": 512, "warmupBlocks": 64, "blockFrames": 512,
    }


class AnnotateCost(unittest.TestCase):
    """Folding a multi-rate cost run into the catalog."""

    def run_fixture(self):
        return {
            48000: {"measured": {"A": cost_record(10.0, 48000)},
                    "unmeasurable": {"B": "no-audio-in"}, "failures": {}},
            96000: {"measured": {"A": cost_record(20.0, 96000)},
                    "unmeasurable": {"B": "no-audio-in"},
                    "failures": {"C": "worker crashed (exit -6)"}},
        }

    def catalog(self):
        return [{"uri": "A"}, {"uri": "B"}, {"uri": "C"}, {"uri": "D"}]

    def test_writes_per_rate_and_flat_reference_figures(self):
        out = b.annotate_cost(self.catalog(), self.run_fixture())
        entry = next(d for d in out if d["uri"] == "A")["cpuCost"]
        self.assertEqual(sorted(entry["perRate"]), ["48000", "96000"])
        self.assertEqual(entry["referenceRate"], 96000)
        self.assertEqual(entry["nsPerSampleMedian"], 20.0)
        self.assertEqual(entry["instancesPerCoreP95"],
                         entry["perRate"]["96000"]["instancesPerCoreP95"])

    def test_cost_is_not_rate_invariant_and_both_rates_are_kept(self):
        out = b.annotate_cost(self.catalog(), self.run_fixture())
        per_rate = next(d for d in out if d["uri"] == "A")["cpuCost"]["perRate"]
        self.assertEqual(per_rate["48000"]["nsPerSampleMedian"], 10.0)
        self.assertEqual(per_rate["96000"]["nsPerSampleMedian"], 20.0)

    def test_unmeasurable_is_recorded_with_a_reason_never_as_cheap(self):
        out = b.annotate_cost(self.catalog(), self.run_fixture())
        entry = next(d for d in out if d["uri"] == "B")["cpuCost"]
        self.assertEqual(entry["unmeasurable"], "no-audio-in")
        self.assertNotIn("perRate", entry)
        self.assertNotIn("nsPerSampleMedian", entry)

    def test_a_failed_probe_is_recorded_as_failed(self):
        out = b.annotate_cost(self.catalog(), self.run_fixture())
        entry = next(d for d in out if d["uri"] == "C")["cpuCost"]
        self.assertEqual(entry["failed"], "worker crashed (exit -6)")
        self.assertNotIn("perRate", entry)

    def test_a_plugin_in_no_map_is_passed_through_untouched(self):
        out = b.annotate_cost(self.catalog(), self.run_fixture())
        self.assertNotIn("cpuCost", next(d for d in out if d["uri"] == "D"))

    def test_measured_at_one_rate_only_is_measured_not_quarantined(self):
        runs = {48000: {"measured": {"A": cost_record(10.0, 48000)},
                        "unmeasurable": {}, "failures": {}},
                96000: {"measured": {}, "unmeasurable": {},
                        "failures": {"A": "probe timed out"}}}
        entry = b.annotate_cost([{"uri": "A"}], runs)[0]["cpuCost"]
        self.assertIn("48000", entry["perRate"])
        self.assertNotIn("unmeasurable", entry)
        # the reference rate was not measured, so the flat fields quote 48 kHz.
        self.assertEqual(entry["referenceRate"], 48000)

    def test_silent_output_is_flagged_on_the_cost_block(self):
        rec = cost_record(10.0, 96000)
        rec["silentOutput"] = True
        runs = {96000: {"measured": {"A": rec}, "unmeasurable": {}, "failures": {}}}
        self.assertTrue(b.annotate_cost([{"uri": "A"}], runs)[0]["cpuCost"]["silentOutput"])

    def test_census_counts_all_three_outcomes(self):
        out = b.annotate_cost(self.catalog(), self.run_fixture())
        self.assertEqual(b.cost_census(out), (1, 1, 1))


class CrashIsNotATimeout(unittest.TestCase):
    """A worker whose reply channel hits EOF has died, even before the kernel reaps it: the
    native perturbation run saw 'probe timed out' for B under load (poll() still None at EOF)."""

    SLOW_EXIT = """
uri, _, sym = line.partition("\\t")
if uri == "B":
    import os, time
    os.close(1)
    time.sleep(0.5)  # the reply channel is gone; the process is not reaped yet
    sys.exit(9)
print(json.dumps({"uri": uri, "frames": 64.0}), flush=True)
"""

    def test_eof_before_the_exit_is_reaped_is_a_crash(self):
        targets = [{"uri": u, "latency": {"portSymbol": "lat"}} for u in ("A", "B")]
        result = b.measure_offline(targets, 48000, stub_worker(self.SLOW_EXIT), timeout=10)
        self.assertIn("worker crashed", result.failures["B"])
        self.assertIn("exit 9", result.failures["B"])
        self.assertEqual(result.measured, {"A": 64.0})


class CostBatchLoop(unittest.TestCase):
    """The cost pass reuses measure_offline's crash containment verbatim."""

    BODY = """
uri, _, sym = line.partition("\\t")
if uri == "B":
    sys.exit(9)
if uri == "S":
    print(json.dumps({"uri": uri, "error": "unmeasurable:no-audio-in"}), flush=True)
else:
    print(json.dumps({"uri": uri, "nsPerSample": 12.5,
                      "cost": {"nsPerSampleMedian": 12.5, "nsPerSampleP95": 14.0,
                               "coreFractionMedian": 0.0012, "coreFractionP95": 0.00134,
                               "instancesPerCoreP95": 744, "blocks": 512,
                               "warmupBlocks": 64, "blockFrames": 512}}), flush=True)
"""

    def test_one_crashing_plugin_does_not_abort_the_cost_batch(self):
        targets = [{"uri": u} for u in ("A", "B", "S", "C")]
        result = b.measure_offline(targets, 96000, stub_worker(self.BODY), timeout=10,
                                   job_arg=lambda _d: "", value_key="nsPerSample",
                                   describe=b.describe_cost)
        self.assertEqual(sorted(result.measured), ["A", "C"])
        self.assertIn("worker crashed", result.failures["B"])
        self.assertEqual(result.failures["S"], "unmeasurable:no-audio-in")
        unmeasurable, real = b.split_unmeasurable(result.failures)
        self.assertEqual(unmeasurable, {"S": "no-audio-in"})
        self.assertEqual(list(real), ["B"])

    def test_the_full_cost_record_rides_back_in_details(self):
        result = b.measure_offline([{"uri": "A"}], 96000, stub_worker(self.BODY),
                                   timeout=10, job_arg=lambda _d: "",
                                   value_key="nsPerSample", describe=b.describe_cost)
        self.assertEqual(result.details["A"]["cost"]["blocks"], 512)
        self.assertEqual(result.measured["A"], 12.5)

    def test_latency_batch_behaviour_is_unchanged_by_the_generalisation(self):
        targets = [{"uri": u, "latency": {"portSymbol": "lat"}} for u in ("A", "B", "C")]
        result = b.measure_offline(targets, 48000, stub_worker(BEHAVIOUR_BODY), timeout=10)
        self.assertEqual(result.measured, {"A": 64.0, "C": 128.0})
        self.assertIn("worker crashed", result.failures["B"])


class HostProvenanceParsing(unittest.TestCase):
    """The pure parsers behind the run provenance."""

    def test_cpu_list_ranges_and_singletons(self):
        self.assertEqual(b.parse_cpu_list("0-7"), list(range(8)))
        self.assertEqual(b.parse_cpu_list("0-3,8,10-11"), [0, 1, 2, 3, 8, 10, 11])
        self.assertEqual(b.parse_cpu_list(""), [])
        self.assertEqual(b.parse_cpu_list("nonsense"), [])

    def test_cpu_model_from_proc_cpuinfo(self):
        text = "processor\t: 0\nvendor_id\t: GenuineIntel\nmodel name\t: Intel(R) Core(TM) Ultra 9 275HX\n"
        self.assertEqual(b.parse_cpu_model(text), "Intel(R) Core(TM) Ultra 9 275HX")

    def test_cpu_model_absent_is_none(self):
        self.assertIsNone(b.parse_cpu_model("processor\t: 0\n"))


class Lv2benchCrossCheck(unittest.TestCase):
    """Validating our numbers against the upstream tool, on the plugins it survives."""

    TSV = ("Block\tFrames\tRate\tMin\tMean\tMax\tTotal\tPlugin\n"
           "512\t262144\t48000.000000\t1e-06\t5.12e-06\t9e-06\t0.003\turn:a\n"
           "512\t262144\t48000.000000\t1e-05\t5.12e-05\t9e-05\t0.03\turn:b\n")

    def test_parses_the_upstream_columns(self):
        rows = b.parse_lv2bench_tsv(self.TSV)
        self.assertEqual(sorted(rows), ["urn:a", "urn:b"])
        self.assertEqual(rows["urn:a"]["block"], 512)
        self.assertAlmostEqual(rows["urn:a"]["mean"], 5.12e-06)

    def test_ignores_the_header_and_malformed_lines(self):
        self.assertEqual(b.parse_lv2bench_tsv("Block\tFrames\n"), {})
        self.assertEqual(b.parse_lv2bench_tsv("a\tb\tc\td\te\tf\tg\th\n"), {})

    def test_ratio_is_one_when_both_agree(self):
        # 5.12e-06 s per 512-frame block = 10 ns per sample.
        rows = b.compare_lv2bench(b.parse_lv2bench_tsv(self.TSV),
                                  {"urn:a": 10.0, "urn:b": 100.0})
        self.assertEqual([r["uri"] for r in rows], ["urn:a", "urn:b"])
        for row in rows:
            self.assertAlmostEqual(row["ratio"], 1.0, places=9)

    def test_misses_are_reported_not_filtered_away(self):
        rows = b.compare_lv2bench(b.parse_lv2bench_tsv(self.TSV), {"urn:a": 10.0, "urn:z": 1.0})
        by_uri = {r["uri"]: r for r in rows}
        self.assertEqual(by_uri["urn:b"]["reason"], "only in lv2bench")
        self.assertEqual(by_uri["urn:z"]["reason"], "only in ours")


if __name__ == "__main__":
    unittest.main()
