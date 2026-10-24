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

Beside the catalog, every plugin scanned is written as a scanned descriptor (omx-contract's
descriptor words, `descriptors.py`) into `descriptor_dir`: `--descriptor-dir`, else `--system`'s
directory, else `$XDG_STATE_HOME/omx/descriptors`, else `~/.local/state/omx/descriptors`.

Usage:
  scan.py                       # scan all installed plugins -> stdout JSON
  scan.py --out catalog.json    # write to a file
  scan.py URI [URI ...]         # scan only these URIs (faster, for tests)
  scan.py --annotate catalog.json   # refresh only the DECLARED fields, in place
  scan.py --descriptor-dir DIR  # the scanned descriptors go here
  scan.py --no-descriptors      # the catalog only
"""
import argparse
import json
import os
import subprocess
import sys

import descriptors as desc
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
PG = "http://lv2plug.in/ns/ext/port-groups#"
PARAM = "http://lv2plug.in/ns/ext/parameters#"
TIME = "http://lv2plug.in/ns/ext/time#"

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

# LV2 unit URI -> the descriptor's unit word; any other unit, or none, is `unknown`
DESCRIPTOR_UNITS = {
    UNITS + "db": "dB", UNITS + "hz": "Hz", UNITS + "s": "s", UNITS + "ms": "ms",
    UNITS + "min": "min", UNITS + "pc": "%", UNITS + "semitone12TET": "st", UNITS + "cent": "cents",
    UNITS + "degree": "deg", UNITS + "coef": "x", UNITS + "oct": "oct", UNITS + "bpm": "bpm",
    UNITS + "midiNote": "midiNote", UNITS + "frame": "frames",
}

# lv2:designation -> the descriptor's meaning, where the meaning carries the LV2 term's name
DESIGNATED_MEANINGS = {
    **{PARAM + m: m for m in ("gain", "threshold", "ratio", "attack", "release", "hold", "decay", "frequency",
                              "cutoffFrequency", "resonance", "bypass", "wetDryRatio", "delay")},
    LV2 + "enabled": "enabled",
}

# LV2 classes -> the descriptor's plugin features; a plugin of none of them is an audio effect
CLASS_FEATURES = {
    LV2 + "InstrumentPlugin": "instrument",
    LV2 + "AnalyserPlugin": "analyzer",
    LV2 + "MIDIPlugin": "note-effect",
}

NUMERIC_PATCH_RANGES = ("Float", "Double", "Int", "Long")


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
            LV2 + "isSideChain", LV2 + "name", PG + "group", TIME + "Position",
            "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
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
        # The presets the plugin SHIPS:
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

    # ---- the scanned descriptor ----

    def designation_meaning(self, port):
        """The meaning an lv2:designation names; `unknown` with none; absent (None) for one with no word."""
        des = [str(d) for d in (port.get_value(self.u[LV2 + "designation"]) or [])]
        if not des:
            return "unknown"
        for d in des:
            if d in DESIGNATED_MEANINGS:
                return DESIGNATED_MEANINGS[d]
        return None

    def port_group(self, port):
        """The pg:group a port belongs to, by its name, as a one-step group path."""
        g = first(port.get_value(self.u[PG + "group"]))
        if g is None:
            return None
        label = first(self.w.find_nodes(g, self.u[LV2 + "name"], None)) or first(self.w.find_nodes(g, self.u[RDFS + "label"], None))
        return [str(label)] if label is not None and str(label) else None

    def descriptor_unit(self, port):
        un = first(port.get_value(self.u[UNITS + "unit"]))
        return DESCRIPTOR_UNITS.get(str(un), "unknown") if un is not None else "unknown"

    def descriptor_control(self, port, link, readonly=False):
        """An input (or, readonly, an output) control port as a descriptor control."""
        d, mn, mx = port.get_range()
        mnf, mxf, df = fnum(mn), fnum(mx), fnum(d)
        sym = str(port.get_symbol())
        nm = port.get_name()
        c = {"id": sym, "name": str(nm) if nm is not None else sym}
        sps = self.scale_points(port)
        if self.has(port, LV2 + "toggled"):
            c["kind"] = "toggle"
            if df is not None:
                c["default"] = df > 0
        elif self.has(port, PP + "trigger"):
            c["kind"] = "trigger"
        elif self.has(port, LV2 + "enumeration") and sps:
            ids = desc.choice_ids([sp["label"] for sp in sps])
            c["kind"] = "choice"
            c["ids"] = ids
            if all(sp["label"] for sp in sps):
                c["labels"] = [sp["label"] for sp in sps]
            c["values"] = [sp["value"] for sp in sps]
            for i, sp in enumerate(sps):
                if df is not None and sp["value"] == df:
                    c["default"] = ids[i]
        else:
            # an LV2 port's range defaults to 0..1 where it declares none (the catalog row's own rule)
            integer = self.has(port, LV2 + "integer")
            travel = {
                "min": mnf if mnf is not None else 0.0,
                "max": mxf if mxf is not None else 1.0,
                "unit": self.descriptor_unit(port),
                "scale": "log" if self.has(port, PP + "logarithmic") else "stepped" if integer else "linear",
            }
            if integer:
                travel["step"] = 1
            if df is not None:
                travel["default"] = df
            c["kind"] = "travel"
            c["travel"] = travel
        group = self.port_group(port)
        if group:
            c["group"] = group
        meaning = self.designation_meaning(port)
        if meaning is not None:
            c["meaning"] = meaning
        if self.has(port, PP + "notOnGUI"):
            c["hidden"] = True
        if readonly:
            c["readonly"] = True
        c["source"] = {"from": f"{link}#{desc.link_symbol(sym)}"}
        return c

    def descriptor(self, plugin):
        """The plugin as a scanned descriptor, and the SHA-256 of its binary: `(doc, sha256)`."""
        uri = str(plugin.get_uri())
        bundle = bundle_path(plugin) or ""
        lib = plugin.get_library_uri()
        lib_path = lib.get_path() if lib is not None else None
        try:
            sha256 = desc.file_sha256(lib_path) if lib_path else None
        except desc.DescriptorRefused:
            sha256 = None  # refused by its code when it is written: no name without the binary's hash
        data = sorted(os.path.basename(str(u)) for u in (plugin.get_data_uris() or []))
        ttl = next((f for f in data if f != "manifest.ttl"), "manifest.ttl")
        bundle_seg = desc.link_segment(os.path.basename(bundle))
        link = f"{bundle_seg}/{desc.link_segment(ttl)}"

        types = [str(t) for t in (plugin.get_value(self.u["http://www.w3.org/1999/02/22-rdf-syntax-ns#type"]) or [])]
        features = [CLASS_FEATURES[t] for t in types if t in CLASS_FEATURES]
        p = {"id": uri, "uri": uri, "name": str(plugin.get_name())}
        author = plugin.get_author_name()
        if author is not None and str(author):
            p["vendor"] = str(author)
        version = self.plugin_version(plugin)
        if version is not None:
            p["version"] = f"{version[0]}.{version[1]}"
        comment = declared_comment(plugin, self.w)
        if comment:
            p["doc"] = comment
        p["features"] = list(dict.fromkeys(features)) or ["audio-effect"]
        d = desc.head("lv2", p)

        controls, ports = [], []
        latency_symbol, timed = None, False
        for i in range(plugin.get_num_ports()):
            port = plugin.get_port_by_index(i)
            sym = str(port.get_symbol())
            nm = port.get_name()
            name = str(nm) if nm is not None else sym
            direction = "in" if self.is_a(port, LV2 + "InputPort") else "out"
            if self.is_a(port, LV2 + "AudioPort"):
                ports.append({"id": sym, "name": name, "kind": "audio", "direction": direction,
                              "role": "sidechain" if self.has(port, LV2 + "isSideChain") else "main", "channels": 1})
            elif self.is_a(port, LV2 + "CVPort"):
                ports.append({"id": sym, "name": name, "kind": "cv", "direction": direction})
            elif self.is_a(port, LV2 + "ControlPort"):
                if direction == "out" and latency_symbol is None and self.is_latency_port(port):
                    latency_symbol = sym
                    continue
                controls.append(self.descriptor_control(port, link, readonly=direction == "out"))
            elif self.is_a(port, ATOM + "AtomPort"):
                try:
                    midi = bool(port.supports_event(self.u[MIDI + "MidiEvent"]))
                    timed = timed or (direction == "in" and bool(port.supports_event(self.u[TIME + "Position"])))
                except Exception:  # noqa: BLE001
                    midi = False
                if midi:
                    ports.append({"id": sym, "name": name, "kind": "midi", "direction": direction})

        writable = []
        for prm in self.patch_params(plugin):
            writable.append({"uri": prm["uri"], "label": prm["name"], "range": prm["datatype"]})
            if prm["datatype"] in NUMERIC_PATCH_RANGES and "min" in prm and "max" in prm:
                travel = {"min": prm["min"], "max": prm["max"], "unit": "unknown", "scale": "linear"}
                if "default" in prm:
                    travel["default"] = prm["default"]
                controls.append({"id": desc.link_symbol(prm["symbol"]), "name": prm["name"], "kind": "travel",
                                 "travel": travel, "meaning": "unknown",
                                 "source": {"from": f"{link}#{desc.link_symbol(prm['symbol'])}"}})
        d["controls"] = controls
        d["ports"] = ports

        needs = {}
        if timed:
            needs["tempo"] = needs["transport"] = True
        required = [str(f) for f in (plugin.get_required_features() or [])]
        optional = [str(f) for f in (plugin.get_optional_features() or [])]
        ext = {}
        if required:
            ext["required"] = sorted(set(required))
        if optional:
            ext["optional"] = sorted(set(optional))
        if ext:
            needs["extensions"] = ext
        if needs:
            d["needs"] = needs
        d["latency"] = {"reports": latency_symbol is not None}

        bag = {"rdf:type": str(plugin.get_class().get_uri())}
        if latency_symbol is not None:
            bag["lv2:latency"] = latency_symbol
        if writable:
            bag["patch:writable"] = writable
        d["extensions"] = {"lv2": bag}
        lib_name = os.path.basename(lib_path) if lib_path else "manifest.ttl"
        d["source"] = {"from": f"{bundle_seg}/{desc.link_segment(lib_name)}#lv2_descriptor"}
        return d, sha256

    def descriptors(self, uris=None):
        """`(doc, sha256)` for every plugin `scan` would describe."""
        plugins = self.w.get_all_plugins()
        chosen = [plugins.get_by_uri(self.w.new_uri(u)) for u in uris] if uris else list(plugins)
        out = []
        for p in chosen:
            if p is None:
                continue
            try:
                out.append(self.descriptor(p))
            except desc.DescriptorRefused as e:
                sys.stderr.write(f"descriptor refused: {p.get_uri()}: {e.code}: {e.problem}\n")
            except Exception as e:  # noqa: BLE001 - one plugin's bad data never stops the scan
                sys.stderr.write(f"not described: {p.get_uri()}: {e}\n")
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
    where = ap.add_mutually_exclusive_group()
    where.add_argument("--descriptor-dir", help="where the scanned descriptors go (descriptor_dir)")
    where.add_argument("--system", action="store_true",
                       help=f"a system service's descriptor_dir, {desc.DESCRIPTOR_DIR_SYSTEM}")
    where.add_argument("--no-descriptors", action="store_true", help="write the catalog only")
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
    scanner = Scanner()
    catalog = scanner.scan(args.uris or None)
    refused = 0
    if not args.no_descriptors:
        try:
            validator = desc.SchemaValidator()
        except desc.DescriptorRefused as e:
            sys.exit(f"{e.code}: {e.problem}")
        directory = desc.descriptor_dir(args.descriptor_dir, args.system)
        written, bad = desc.write_all(directory, scanner.descriptors(args.uris or None), validator)
        refused = len(bad)
        sys.stderr.write(f"wrote {len(written)} descriptors -> {directory}\n")
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
    if refused:
        sys.exit(2)


if __name__ == "__main__":
    main()
