# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
"""The scanned descriptors: the directory, the name, the schema, and the LV2 round trip.

The pure half needs no lilv. The round trip scans the LV2 fixture set (`make -C native`'s
`build/fixtures/lv2` and `fixtures/zero-path.lv2`) through lilv, writes the descriptors and
rebuilds the catalog rows from them; it is skipped, naming what is missing, off CI only.
"""
import copy
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

import descriptors as d
from _declarations import DESCRIPTOR_CODE_BINARY_UNHASHED, DESCRIPTOR_CODE_SCHEMA

try:
    import lilv  # noqa: F401
    HAVE_LILV = True
except ImportError:  # pragma: no cover - a host with no lilv runs the pure half only
    HAVE_LILV = False

TOOLS = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(TOOLS)
SHA_A = "a" * 64
SHA_B = "b" * 64
CONTROLS_SCAN = os.path.join(PKG, "fixtures", "clap-scan", "controls.json")


def validator():
    return d.SchemaValidator()


class Directory(unittest.TestCase):
    """descriptor_dir: named, else the system service's, else the user's state directory."""

    def test_named_wins(self):
        self.assertEqual(d.descriptor_dir("/srv/x", system=True, env={"XDG_STATE_HOME": "/s"}), "/srv/x")

    def test_system_service(self):
        self.assertEqual(d.descriptor_dir(None, system=True, env={"XDG_STATE_HOME": "/s"}), "/var/lib/omx/descriptors")

    def test_xdg_state_home(self):
        self.assertEqual(d.descriptor_dir(env={"XDG_STATE_HOME": "/s"}, home="/home/u"), "/s/omx/descriptors")

    def test_home_when_xdg_is_unset_or_empty(self):
        self.assertEqual(d.descriptor_dir(env={}, home="/home/u"), "/home/u/.local/state/omx/descriptors")
        self.assertEqual(d.descriptor_dir(env={"XDG_STATE_HOME": ""}, home="/home/u"), "/home/u/.local/state/omx/descriptors")


class FileName(unittest.TestCase):
    """`<id>@<version>-<sha256 first 12>.json`: the binary's hash keys which file describes it."""

    def test_clap_id(self):
        self.assertEqual(d.descriptor_file_name("org.example.plate", "1.2.0", SHA_A), "org.example.plate@1.2.0-aaaaaaaaaaaa.json")

    def test_lv2_uri_and_no_version(self):
        self.assertEqual(d.descriptor_file_name("http://x.org/p#a b", None, SHA_A), "http___x.org_p_a_b@unversioned-aaaaaaaaaaaa.json")

    def test_a_changed_binary_is_a_new_name(self):
        self.assertNotEqual(d.descriptor_file_name("org.example.plate", "1", SHA_A), d.descriptor_file_name("org.example.plate", "1", SHA_B))

    def test_no_hash_is_refused_by_its_code(self):
        for sha in (None, "", "abc", "A" * 64):
            with self.assertRaises(d.DescriptorRefused) as e:
                d.descriptor_file_name("org.example.plate", "1", sha)
            self.assertEqual(e.exception.code, DESCRIPTOR_CODE_BINARY_UNHASHED)


class ChoiceIds(unittest.TestCase):
    def test_from_labels_unique_and_never_empty(self):
        self.assertEqual(d.choice_ids(["Sine", "Square", "Saw"]), ["sine", "square", "saw"])
        self.assertEqual(d.choice_ids(["Low Pass", "-", "Low Pass"]), ["lowPass", "v1", "v2"])


def controls_scan(sha=None):
    with open(CONTROLS_SCAN, encoding="utf-8") as f:
        scan = json.load(f)
    if sha:
        scan["files"][0]["sha256"] = sha
    return scan


