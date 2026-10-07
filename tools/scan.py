#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
"""
Introspect installed LV2 plugins with lilv (the same library Zynthian uses) and
emit a JSON catalog of plugin descriptors for openmixer.

Each descriptor carries everything the graphical configurator needs to
auto-generate the right control per parameter: type, range, default, integer/
toggle/enumeration/logarithmic/trigger flags, enumeration scale points, the unit
symbol (LV2 units extension), and audio in/out port counts. Both kinds of
parameter are captured: classic LV2 **control ports** (set via mod-host
`param_set <id> <symbol> <value>`) and LV2 **Patch properties** (`lv2:Parameter`
flagged `patch:writable`, set via `patch_set <id> <uri> <value>`).

Usage:
  scan.py                       # scan all installed plugins -> stdout JSON
  scan.py --out catalog.json    # write to a file
  scan.py URI [URI ...]         # scan only these URIs (faster, for tests)
  scan.py --annotate catalog.json   # refresh only the DECLARED fields, in place
"""
import argparse
import json
import subprocess
import sys

from lv2_presets import read_presets

LV2 = "http://lv2plug.in/ns/lv2core#"
MINIMUM = LV2 + "minimum"
MAXIMUM = LV2 + "maximum"
DEFAULT = LV2 + "default"
PP = "http://lv2plug.in/ns/ext/port-props#"
UNITS = "http://lv2plug.in/ns/extensions/units#"
PATCH = "http://lv2plug.in/ns/ext/patch#"
ATOM = "http://lv2plug.in/ns/ext/atom#"
RDFS = "http://www.w3.org/2000/01/rdf-schema#"
MIDI = "http://lv2plug.in/ns/ext/midi#"

# An output control port designated lv2:latency reports the plugin's own latency
# (in frames) — the truth a host delay-compensates by, and what openmixer reads to
# annotate the catalog. Captured here as a symbol so the benchmark + the engine can
# read the live value. `lv2:reportsLatency` is the (legacy) port property form.
LATENCY = LV2 + "latency"
REPORTS_LATENCY = LV2 + "reportsLatency"

# A plugin's own version. Recorded because a measured latency without it is a trap:
# the next release moves the FFT window and a committed figure becomes wrong without
# becoming absent. Absent here means the plugin declares no version — NOT "0.0",
# which is a real LV2 answer meaning "unstable/development".
MINOR_VERSION = LV2 + "minorVersion"
MICRO_VERSION = LV2 + "microVersion"

# Common LV2 unit URIs -> display symbol. Plugins may also carry an explicit
# units:symbol (handled below); this is the fallback for the standard units.
KNOWN_UNITS = {
    UNITS + "db": "dB", UNITS + "hz": "Hz", UNITS + "khz": "kHz",
    UNITS + "s": "s", UNITS + "ms": "ms", UNITS + "pc": "%",
    UNITS + "semitone12TET": "semi", UNITS + "cent": "ct",
    UNITS + "degree": "deg", UNITS + "coef": "x", UNITS + "oct": "oct",
    UNITS + "bpm": "BPM", UNITS + "midiNote": "note", UNITS + "frame": "fr",
}


def fnum(node):
    """float(node) tolerant of None and integer/string-typed nodes.

    lilv's Node.__float__ raises unless the node is a float literal, but LV2
    min/max/default are often integer literals — so fall back to parsing the
    string form, and return None for anything non-numeric.
    """
    if node is None:
        return None
    try:
        return float(node)
    except (ValueError, TypeError):
        try:
            return float(str(node))
        except (ValueError, TypeError):
            return None


def first(nodes):
    """First element of a lilv Nodes collection, or None."""
    if nodes is None:
        return None
    for n in nodes:
        return n
    return None


def bundle_path(plugin):
    """Filesystem path of a lilv plugin's bundle (the `.lv2` dir), or None.

    lilv returns a `file://` URI for the bundle; strip the scheme so `rpm -qf` can own it.
    """
    try:
        uri = plugin.get_bundle_uri()
    except Exception:  # noqa: BLE001 - a plugin with no resolvable bundle just has no owner
        return None
    if uri is None:
        return None
    p = str(uri)
    if p.startswith("file://"):
        p = p[len("file://"):]
    return p.rstrip("/") or None


