# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
"""lilv's Python bindings, with the library loaded by its soname."""
import ctypes

LILV_DEV_NAME = "liblilv-0.so"
LILV_SONAME = "liblilv-0.so.0"


def load_lilv():
    """
    The bindings module. Fedora's and Debian's lilv.py open liblilv-0.so, a name only their development packages
    install, so it is opened as liblilv-0.so.0 during the import. Raises what the import raises.
    """
    real = ctypes.CDLL

    def by_soname(name, *args, **kwargs):
        return real(LILV_SONAME if name == LILV_DEV_NAME else name, *args, **kwargs)

    ctypes.CDLL = by_soname
    try:
        import lilv
    finally:
        ctypes.CDLL = real
    return lilv