class ClapMapping(unittest.TestCase):
    """The CLAP fixture's scan document as a descriptor, value by value."""

    def test_controls_fixture(self):
        [(doc, sha)] = d.clap_described(controls_scan(SHA_A))
        self.assertEqual(sha, SHA_A)
        entry = "controls.clap#clap_entry[org.freemixer.plugin-qualify.fixture.controls]"
        self.assertEqual(doc, {
            "$schema": d.SCHEMA_URL,
            "requires": {"omx-contract-schema": ">= 3.0.0"},
            "origin": "scanned",
            "plugin": {"format": "clap", "id": "org.freemixer.plugin-qualify.fixture.controls", "name": "controls",
                       "vendor": "plugin-qualify", "version": "1", "doc": "plugin-qualify fixture",
                       "features": ["audio-effect"]},
            "controls": [
                {"id": 3, "name": "shape", "kind": "choice", "ids": ["sine", "square", "saw"],
                 "labels": ["Sine", "Square", "Saw"], "values": [0, 1, 2], "default": "sine",
                 "group": ["Oscillator"], "meaning": "unknown", "automatable": True,
                 "source": {"from": entry + "[3]"}},
                {"id": 5, "name": "cutoff", "kind": "travel",
                 "travel": {"min": 20, "max": 20000, "unit": "unknown", "scale": "unknown", "default": 1000},
                 "group": ["Filter", "Envelope"], "meaning": "unknown", "automatable": True,
                 "source": {"from": entry + "[5]"}},
            ],
            "ports": [
                {"id": 0, "name": "in", "kind": "audio", "direction": "in", "role": "main", "channels": 2},
                {"id": 0, "name": "out", "kind": "audio", "direction": "out", "role": "main", "channels": 2},
            ],
            "extensions": {"clap": {
                "clap_plugin_descriptor.features": ["audio-effect"],
                "clap_plugin_remote_controls.get": [{"id": 7, "section": "Main", "name": "Performance",
                                                     "params": [5, 3, None, None, None, None, None, None],
                                                     "forPreset": False}],
            }},
            "source": {"from": entry},
        })
        validator().check(doc)

    def test_an_open_bound_is_carried_not_dropped(self):
        scan = controls_scan(SHA_A)
        scan["files"][0]["plugins"][0]["params"][1]["max"] = None
        [(doc, _)] = d.clap_described(scan)
        self.assertEqual([c["id"] for c in doc["controls"]], [3])
        self.assertEqual(doc["extensions"]["clap"]["clap_plugin_params.get_info"][0]["id"], 5)
        validator().check(doc)


