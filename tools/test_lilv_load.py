# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
"""lilv_load: the distributions' bindings ask for the development name; the library is loaded by its soname."""
import ctypes
import sys

import lilv_load

BINDINGS = """
from ctypes import CDLL
lib = CDLL("liblilv-0.so")
other = CDLL("libother.so")
"""


def bindings(tmp_path, monkeypatch, text=BINDINGS):
    (tmp_path / "lilv.py").write_text(text)
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.delitem(sys.modules, "lilv", raising=False)
    asked = []
    monkeypatch.setattr(ctypes, "CDLL", lambda name, *a, **k: asked.append(name) or name)
    return asked


def test_the_library_is_loaded_by_its_soname_and_nothing_else_is_renamed(tmp_path, monkeypatch):
    asked = bindings(tmp_path, monkeypatch)
    module = lilv_load.load_lilv()
    assert asked == ["liblilv-0.so.0", "libother.so"]
    assert module.lib == "liblilv-0.so.0"


def test_ctypes_is_left_as_it_was(tmp_path, monkeypatch):
    bindings(tmp_path, monkeypatch)
    before = ctypes.CDLL
    lilv_load.load_lilv()
    assert ctypes.CDLL is before


def test_ctypes_is_left_as_it_was_when_the_bindings_fail(tmp_path, monkeypatch):
    bindings(tmp_path, monkeypatch, 'raise OSError("no")')
    before = ctypes.CDLL
    try:
        lilv_load.load_lilv()
    except OSError:
        pass
    assert ctypes.CDLL is before
