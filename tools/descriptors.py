#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
"""
The scanned descriptors both scanners write (owner spec 6.6 and 6.9): one file per plugin, in
omx-contract's descriptor words, named by the plugin's id, its version and the SHA-256 of its
binary, in `descriptor_dir`.

This module is the one writer: it resolves the directory, names the file, holds the document to
the one descriptor schema (omx-contract's) and writes it whole. `scan.py` maps an LV2 plugin into a
descriptor through lilv and writes it here; for CLAP, `clap-qualify --json` reads the plugin and
`descriptors.py clap` maps its scan document. A descriptor the schema refuses is never written:
it is refused with omx-contract's code, `contract.file.invalid`, and the scan goes on.

A scan writes only what the plugin states. What it does not state is `unknown` (a unit, a scale,
a meaning), or absent; a fact of the format that has no descriptor word is carried verbatim in
`extensions.<format>` under the field the format names it by.

Usage:
  clap-qualify --json <path.clap>... | descriptors.py clap [--descriptor-dir DIR | --system] [-]
  descriptors.py clap [--descriptor-dir DIR | --system] scan.json
"""
import argparse
import hashlib
import json
import os
import re
import sys

from _declarations import (
    DESCRIPTOR_CODE_BINARY_UNHASHED,
    DESCRIPTOR_CODE_DIR_UNWRITABLE,
    DESCRIPTOR_CODE_SCHEMA,
    DESCRIPTOR_CODE_SCHEMA_MISSING,
    DESCRIPTOR_DIR_STATE_SUBDIR,
    DESCRIPTOR_DIR_SYSTEM,
    DESCRIPTOR_HASH_PREFIX,
    DESCRIPTOR_SCHEMA_ENV,
    DESCRIPTOR_SCHEMA_FLOOR,
    DESCRIPTOR_SCHEMA_INSTALLED,
)

SCHEMA_URL = "https://github.com/FreeMixer/omx-contract/raw/v3/schema/omx-contract.schema.json"
TOOLS = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(TOOLS)

# the plugin features the descriptor has words for: CLAP's own names, LV2 classes mapped onto them
FEATURE_WORDS = ("audio-effect", "instrument", "note-effect", "analyzer")


class DescriptorRefused(Exception):
    """A descriptor that is not written, with the code it is refused by."""

    def __init__(self, code, problem):
        super().__init__(f"{code}: {problem}")
        self.code = code
        self.problem = problem


# ---- the directory and the name -----------------------------------------------------------------

def descriptor_dir(named=None, system=False, env=None, home=None):
    """`descriptor_dir`: the directory named, else a system service's, else the user's state directory."""
    if named:
        return named
    if system:
        return DESCRIPTOR_DIR_SYSTEM
    env = os.environ if env is None else env
    state = env.get("XDG_STATE_HOME") or os.path.join(home or os.path.expanduser("~"), ".local", "state")
    return os.path.join(state, *DESCRIPTOR_DIR_STATE_SUBDIR.split("/"))


def _safe(text):
    return re.sub(r"[^A-Za-z0-9._-]", "_", text)