class Writing(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="descriptors-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        [(self.doc, _)] = d.clap_described(controls_scan())

    def test_written_whole_under_its_name_and_read_back_equal(self):
        path = d.write_descriptor(self.dir, self.doc, SHA_A, validator())
        self.assertEqual(os.path.basename(path), "org.freemixer.plugin-qualify.fixture.controls@1-aaaaaaaaaaaa.json")
        with open(path, encoding="utf-8") as f:
            self.assertEqual(json.load(f), self.doc)
        self.assertEqual(sorted(os.listdir(self.dir)), [os.path.basename(path)])

    def test_a_changed_binary_writes_a_new_file_and_keeps_the_old(self):
        a = d.write_descriptor(self.dir, self.doc, SHA_A, validator())
        b = d.write_descriptor(self.dir, self.doc, SHA_B, validator())
        self.assertNotEqual(a, b)
        self.assertEqual(sorted(os.listdir(self.dir)), sorted([os.path.basename(a), os.path.basename(b)]))

    def test_a_descriptor_the_schema_refuses_is_refused_by_its_code_and_not_written(self):
        sabotaged = []
        bad = copy.deepcopy(self.doc)
        bad["controls"][1]["kind"] = "slider"
        sabotaged.append(bad)
        bad = copy.deepcopy(self.doc)
        bad["controls"][1]["travel"]["unit"] = "furlongs"
        sabotaged.append(bad)
        bad = copy.deepcopy(self.doc)
        bad["plugin"]["features"] = []
        sabotaged.append(bad)
        bad = copy.deepcopy(self.doc)
        bad["measuredLatency"] = 64
        sabotaged.append(bad)
        bad = copy.deepcopy(self.doc)
        bad["origin"] = "authored"
        sabotaged.append(bad)
        for doc in sabotaged:
            with self.assertRaises(d.DescriptorRefused) as e:
                d.write_descriptor(self.dir, doc, SHA_A, validator())
            self.assertEqual(e.exception.code, DESCRIPTOR_CODE_SCHEMA)
        self.assertEqual(os.listdir(self.dir), [])

    def test_a_scan_document_with_no_hash_is_refused_and_the_rest_written(self):
        err = open(os.devnull, "w")
        self.addCleanup(err.close)
        other = copy.deepcopy(self.doc)
        other["plugin"]["id"] = "org.example.other"
        written, refused = d.write_all(self.dir, [(self.doc, None), (other, SHA_A)], validator(), err)
        self.assertEqual([os.path.basename(p) for p in written], ["org.example.other@1-aaaaaaaaaaaa.json"])
        self.assertEqual([(r[0], r[1]) for r in refused], [("org.freemixer.plugin-qualify.fixture.controls", DESCRIPTOR_CODE_BINARY_UNHASHED)])

    def test_the_cli_reads_the_scan_from_stdin_when_the_dash_follows_the_options(self):
        out_dir = os.path.join(self.dir, "out")
        r = subprocess.run([sys.executable, os.path.join(TOOLS, "descriptors.py"), "clap", "--descriptor-dir", out_dir, "-"],
                           input=json.dumps(controls_scan(SHA_A)), capture_output=True, text=True, check=False)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stderr, "")
        self.assertEqual(os.listdir(out_dir), ["org.freemixer.plugin-qualify.fixture.controls@1-aaaaaaaaaaaa.json"])

    def test_the_cli_reads_a_scan_document_and_exits_2_on_a_refusal(self):
        scan = os.path.join(self.dir, "scan.json")
        with open(scan, "w", encoding="utf-8") as f:
            json.dump(controls_scan(), f)
        out_dir = os.path.join(self.dir, "out")
        r = subprocess.run([sys.executable, os.path.join(TOOLS, "descriptors.py"), "clap", "--descriptor-dir", out_dir, scan],
                           capture_output=True, text=True, check=False)
        self.assertEqual(r.returncode, 2)
        self.assertIn(DESCRIPTOR_CODE_BINARY_UNHASHED, r.stderr)
        with open(scan, "w", encoding="utf-8") as f:
            json.dump(controls_scan(SHA_A), f)
        r = subprocess.run([sys.executable, os.path.join(TOOLS, "descriptors.py"), "clap", "--descriptor-dir", out_dir, scan],
                           capture_output=True, text=True, check=False)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(os.listdir(out_dir), ["org.freemixer.plugin-qualify.fixture.controls@1-aaaaaaaaaaaa.json"])


# ---- the LV2 round trip (spec 6.6(f) step 5.2) ----------------------------------------------------

# The catalog row's fields a descriptor does not carry, each by design: where the bundle lies on this
# machine and which package owns it (the descriptor names its files relatively, in `source`), and the
# presets the plugin ships (a sibling directory of their own, spec 6.13).
NOT_IN_A_DESCRIPTOR = ("bundlePath", "owningRpm", "presets")

CATALOG_UNITS = {"dB": "dB", "Hz": "Hz", "s": "s", "ms": "ms", "%": "%", "st": "semi", "cents": "ct",
                 "deg": "deg", "x": "x", "oct": "oct", "bpm": "BPM", "midiNote": "note", "frames": "fr"}