def owning_rpm(path, run=subprocess.run):
    """The RPM package name owning `path`, or None (unowned / rpm unavailable / error).

    `run` is injectable (defaults to subprocess.run) so the mapping unit-tests without rpm.
    Every plugin on the rig is expected to map to exactly one RPM (no hand-installed plugins);
    a None here is surfaced by the assembler (Task 5) as an unpackaged plugin, never silently
    dropped.
    """
    if not path:
        return None
    try:
        r = run(["rpm", "-qf", "--queryformat", "%{NAME}", path],
                capture_output=True, text=True, check=False, timeout=15)
    except Exception:  # noqa: BLE001 - rpm not installed / timeout: no owner, not a scan failure
        return None
    if r.returncode != 0:
        return None
    name = (r.stdout or "").strip()
    return name or None


class Scanner:
    def __init__(self):
        # lilv is imported here, not at module load: the owner mapping and the pure helpers
        # (test_scan.py) run on a host without the bindings, the way benchmark.py's worker does.
        import lilv

        self.w = lilv.World()
        self.w.load_all()
        self.u = {k: self.w.new_uri(k) for k in (
            LV2 + "AudioPort", LV2 + "ControlPort", LV2 + "CVPort",
            LV2 + "InputPort", LV2 + "OutputPort", ATOM + "AtomPort",
            LV2 + "integer", LV2 + "toggled", LV2 + "enumeration",
            PP + "logarithmic", PP + "trigger", PP + "notOnGUI",
            UNITS + "unit", UNITS + "symbol", PATCH + "writable",
            RDFS + "label", RDFS + "range", MIDI + "MidiEvent",
            LV2 + "designation", LATENCY, REPORTS_LATENCY,
            MINIMUM, MAXIMUM, DEFAULT,
        )}

    def is_a(self, port, uri):
        return port.is_a(self.u[uri])

    def has(self, port, uri):
        return bool(port.has_property(self.u[uri]))

    def unit_symbol(self, port):
        un = first(port.get_value(self.u[UNITS + "unit"]))
        if un is None:
            return None
        uri = str(un)
        if uri in KNOWN_UNITS:
            return KNOWN_UNITS[uri]
        sym = first(self.w.find_nodes(un, self.u[UNITS + "symbol"], None))
        return str(sym) if sym is not None else None

    def scale_points(self, port):
        out = []
        sps = port.get_scale_points()
        if sps:
            for sp in sps:
                v = fnum(sp.get_value())
                if v is not None:
                    out.append({"label": str(sp.get_label()), "value": v})
        out.sort(key=lambda s: s["value"])
        return out

    def control_param(self, port):
        d, mn, mx = port.get_range()
        nm = port.get_name()
        sps = self.scale_points(port)
        mnf, mxf, df = fnum(mn), fnum(mx), fnum(d)
        return {
            "kind": "control",
            "symbol": str(port.get_symbol()),
            "name": str(nm) if nm is not None else str(port.get_symbol()),
            "min": mnf if mnf is not None else 0.0,
            "max": mxf if mxf is not None else 1.0,
            "default": df if df is not None else (mnf if mnf is not None else 0.0),
            "isInteger": self.has(port, LV2 + "integer"),
            "isToggle": self.has(port, LV2 + "toggled"),
            # Enumeration is ONLY the explicit lv2:enumeration designation. Scale
            # points are labels/snap-hints layered on top (carried below) — a
            # continuous port that happens to label one value (e.g. darc Ratio's
            # lone "Lim" mark) is NOT a dropdown.
            "isEnumeration": self.has(port, LV2 + "enumeration"),
            "isLogarithmic": self.has(port, PP + "logarithmic"),
            "isTrigger": self.has(port, PP + "trigger"),
            "unit": self.unit_symbol(port),
            **({"scalePoints": sps} if sps else {}),
        }

    def is_latency_port(self, port):
        """True for an output control port that reports the plugin's latency.

        Two LV2 spellings: `lv2:designation lv2:latency` (current) and the legacy
        `lv2:reportsLatency` port property. Either marks the port whose value is the
        plugin's latency in frames.
        """
        try:
            for d in (port.get_value(self.u[LV2 + "designation"]) or []):
                if str(d) == LATENCY:
                    return True
        except Exception:  # noqa: BLE001
            pass
        return self.has(port, REPORTS_LATENCY)

    def patch_params(self, plugin):
        """LV2 Parameters (patch:writable) — the atom-port / patch:Set kind.

        Numeric patch params (Int/Long/Float/Double) often declare lv2:minimum /
        maximum / default just like control ports; capture them so the configurator
        can render a bounded widget (stepper/knob) instead of a bare readout.
        """
        out = []
        try:
            writable = plugin.get_value(self.u[PATCH + "writable"])
            for puri in (writable if writable is not None else []):
                label = first(self.w.find_nodes(
                    puri, self.u[RDFS + "label"], None))
                rng = first(self.w.find_nodes(
                    puri, self.u[RDFS + "range"], None))
                mn = fnum(first(self.w.find_nodes(puri, self.u[MINIMUM], None)))
                mx = fnum(first(self.w.find_nodes(puri, self.u[MAXIMUM], None)))
                df = fnum(first(self.w.find_nodes(puri, self.u[DEFAULT], None)))
                out.append({
                    "kind": "patch",
                    "symbol": str(puri).rsplit("#", 1)[-1].rsplit("/", 1)[-1],
                    "uri": str(puri),
                    "name": str(label) if label is not None else str(puri),
                    "datatype": str(rng).rsplit("#", 1)[-1] if rng is not None else "String",
                    **({"min": mn} if mn is not None else {}),
                    **({"max": mx} if mx is not None else {}),
                    **({"default": df} if df is not None else {}),
                })
        except Exception as e:  # noqa: BLE001 - best-effort, never fail the scan
            sys.stderr.write(f"  patch params skipped: {e}\n")
        return out

    def describe(self, plugin):
        params, audio_in, audio_out, midi_in = [], 0, 0, False
        latency_symbol = None
        for i in range(plugin.get_num_ports()):
            port = plugin.get_port_by_index(i)
            if self.is_a(port, LV2 + "AudioPort"):
                if self.is_a(port, LV2 + "InputPort"):
                    audio_in += 1
                else:
                    audio_out += 1
            elif self.is_a(port, LV2 + "ControlPort") and self.is_a(port, LV2 + "InputPort"):
                if self.has(port, PP + "notOnGUI"):
                    continue
                params.append(self.control_param(port))
            elif self.is_a(port, LV2 + "ControlPort") and self.is_a(port, LV2 + "OutputPort"):
                # output control ports aren't user params, but the lv2:latency one
                # tells us (and the benchmark) where to read the plugin's latency.
                if latency_symbol is None and self.is_latency_port(port):
                    latency_symbol = str(port.get_symbol())
            elif self.is_a(port, ATOM + "AtomPort") and self.is_a(port, LV2 + "InputPort"):
                try:
                    if port.supports_event(self.u[MIDI + "MidiEvent"]):
                        midi_in = True
                except Exception:  # noqa: BLE001
                    pass
        params.extend(self.patch_params(plugin))
        cls = plugin.get_class().get_label()
        out = {
            "uri": str(plugin.get_uri()),
            "name": str(plugin.get_name()),
            "lv2Class": str(cls) if cls is not None else None,
            "audioInputs": audio_in,
            "audioOutputs": audio_out,
            "hasMidiIn": midi_in,
            "params": params,
        }
        # The bundle's own one-line description of itself. A DECLARED fact, like the
        # class beside it, and the only other thing a plugin says about its role —
        # which is what the kind ladder falls through to when a plugin declares the
        # bare lv2:Plugin and nothing more (416 of the reference install's 958 carry
        # one). Absent stays absent: an empty string is not a description.
        comment = declared_comment(plugin, self.w)
        if comment:
            out["lv2Comment"] = comment
        # The presets the plugin SHIPS (docs/design/specs/2026-10-01-plugin-presets.md section 2b):
        # a DECLARED fact like the comment above, read off the bundle and judged against the params
        # just read. Always present on a scanned plugin — `[]` is "ships none", never "not read".
        out["presets"] = read_presets(self.w, plugin, params)
        # Record the latency port symbol if the plugin reports one. The actual frame
        # value is filled later by the on-rig benchmark (benchmark.py); a plugin with
        # no latency port carries no `latency` key → host treats it as unknown, not 0.
        if latency_symbol is not None:
            out["latency"] = {"portSymbol": latency_symbol}
        version = self.plugin_version(plugin)
        if version is not None:
            out["minorVersion"], out["microVersion"] = version
        bp = bundle_path(plugin)
        out["bundlePath"] = bp
        out["owningRpm"] = owning_rpm(bp)
        return out

    def plugin_version(self, plugin):
        """(minor, micro) from lv2:minorVersion / lv2:microVersion, or None.

        Both or neither: a half-declared version is not a version, and pairing a real
        minor with an invented micro would make two builds compare equal that are not.
        """
        minor = fnum(first(plugin.get_value(self.w.new_uri(MINOR_VERSION))))
        micro = fnum(first(plugin.get_value(self.w.new_uri(MICRO_VERSION))))
        if minor is None or micro is None:
            return None
        return int(minor), int(micro)

    def scan(self, uris=None):
        plugins = self.w.get_all_plugins()
        out = []
        if uris:
            for uri in uris:
                p = plugins.get_by_uri(self.w.new_uri(uri))
                if p is not None:
                    out.append(self.describe(p))
                else:
                    sys.stderr.write(f"not found: {uri}\n")
        else:
            for p in plugins:
                try:
                    out.append(self.describe(p))
                except Exception as e:  # noqa: BLE001
                    sys.stderr.write(f"skip {p.get_uri()}: {e}\n")
        out.sort(key=lambda d: d["uri"])
        return out


