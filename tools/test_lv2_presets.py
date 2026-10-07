# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
"""The presets a plugin ships (docs/design/specs/2026-10-01-plugin-presets.md section 2b, section 7.1).

The pure half needs no lilv; the installed half reads two real bundles through the scan and is
skipped, naming what is missing, on a host that does not have them.
"""
import json
import os
import unittest

import lv2_presets as p

try:
    import lilv  # noqa: F401
    HAVE_LILV = True
except ImportError:  # pragma: no cover - a host with no lilv runs the pure half only
    HAVE_LILV = False

TAL = "urn:juce:TalReverb2"
ZAMVERB = "urn:zamaudio:ZamVerb"


def installed(bundle):
    return any(os.path.isdir(os.path.join(d, bundle))
               for d in ("/usr/lib64/lv2", "/usr/lib/lv2"))


PARAMS = [
    {"kind": "control", "symbol": "wet", "min": 0.0, "max": 1.0},
    {"kind": "control", "symbol": "room", "min": 0.0, "max": 10.0},
    {"kind": "patch", "symbol": "file", "uri": "urn:x#file"},
]


class Carries(unittest.TestCase):
    def test_values_without_a_body_are_params(self):
        self.assertEqual(p.carries_of([{"symbol": "wet", "value": 0.5}], False), "params")

    def test_values_and_a_body_are_params_and_state(self):
        self.assertEqual(p.carries_of([{"symbol": "wet", "value": 0.5}], True), "params+state")

    def test_a_body_alone_is_state(self):
        self.assertEqual(p.carries_of([], True), "state")


class Invalid(unittest.TestCase):
    def test_a_symbol_the_plugin_does_not_carry(self):
        self.assertEqual(p.invalid_of([{"symbol": "gone", "value": 0.0}], PARAMS), "UNKNOWN_SYMBOL")

    def test_a_patch_param_is_not_a_port_a_preset_sets(self):
        self.assertEqual(p.invalid_of([{"symbol": "file", "value": 0.0}], PARAMS), "UNKNOWN_SYMBOL")

    def test_a_value_outside_the_travel(self):
        self.assertEqual(p.invalid_of([{"symbol": "wet", "value": 1.5}], PARAMS), "OUT_OF_TRAVEL")
        self.assertEqual(p.invalid_of([{"symbol": "room", "value": -1.0}], PARAMS), "OUT_OF_TRAVEL")

    def test_a_literal_at_an_end_the_scan_widened_through_a_c_float_is_inside(self):
        # Calf Filter's res: min "0.707" scans as 0.7070000171661377; its preset's 0.707 is AT it.
        params = [{"kind": "control", "symbol": "res", "min": 0.7070000171661377, "max": 32.0}]
        self.assertIsNone(p.invalid_of([{"symbol": "res", "value": 0.707}], params))

    def test_the_travel_ends_are_inside(self):
        self.assertIsNone(p.invalid_of([{"symbol": "wet", "value": 1.0},
                                        {"symbol": "room", "value": 0.0}], PARAMS))


class PortsThatAreNotParams(unittest.TestCase):
    """A value for a port the plugin HAS but no host sets (an output meter, a hidden or designated
    port) is not a parameter: it is left out of `values`, never read as an unknown symbol."""

    PORTS = {"wet", "room", "meter_out", "lv2_freewheel"}

    def test_an_output_or_hidden_port_is_dropped_not_invalid(self):
        e = p.preset_entry("urn:x#p1", "Hall", None,
                           [{"symbol": "wet", "value": 0.2}, {"symbol": "meter_out", "value": 0.7},
                            {"symbol": "lv2_freewheel", "value": 0.0}], False, PARAMS, self.PORTS)
        self.assertNotIn("invalid", e)
        self.assertEqual(e["values"], [{"symbol": "wet", "value": 0.2}])

    def test_a_symbol_that_is_no_port_at_all_stays_unknown(self):
        e = p.preset_entry("urn:x#p1", "Bad", None, [{"symbol": "gone", "value": 0.0}], False, PARAMS, self.PORTS)
        self.assertEqual(e["invalid"], "UNKNOWN_SYMBOL")