def lv2_row(doc, class_label):
    """The catalog row (scan.py's) rebuilt from a scanned LV2 descriptor."""
    bag = doc.get("extensions", {}).get("lv2", {})
    writable = bag.get("patch:writable", [])
    patch_symbols = {w["uri"].rsplit("#", 1)[-1].rsplit("/", 1)[-1] for w in writable}
    ports = doc["ports"]
    params = []
    for c in doc["controls"]:
        if c.get("hidden") or c.get("readonly") or c["id"] in patch_symbols:
            continue
        t = c.get("travel", {})
        params.append({
            "kind": "control", "symbol": c["id"], "name": c["name"],
            "min": t.get("min"), "max": t.get("max"), "default": t.get("default", t.get("min")),
            "isInteger": t.get("scale") == "stepped", "isToggle": c["kind"] == "toggle",
            "isEnumeration": c["kind"] == "choice", "isLogarithmic": t.get("scale") == "log",
            "isTrigger": c["kind"] == "trigger", "unit": CATALOG_UNITS.get(t.get("unit")),
        })
    for w in writable:
        sym = w["uri"].rsplit("#", 1)[-1].rsplit("/", 1)[-1]
        row = {"kind": "patch", "symbol": sym, "uri": w["uri"], "name": w["label"], "datatype": w["range"]}
        c = next((c for c in doc["controls"] if c["id"] == sym), None)
        for k in ("min", "max", "default"):
            if c is not None and k in c["travel"]:
                row[k] = c["travel"][k]
        params.append(row)
    p = doc["plugin"]
    out = {
        "uri": p["uri"], "name": p["name"], "lv2Class": class_label(bag["rdf:type"]),
        "audioInputs": sum(q.get("channels", 1) for q in ports if q["kind"] == "audio" and q["direction"] == "in"),
        "audioOutputs": sum(q.get("channels", 1) for q in ports if q["kind"] == "audio" and q["direction"] == "out"),
        "hasMidiIn": any(q["kind"] == "midi" and q["direction"] == "in" for q in ports),
        "params": params,
    }
    if "doc" in p:
        out["lv2Comment"] = p["doc"]
    if "lv2:latency" in bag:
        out["latency"] = {"portSymbol": bag["lv2:latency"]}
    if "version" in p:
        minor, micro = p["version"].split(".")
        out["minorVersion"], out["microVersion"] = int(minor), int(micro)
    return out


def lv2_fixture_path(into):
    """An LV2_PATH holding the fixture set: the built bundles, and zero-path.lv2 built beside its source."""
    built = os.path.join(PKG, "native", "build", "fixtures", "lv2")
    if not os.path.isdir(built) or shutil.which("cc") is None:
        return None
    os.makedirs(into)
    for name in sorted(os.listdir(built)):
        os.symlink(os.path.join(built, name), os.path.join(into, name))
    zero = os.path.join(into, "zero-path.lv2")
    shutil.copytree(os.path.join(PKG, "fixtures", "zero-path.lv2"), zero)
    flags = subprocess.run(["pkg-config", "--cflags", "lv2"], capture_output=True, text=True, check=False).stdout.split()
    subprocess.run(["cc", "-shared", "-fPIC", *flags, "-o", os.path.join(zero, "zero-path.so"), os.path.join(zero, "zero-path.c")],
                   check=True)
    return into


