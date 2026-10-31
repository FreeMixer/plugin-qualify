#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
"""Which bundle lilv takes for each LV2 plugin on the search path, and its binary (plugin-qualify#199).

lilv loads one world over the whole LV2_PATH; where two bundles describe one plugin URI, its version rule decides
(the higher lv2:minorVersion, then lv2:microVersion, replaces the other). An LV2 complement writes a replacing bundle
with the microVersion one above, so lilv, and every host built on it, loads that one. The sync keys an LV2 plugin by
the bundle lilv takes, never by the first one a directory listing finds.

    LV2_PATH=<dir>:<dir>... lv2_resolve.py

prints one JSON object: {"plugins": [{"uri", "bundle", "binary"}, ...]}, `bundle` a directory, `binary` the absolute
path of the library lilv would load (it may lie outside the bundle).
"""
import json
import sys
from urllib.parse import unquote, urlparse


def path_of(uri):
    """A file: URI as a path, its trailing slash dropped."""
    return unquote(urlparse(uri).path).rstrip("/")


def main():
    try:
        import lilv
    except ImportError as e:
        print(f"lv2_resolve: lilv's Python bindings are not installed: {e}", file=sys.stderr)
        return 2
    world = lilv.World()
    world.load_all()
    out = []
    for plugin in world.get_all_plugins():
        library = plugin.get_library_uri()
        out.append({
            "uri": str(plugin.get_uri()),
            "bundle": path_of(str(plugin.get_bundle_uri())),
            "binary": path_of(str(library)) if library is not None else None,
        })
    out.sort(key=lambda p: p["uri"])
    json.dump({"plugins": out}, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