class Entry(unittest.TestCase):
    def test_an_invalid_preset_is_listed_with_its_reason_not_dropped(self):
        e = p.preset_entry("urn:x#p1", "Bad", None, [{"symbol": "gone", "value": 1.0}], False, PARAMS)
        self.assertEqual(e["invalid"], "UNKNOWN_SYMBOL")
        self.assertEqual(e["name"], "Bad")

    def test_values_sort_by_symbol_and_absent_fields_stay_absent(self):
        e = p.preset_entry("urn:x#p1", "Hall", None,
                           [{"symbol": "wet", "value": 0.2}, {"symbol": "room", "value": 3.0}], False, PARAMS)
        self.assertEqual([v["symbol"] for v in e["values"]], ["room", "wet"])
        self.assertNotIn("bank", e)
        self.assertNotIn("invalid", e)


@unittest.skipUnless(HAVE_LILV, "lilv is not importable on this host")
class InstalledBundles(unittest.TestCase):
    """Section 7.1's proof, through the scan's own describe(): the descriptor carries the presets."""

    @classmethod
    def setUpClass(cls):
        import scan
        cls.scan = scan

    def describe(self, uri):
        found = self.scan.Scanner().scan([uri])
        self.assertEqual(len(found), 1, f"{uri} is not installed")
        return found[0]

    @unittest.skipUnless(installed("TAL-Reverb-2.lv2"), "TAL-Reverb-2.lv2 (DISTRHO Ports) not installed")
    def test_tal_reverb_ii_ships_ten_params_and_state_presets(self):
        d = self.describe(TAL)
        presets = d["presets"]
        self.assertEqual([x["uri"] for x in presets], [f"{TAL}#preset{n:03d}" for n in range(1, 11)])
        self.assertEqual(presets[0]["name"], "Gentle Drum Ambience")
        self.assertEqual(presets[9]["name"], "Short Plate")
        self.assertTrue(all(x["carries"] == "params+state" for x in presets))
        wet = {x["uri"]: next(v["value"] for v in x["values"] if v["symbol"] == "wet") for x in presets}
        # The TTL literal, exactly: lilv's float() widens a float32 (0.4779999852...), which a
        # host's param_get ("%f", 0.478000) would then read as an edit the operator never made.
        self.assertEqual(wet[f"{TAL}#preset001"], 0.13)
        self.assertEqual(wet[f"{TAL}#preset010"], 0.478)
        self.assertTrue(all("invalid" not in x for x in presets))

    @unittest.skipUnless(installed("ZamVerb.lv2"), "ZamVerb.lv2 (zam-plugins) not installed")
    def test_zamverb_ships_one_params_only_preset(self):
        presets = self.describe(ZAMVERB)["presets"]
        self.assertEqual(len(presets), 1)
        self.assertEqual(presets[0]["name"], "Default")
        self.assertEqual(presets[0]["carries"], "params")
        self.assertEqual(presets[0]["values"], [{"symbol": "master", "value": 0.0},
                                                {"symbol": "room", "value": 0.0},
                                                {"symbol": "wetdry", "value": 50.0}])

    @unittest.skipUnless(installed("TAL-Reverb-2.lv2"), "TAL-Reverb-2.lv2 (DISTRHO Ports) not installed")
    def test_two_reads_give_identical_bytes(self):
        a = json.dumps(self.describe(TAL)["presets"], sort_keys=False)
        b = json.dumps(self.describe(TAL)["presets"], sort_keys=False)
        self.assertEqual(a, b)

    def test_a_meter_output_is_dropped_and_a_sibling_plugins_port_stays_unknown(self):
        """Calf's MonoCompressor presets record its meter outputs (clip_in, clip_out, compression),
        which are ports and are dropped; some were written for the STEREO compressor and set
        `detection` and `stereo_link`, which the mono plugin does not have — those stay invalid."""
        uri = "http://calf.sourceforge.net/plugins/MonoCompressor"
        if not installed("calf.lv2"):
            self.skipTest("calf.lv2 not installed")
        presets = self.describe(uri)["presets"]
        self.assertTrue(presets)
        symbols = {v["symbol"] for x in presets for v in x.get("values", [])}
        self.assertFalse(symbols & {"clip_in", "clip_out", "compression", "meter_in", "meter_out"})
        for x in presets:
            sibling = {v["symbol"] for v in x.get("values", [])} & {"detection", "stereo_link"}
            self.assertEqual(x.get("invalid"), "UNKNOWN_SYMBOL" if sibling else None, x["name"])

    def test_presets_is_a_declared_field_annotate_refreshes(self):
        self.assertIn("presets", self.scan.DECLARED_FIELDS)


if __name__ == "__main__":
    unittest.main()