def declared_comment(plugin, world):
    """The bundle's `rdfs:comment` for this plugin, or None.

    One value only: a bundle that declares several is declaring alternatives, and
    concatenating them would invent a sentence nobody wrote.
    """
    nodes = plugin.get_value(world.new_uri(RDFS + "comment"))
    values = list(nodes) if nodes is not None else []
    if not values:
        return None
    text = " ".join(str(values[0]).split())
    return text or None


DECLARED_FIELDS = ("name", "lv2Class", "lv2Comment", "presets")


def annotate(catalog, scanner):
    """Refresh the DECLARED fields of every URI already in `catalog`, in place.

    The division of labour this file has always kept: scan.py owns what a plugin
    SAYS about itself, benchmark.py owns what the rig MEASURED of it. So this pass
    rewrites `name`, `lv2Class`, `lv2Comment` and `presets` from the installed bundle and
    touches nothing else — no latency, no cost, no owning package, and no entry is
    added or removed. A URI this host does not have installed is left exactly as it
    is and counted, because "not installed here" and "declares nothing" are
    different facts and only one of them is about the plugin.

    Returns (changed, absent) counts.
    """
    plugins = scanner.w.get_all_plugins()
    changed = 0
    absent = 0
    for entry in catalog:
        plugin = plugins.get_by_uri(scanner.w.new_uri(entry["uri"]))
        if plugin is None:
            absent += 1
            continue
        fresh = scanner.describe(plugin)
        for field in DECLARED_FIELDS:
            before = entry.get(field)
            after = fresh.get(field)
            if after is None:
                entry.pop(field, None)
            else:
                entry[field] = after
            if before != entry.get(field):
                changed += 1
    return changed, absent


