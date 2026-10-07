# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
"""Pure-unit tests for scan.py's owner mapping (no lilv, no rpm needed)."""
import types
import unittest

import scan as s


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


if __name__ == "__main__":
    unittest.main()