class Lv2RoundTrip(unittest.TestCase):
    """Every LV2 fixture: written, valid, and the catalog row rebuilt from it equals scan.py's, field by field."""

    @classmethod
    def setUpClass(cls):
        on_ci = bool(os.environ.get("CI"))
        if not HAVE_LILV:
            if on_ci:
                raise AssertionError("lilv is not importable on CI")
            raise unittest.SkipTest("python lilv is not installed")
        cls.tmp = tempfile.mkdtemp(prefix="descriptors-lv2-")
        path = lv2_fixture_path(os.path.join(cls.tmp, "lv2"))
        if path is None:
            if on_ci:
                raise AssertionError("native/build is missing on CI: CI builds it with make -C native deps all")
            raise unittest.SkipTest("native/build is missing: make -C native")
        cls.saved = os.environ.get("LV2_PATH")
        os.environ["LV2_PATH"] = path
        import scan
        cls.scanner = scan.Scanner()
        cls.rows = {r["uri"]: r for r in cls.scanner.scan()}
        cls.out = os.path.join(cls.tmp, "descriptors")
        with open(os.devnull, "w") as err:
            cls.written, cls.refused = d.write_all(cls.out, cls.scanner.descriptors(), validator(), err)

    @classmethod
    def tearDownClass(cls):
        if getattr(cls, "saved", None) is None:
            os.environ.pop("LV2_PATH", None)
        else:
            os.environ["LV2_PATH"] = cls.saved
        if getattr(cls, "tmp", None):
            shutil.rmtree(cls.tmp, True)

    def label(self, uri):
        """The class label the catalog shows, as lilv names the class: the root class is always known to it."""
        w = self.scanner.w
        root = w.get_plugin_class()
        cls = root if str(root.get_uri()) == uri else w.get_plugin_classes().get_by_uri(w.new_uri(uri))
        return str(cls.get_label()) if cls is not None else None

    def docs(self):
        out = {}
        for path in self.written:
            with open(path, encoding="utf-8") as f:
                doc = json.load(f)
            out[doc["plugin"]["id"]] = (os.path.basename(path), doc)
        return out

    def test_every_fixture_plugin_is_written_and_none_refused(self):
        self.assertEqual(self.refused, [])
        self.assertEqual(sorted(self.docs()), sorted(self.rows))
        self.assertEqual(len(self.rows), 14)

    def test_each_file_is_named_by_id_version_and_its_binary_hash(self):
        plugins = self.scanner.w.get_all_plugins()
        for uri, (name, doc) in self.docs().items():
            lib = plugins.get_by_uri(self.scanner.w.new_uri(uri)).get_library_uri().get_path()
            self.assertEqual(name, d.descriptor_file_name(uri, doc["plugin"].get("version"), d.file_sha256(lib)))
        self.assertTrue(self.docs()["urn:plugin-qualify:fixture:lv2-rt-safe"][0].startswith("urn_plugin-qualify_fixture_lv2-rt-safe@1.0-"))

    def test_rows_rebuilt_from_the_descriptors_equal_the_scan_rows(self):
        for uri, (_, doc) in self.docs().items():
            expected = {k: v for k, v in self.rows[uri].items() if k not in NOT_IN_A_DESCRIPTOR}
            self.assertEqual(lv2_row(doc, self.label), expected, uri)

    def test_what_the_rows_do_not_carry_the_descriptors_add(self):
        docs = {uri: doc for uri, (_, doc) in self.docs().items()}
        self.assertEqual(docs["urn:plugin-qualify:fixture:lv2-synth"]["plugin"]["features"], ["instrument"])
        self.assertEqual(docs["urn:plugin-qualify:fixture:needs-options"]["needs"]["extensions"]["required"],
                         ["http://lv2plug.in/ns/ext/buf-size#boundedBlockLength", "http://lv2plug.in/ns/ext/options#options",
                          "http://lv2plug.in/ns/ext/urid#map"])
        self.assertEqual([(q["id"], q["kind"], q["direction"]) for q in docs["urn:plugin-qualify:fixture:lv2-synth"]["ports"]],
                         [("midi", "midi", "in"), ("out_l", "audio", "out"), ("out_r", "audio", "out")])
        self.assertEqual(docs["urn:openmixer:eval:zero-path"]["extensions"]["lv2"]["patch:writable"],
                         [{"uri": "urn:openmixer:eval:zero-path#model", "label": "model", "range": "Path"}])
        self.assertEqual(docs["urn:plugin-qualify:fixture:lv2-rt-safe"]["controls"][0]["source"],
                         {"from": "rt-safe.lv2/gain.ttl#gain"})


if __name__ == "__main__":
    unittest.main()