def main():
    ap = argparse.ArgumentParser(description="Scan installed LV2 plugins -> JSON.")
    ap.add_argument("uris", nargs="*", help="specific plugin URIs (default: all)")
    ap.add_argument("--out", help="write JSON here (default: stdout)")
    ap.add_argument("--annotate", metavar="FILE",
                    help="refresh only the DECLARED fields of an existing catalog, in place")
    args = ap.parse_args()
    if args.annotate:
        with open(args.annotate, encoding="utf-8") as f:
            catalog = json.load(f)
        if not catalog:
            sys.exit(f"{args.annotate} read as empty; refusing to annotate nothing")
        changed, absent = annotate(catalog, Scanner())
        with open(args.annotate, "w", encoding="utf-8") as f:
            f.write(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n")
        sys.stderr.write(
            f"annotated {len(catalog)} plugins in {args.annotate}: "
            f"{changed} declared fields changed, {absent} not installed here\n")
        return
    catalog = Scanner().scan(args.uris or None)
    text = json.dumps(catalog, indent=2, ensure_ascii=False)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text + "\n")
        sys.stderr.write(f"wrote {len(catalog)} plugins -> {args.out}\n")
        # Sibling URI manifest (committed, small) — the guardrail test cross-checks
        # every curated URI against it, so a typo'd URI fails CI even though the
        # full catalog.json is gitignored/host-specific. Only on a full scan.
        if not args.uris:
            import os
            uri_path = os.path.join(os.path.dirname(args.out) or ".", "installed-uris.json")
            uris = sorted(d["uri"] for d in catalog)
            with open(uri_path, "w", encoding="utf-8") as f:
                f.write(json.dumps(uris, indent=1, ensure_ascii=False) + "\n")
            sys.stderr.write(f"wrote {len(uris)} URIs -> {uri_path}\n")
    else:
        print(text)


if __name__ == "__main__":
    main()
