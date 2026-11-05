# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
"""Pure-unit tests for scan.py's owner mapping (no lilv, no rpm needed)."""
import ast
import glob
import json
import os
import tempfile
import types
import unittest

import descriptors as desc
import scan as s

TOOLS = os.path.dirname(os.path.abspath(__file__))


def fake_run(stdout="", returncode=0):
    def _run(argv, capture_output=True, text=True, check=False, timeout=None):
        return types.SimpleNamespace(stdout=stdout, returncode=returncode)
    return _run


class OwningRpm(unittest.TestCase):
    def test_maps_bundle_path_to_package_name(self):
        run = fake_run(stdout="lsp-plugins-lv2\n", returncode=0)
        self.assertEqual(s.owning_rpm("/usr/lib64/lv2/lsp.lv2", run), "lsp-plugins-lv2")

    def test_unowned_path_is_none(self):
        # `rpm -qf` on an unowned file exits nonzero with a "not owned" message on stdout.
        run = fake_run(stdout="file /x is not owned by any package\n", returncode=1)
        self.assertIsNone(s.owning_rpm("/x", run))

    def test_rpm_missing_or_error_is_none_not_a_crash(self):
        def boom(*_a, **_k):
            raise FileNotFoundError("rpm")
        self.assertIsNone(s.owning_rpm("/usr/lib64/lv2/x.lv2", boom))

    def test_strips_whitespace(self):
        run = fake_run(stdout="  calf  \n", returncode=0)
        self.assertEqual(s.owning_rpm("/usr/lib64/lv2/calf.lv2", run), "calf")


class DeclaredComment(unittest.TestCase):
    """`rdfs:comment` is a declared fact, read from the bundle or absent — never invented."""

    class FakeWorld:
        def new_uri(self, uri):
            return uri

    class FakePlugin:
        def __init__(self, values):
            self.values = values

        def get_value(self, uri):
            return self.values.get(uri)

    def read(self, values):
        return s.declared_comment(self.FakePlugin(values), self.FakeWorld())

    def test_reads_the_declared_comment(self):
        uri = s.RDFS + "comment"
        self.assertEqual(self.read({uri: ["a soft slew saturator"]}), "a soft slew saturator")

    def test_absent_stays_absent(self):
        self.assertIsNone(self.read({}))
        self.assertIsNone(self.read({s.RDFS + "comment": []}))

    def test_an_empty_comment_is_not_a_description(self):
        self.assertIsNone(self.read({s.RDFS + "comment": ["   "]}))

    def test_collapses_the_whitespace_a_ttl_wraps_with(self):
        uri = s.RDFS + "comment"
        self.assertEqual(self.read({uri: ["two\n   lines"]}), "two lines")

    def test_takes_one_value_and_never_concatenates_alternatives(self):
        uri = s.RDFS + "comment"
        self.assertEqual(self.read({uri: ["first", "second"]}), "first")


class Annotate(unittest.TestCase):
    """The annotate pass refreshes what a plugin DECLARES and touches no measurement."""

    class FakeScanner:
        def __init__(self, fresh):
            self.fresh = fresh
            self.w = types.SimpleNamespace(
                new_uri=lambda uri: uri,
                get_all_plugins=lambda: types.SimpleNamespace(
                    get_by_uri=lambda uri: uri if uri in fresh else None),
            )

        def describe(self, plugin):
            return self.fresh[plugin]

    def test_refreshes_declared_fields_and_leaves_measurements_alone(self):
        catalog = [{"uri": "urn:a", "name": "Old", "lv2Class": "Plugin",
                    "latency": {"measuredMs": 5}, "owningRpm": "some-rpm"}]
        scanner = self.FakeScanner({"urn:a": {"uri": "urn:a", "name": "New",
                                              "lv2Class": "Reverb Plugin",
                                              "lv2Comment": "a hall"}})
        changed, absent = s.annotate(catalog, scanner)
        self.assertEqual((changed, absent), (3, 0))
        self.assertEqual(catalog[0]["name"], "New")
        self.assertEqual(catalog[0]["lv2Class"], "Reverb Plugin")
        self.assertEqual(catalog[0]["lv2Comment"], "a hall")
        # the measurement half is benchmark.py's, and this pass never writes there
        self.assertEqual(catalog[0]["latency"], {"measuredMs": 5})
        self.assertEqual(catalog[0]["owningRpm"], "some-rpm")

    def test_a_uri_not_installed_here_is_left_exactly_as_it_is(self):
        catalog = [{"uri": "urn:gone", "name": "Kept", "lv2Comment": "kept"}]
        changed, absent = s.annotate(catalog, self.FakeScanner({}))
        self.assertEqual((changed, absent), (0, 1))
        self.assertEqual(catalog[0], {"uri": "urn:gone", "name": "Kept", "lv2Comment": "kept"})

    def test_a_field_the_bundle_no_longer_declares_is_removed_not_kept_stale(self):
        catalog = [{"uri": "urn:a", "name": "A", "lv2Comment": "stale"}]
        scanner = self.FakeScanner({"urn:a": {"uri": "urn:a", "name": "A", "lv2Class": None}})
        changed, absent = s.annotate(catalog, scanner)
        self.assertEqual((changed, absent), (1, 0))
        self.assertNotIn("lv2Comment", catalog[0])

    def test_never_adds_or_drops_an_entry(self):
        catalog = [{"uri": "urn:a", "name": "A"}, {"uri": "urn:b", "name": "B"}]
        s.annotate(catalog, self.FakeScanner({"urn:a": {"uri": "urn:a", "name": "A"}}))
        self.assertEqual([e["uri"] for e in catalog], ["urn:a", "urn:b"])