def descriptor_file_name(plugin_id, version, sha256):
    """`<id>@<version>-<sha256 first 12>.json`, the base-name rule of the qualification record."""
    if not isinstance(sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", sha256):
        raise DescriptorRefused(DESCRIPTOR_CODE_BINARY_UNHASHED, f"{plugin_id}: no SHA-256 of its binary")
    return f"{_safe(plugin_id)}@{_safe(version or 'unversioned')}-{sha256[:DESCRIPTOR_HASH_PREFIX]}.json"


def file_sha256(path):
    """The SHA-256 of a file's bytes, as plugin-hostd's pin.h computes it."""
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
    except OSError as e:
        raise DescriptorRefused(DESCRIPTOR_CODE_BINARY_UNHASHED, f"{path}: {e.strerror}") from e
    return h.hexdigest()


# ---- the schema ---------------------------------------------------------------------------------

def schema_candidates(env=None):
    """Where the one schema is looked for, in order: the setting, this package's omx-contract, the installed one."""
    env = os.environ if env is None else env
    named = env.get(DESCRIPTOR_SCHEMA_ENV)
    if named:
        return [named]
    rel = os.path.join("schema", "omx-contract.schema.json")
    return [
        os.path.join(PKG, "node_modules", "@openmixer", "omx-contract", rel),  # a checkout
        os.path.join(os.path.dirname(PKG), "omx-contract", rel),  # installed beside this package
        DESCRIPTOR_SCHEMA_INSTALLED,
    ]


class SchemaValidator:
    """omx-contract's schema, compiled once; `check` refuses a document it does not hold."""

    def __init__(self, path=None, env=None):
        found = [path] if path else [p for p in schema_candidates(env) if os.path.isfile(p)]
        if not found or not os.path.isfile(found[0]):
            raise DescriptorRefused(DESCRIPTOR_CODE_SCHEMA_MISSING,
                                    f"no omx-contract schema at {', '.join(schema_candidates(env))}")
        self.path = found[0]
        try:
            import jsonschema
        except ImportError as e:
            raise DescriptorRefused(DESCRIPTOR_CODE_SCHEMA_MISSING, "python3-jsonschema is not installed") from e
        with open(self.path, encoding="utf-8") as f:
            schema = json.load(f)
        cls = jsonschema.validators.validator_for(schema)
        self._validator = cls(schema)
        self.version = schema.get("x-omx-schema-version")

    def check(self, doc):
        if not isinstance(doc, dict) or doc.get("origin") != "scanned":
            raise DescriptorRefused(DESCRIPTOR_CODE_SCHEMA, "a scanned descriptor carries origin scanned")
        errors = sorted(self._validator.iter_errors(doc), key=lambda e: list(e.absolute_path))
        if errors:
            e = errors[0]
            where = "/".join(str(p) for p in e.absolute_path) or "(the file)"
            raise DescriptorRefused(DESCRIPTOR_CODE_SCHEMA, f"{where}: {e.message}")


def write_descriptor(directory, doc, sha256, validator):
    """Hold `doc` to the schema and write it whole into `directory`; the path written, or DescriptorRefused."""
    validator.check(doc)
    name = descriptor_file_name(doc["plugin"]["id"], doc["plugin"].get("version"), sha256)
    try:
        os.makedirs(directory, mode=0o700, exist_ok=True)
        path = os.path.join(directory, name)
        pending = path + ".new"
        with open(pending, "w", encoding="utf-8") as f:
            f.write(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
        os.replace(pending, path)
    except OSError as e:
        raise DescriptorRefused(DESCRIPTOR_CODE_DIR_UNWRITABLE, f"{directory}: {e.strerror}") from e
    return path


def write_all(directory, described, validator, err=sys.stderr):
    """Write each `(doc, sha256)`; a refusal is reported by its code and the others go on. (written, refused)."""
    written, refused = [], []
    for doc, sha256 in described:
        try:
            written.append(write_descriptor(directory, doc, sha256, validator))
        except DescriptorRefused as e:
            pid = (doc.get("plugin") or {}).get("id", "?") if isinstance(doc, dict) else "?"
            refused.append((pid, e.code, e.problem))
            err.write(f"descriptor refused: {pid}: {e.code}: {e.problem}\n")
    return written, refused


# ---- shared words -------------------------------------------------------------------------------

def head(fmt, plugin):
    """The fields every scanned descriptor opens with."""
    return {
        "$schema": SCHEMA_URL,
        "requires": {"omx-contract-schema": DESCRIPTOR_SCHEMA_FLOOR},
        "origin": "scanned",
        "plugin": {"format": fmt, **plugin},
    }


def link_segment(text):
    """A path segment or a selector key a link can hold; a character it cannot is written `_`."""
    return re.sub(r"[^A-Za-z0-9_+.-]", "_", text) or "_"


def link_key(text):
    """A link's selector key, `[<key>]`; a character it cannot hold is written `_`."""
    return re.sub(r"[^A-Za-z0-9_.-]", "_", text) or "_"


def link_symbol(text):
    """A link's symbol: an identifier, `_` for a character it cannot hold."""
    s = re.sub(r"[^A-Za-z0-9_]", "_", text)
    return s if re.match(r"[A-Za-z_]", s) else "_" + s


def one_line(text):
    text = " ".join((text or "").split())
    return text or None


def choice_ids(labels):
    """A choice's ids, from its labels: their letters and digits, `v<n>` where that is empty or taken."""
    ids, seen = [], set()
    for n, label in enumerate(labels):
        word = re.sub(r"[^A-Za-z0-9]", "", label)
        word = word[:1].lower() + word[1:]
        if not word or word in seen:
            word = f"v{n}"
        while word in seen:
            word += "x"
        seen.add(word)
        ids.append(word)
    return ids


def _number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != float("inf")


# ---- CLAP: clap-qualify's scan document ---------------------------------------------------------

CLAP_DIALECTS = {"clap": "clap", "midi": "midi", "midi_mpe": "midiMpe", "midi2": "midi2"}
CLAP_LAYOUTS = {"mono": "mono", "stereo": "stereo", "surround": "surround"}


def clap_control(p, entry):
    flags = set(p.get("flags", []))
    c = {"id": p["id"], "name": p["name"] or str(p["id"])}
    labels = p.get("labels") or []
    if "enum" in flags and labels:
        ids = choice_ids([lb["label"] for lb in labels])
        c["kind"] = "choice"
        c["ids"] = ids
        if all(lb["label"] for lb in labels):
            c["labels"] = [lb["label"] for lb in labels]
        c["values"] = [lb["value"] for lb in labels]
        for i, lb in enumerate(labels):
            if lb["value"] == p.get("default"):
                c["default"] = ids[i]
    else:
        c["kind"] = "travel"
        travel = {
            "min": p["min"],
            "max": p["max"],
            "unit": "unknown",
            "scale": "stepped" if "stepped" in flags else "unknown",
        }
        if "stepped" in flags:
            travel["step"] = 1
        if _number(p.get("default")):
            travel["default"] = p["default"]
        c["travel"] = travel
    if p.get("module"):
        group = [g for g in p["module"].split("/") if g]
        if group:
            c["group"] = group
    c["meaning"] = "bypass" if "bypass" in flags else "unknown"
    for flag in ("hidden", "readonly", "automatable"):
        if flag in flags:
            c[flag] = True
    c["source"] = {"from": f"{entry}[{p['id']}]"}
    return c


def open_bound(p):
    """A parameter the plugin leaves unbounded: no travel holds it, so it is carried verbatim instead."""
    labels = p.get("labels") or []
    return not ("enum" in p.get("flags", []) and labels) and not (_number(p.get("min")) and _number(p.get("max")))


def clap_ports(p):
    ports = []
    for direction, key in (("in", "inputs"), ("out", "outputs")):
        for port in p["audio_ports"][key]:
            q = {"id": port["id"], "name": port["name"] or f"audio {direction} {port['id']}",
                 "kind": "audio", "direction": direction, "role": port["role"]}
            if port.get("channels", 0) >= 1:
                q["channels"] = port["channels"]
            layout = CLAP_LAYOUTS.get(port.get("port_type") or "")
            if layout:
                q["layout"] = layout
            ports.append(q)
    notes = p.get("note_port_info")
    for direction, key in (("in", "inputs"), ("out", "outputs")):
        for port in (notes or {}).get(key, []):
            q = {"id": port["id"], "name": port["name"] or f"notes {direction} {port['id']}",
                 "kind": "note", "direction": direction}
            dialects = [CLAP_DIALECTS[d] for d in port.get("dialects", []) if d in CLAP_DIALECTS]
            if dialects:
                q["dialects"] = dialects
            ports.append(q)
    return ports


def clap_descriptor(p, path):
    """One plugin of clap-qualify's scan document as a scanned descriptor."""
    entry = f"{link_segment(os.path.basename(path))}#clap_entry[{link_key(p['id'])}]"
    plugin = {"id": p["id"], "name": p["name"] or p["id"]}
    if p.get("vendor"):
        plugin["vendor"] = p["vendor"]
    if p.get("version"):
        plugin["version"] = p["version"]
    doc = one_line(p.get("description"))
    if doc:
        plugin["doc"] = doc
    stated = [f for f in p.get("features", []) if f in FEATURE_WORDS]
    plugin["features"] = list(dict.fromkeys(stated)) or ["audio-effect"]
    d = head("clap", plugin)
    params = p.get("params", [])
    d["controls"] = [clap_control(q, entry) for q in params if not open_bound(q)]
    d["ports"] = clap_ports(p)
    if "latency_extension" in p:
        d["latency"] = {"reports": bool(p["latency_extension"])}
    bag = {}
    if p.get("features"):
        bag["clap_plugin_descriptor.features"] = list(p["features"])
    if p.get("url"):
        bag["clap_plugin_descriptor.url"] = p["url"]
    if "latency" in p:
        bag["clap_plugin_latency.get"] = p["latency"]
    unbounded = [q for q in params if open_bound(q)]
    if unbounded:
        bag["clap_plugin_params.get_info"] = unbounded
    if p.get("remote_controls"):
        bag["clap_plugin_remote_controls.get"] = p["remote_controls"]
    if bag:
        d["extensions"] = {"clap": bag}
    d["source"] = {"from": entry}
    return d


def clap_described(scan, err=sys.stderr):
    """Every plugin of a clap-qualify scan document as `(doc, sha256)`; a file that held none is reported."""
    if not isinstance(scan, dict) or not isinstance(scan.get("files"), list):
        raise DescriptorRefused(DESCRIPTOR_CODE_SCHEMA, "not a CLAP scan document")
    out = []
    for f in scan["files"]:
        if "plugins" not in f:
            err.write(f"not described: {f.get('path')}: {f.get('error')}\n")
            continue
        for p in f["plugins"]:
            if "error" in p:
                err.write(f"not described: {p.get('id')}: {p['error']}\n")
                continue
            out.append((clap_descriptor(p, f["path"]), f.get("sha256")))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="Write the scanned descriptors of a CLAP scan document.")
    ap.add_argument("format", choices=["clap"], help="the scan document's format")
    ap.add_argument("scan", nargs="?", default="-", help="clap-qualify --json output (default: stdin)")
    where = ap.add_mutually_exclusive_group()
    where.add_argument("--descriptor-dir", help="where the descriptors go (descriptor_dir)")
    where.add_argument("--system", action="store_true", help=f"a system service's directory, {DESCRIPTOR_DIR_SYSTEM}")
    args = ap.parse_args(argv)
    try:
        text = sys.stdin.read() if args.scan == "-" else open(args.scan, encoding="utf-8").read()
        scan = json.loads(text)
    except (OSError, ValueError) as e:
        sys.stderr.write(f"cannot read the scan document: {e}\n")
        return 2
    try:
        validator = SchemaValidator()
        described = clap_described(scan)
    except DescriptorRefused as e:
        sys.stderr.write(f"{e.code}: {e.problem}\n")
        return 2
    directory = descriptor_dir(args.descriptor_dir, args.system)
    written, refused = write_all(directory, described, validator)
    for path in written:
        print(path)
    return 2 if refused else 0


if __name__ == "__main__":
    sys.exit(main())