class UnitsFromTheSheet(unittest.TestCase):
    """A port's unit is spelled by omx-contract's units sheet, the owner of the words; no table of units is kept here."""

    class FakePort:
        def __init__(self, unit):
            self.unit = unit

        def get_value(self, _uri):
            return [self.unit] if self.unit is not None else []

    class FakeWorld:
        def __init__(self, symbols):
            self.symbols = symbols

        def find_nodes(self, subject, _pred, _obj):
            return [self.symbols[subject]] if subject in self.symbols else []

    def scanner(self, symbols=None):
        return types.SimpleNamespace(u={s.UNITS + "unit": s.UNITS + "unit", s.UNITS + "symbol": s.UNITS + "symbol"},
                                     w=self.FakeWorld(symbols or {}))

    def test_the_catalog_spells_a_unit_as_the_sheet_does(self):
        words = desc.unit_words()
        self.assertEqual(words[s.UNITS + "cent"], "cents")
        for uri, word in words.items():
            self.assertEqual(s.Scanner.unit_symbol(self.scanner(), self.FakePort(uri)), word)
            self.assertEqual(s.Scanner.descriptor_unit(self.scanner(), self.FakePort(uri)), word)

    def test_a_unit_the_sheet_has_no_word_for_falls_to_the_plugins_symbol(self):
        uri = "urn:example#furlong"
        self.assertNotIn(uri, desc.unit_words())
        self.assertEqual(s.Scanner.unit_symbol(self.scanner({uri: "fur"}), self.FakePort(uri)), "fur")
        self.assertEqual(s.Scanner.descriptor_unit(self.scanner({uri: "fur"}), self.FakePort(uri)), "unknown")
        self.assertIsNone(s.Scanner.unit_symbol(self.scanner(), self.FakePort(None)))

    def test_the_sheet_is_read_from_the_omx_contract_the_schema_is_found_in(self):
        with tempfile.TemporaryDirectory() as root:
            schema = os.path.join(root, "schema", "omx-contract.schema.json")
            sheet = os.path.join(root, "data", desc.UNITS_SHEET)
            os.makedirs(os.path.dirname(schema))
            os.makedirs(os.path.dirname(sheet))
            open(schema, "w").close()
            env = {desc.DESCRIPTOR_SCHEMA_ENV: schema}
            with self.assertRaises(desc.DescriptorRefused):
                desc.unit_words(env)
            with open(sheet, "w") as f:
                json.dump({"LV2_UNITS_TERMS": {"terms": {
                    "cent": {"uri": s.UNITS + "cent", "kind": "unit", "word": "cents"},
                    "coef": {"uri": s.UNITS + "coef", "kind": "unit"},
                    "Unit": {"uri": s.UNITS + "Unit", "kind": "class", "word": "no"}}}}, f)
            self.assertEqual(desc.unit_words(env), {s.UNITS + "cent": "cents"})

    def test_no_table_of_units_comes_back(self):
        """No module of tools/ maps LV2 unit URIs itself: the sheet is the one table, and a copy here is refused."""
        found = []
        for path in sorted(glob.glob(os.path.join(TOOLS, "*.py"))):
            if os.path.basename(path).startswith("test_"):
                continue
            with open(path, encoding="utf-8") as f:
                tree = ast.parse(f.read(), path)
            for node in ast.walk(tree):
                if not isinstance(node, ast.Dict):
                    continue
                for key in node.keys:
                    unit_key = (isinstance(key, ast.BinOp) and isinstance(key.left, ast.Name) and key.left.id == "UNITS") \
                        or (isinstance(key, ast.Constant) and isinstance(key.value, str) and key.value.startswith(s.UNITS))
                    if unit_key:
                        found.append(f"{os.path.basename(path)}:{node.lineno}")
                        break
        self.assertEqual(found, [], "a table of LV2 units; read omx-contract's units sheet (desc.unit_words) instead")


if __name__ == "__main__":
    unittest.main()
