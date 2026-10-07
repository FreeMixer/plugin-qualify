# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
"""
The presets an LV2 plugin SHIPS, read off its bundle with lilv.
Law: docs/design/specs/2026-10-01-plugin-presets.md section 2b.

A preset is a `pset:Preset` resource related to the plugin (`plugin.get_related`). For each one
this reads its label, its bank, the port values it sets and whether it carries a `state:state`
body, and judges it against the plugin's own descriptor params:

- `carries`: "params" (port values, no state body), "params+state" (both), "state" (a body only);
- `values`: the values for the plugin's PARAMETERS. A value for a port the plugin has but no
  host sets — an output meter, a hidden (`notOnGUI`) or designated port, which hosts that save
  presets often record — is left out: it is not a parameter, and it is not an error either;
- `invalid`: "UNKNOWN_SYMBOL" when a value names a symbol that is no port of the plugin at all,
  "OUT_OF_TRAVEL" when a value lies outside that param's [min, max]. An invalid preset stays
  listed — refuse or report, never drop.

Only the bundles lilv loads from LV2_PATH are read, which is what the scan reads: the presets a
plugin ships, never one another host saved in a user's home (ruling 2). The output is sorted by
preset URI and the values by symbol, so the same install yields the same bytes.
"""

import struct

PSET = "http://lv2plug.in/ns/ext/presets#"
STATE = "http://lv2plug.in/ns/ext/state#"
LV2 = "http://lv2plug.in/ns/lv2core#"
RDFS = "http://www.w3.org/2000/01/rdf-schema#"


def as_float(node):
    """A preset value node as a float — the TTL LITERAL, or None when it is not a number.

    The literal first: lilv's float() goes through a C float, so "0.478000" comes back as
    0.4779999852..., and a host's param_get ("%f", 0.478000) would then read as an edit nobody
    made the moment the preset loaded.
    """
    if node is None:
        return None
    try:
        return float(str(node))
    except (ValueError, TypeError):
        try:
            return float(node)
        except (ValueError, TypeError):
            return None


def carries_of(values, has_state):
    """What a preset sets — the three words of the spec, from what the TTL holds."""
    if has_state and values:
        return "params+state"
    if has_state:
        return "state"
    return "params"


def invalid_of(values, params):
    """The first reason a preset can never be loaded against `params`, or None.

    `params` are the descriptor's CONTROL params (symbol, min, max). A symbol the descriptor does
    not carry is checked before the travel: a value for a port that does not exist has no travel.
    """
    by_symbol = {p["symbol"]: p for p in params if p.get("kind", "control") == "control"}
    for v in values:
        if v["symbol"] not in by_symbol:
            return "UNKNOWN_SYMBOL"
    for v in values:
        p = by_symbol[v["symbol"]]
        lo, hi = p.get("min"), p.get("max")
        # The travel's ends were scanned through a C float (lilv), the value is the TTL literal:
        # compare at the port's own precision, or "0.707" sits below its own min of "0.707".
        value = as_port_float(v["value"])
        if lo is not None and value < lo:
            return "OUT_OF_TRAVEL"
        if hi is not None and value > hi:
            return "OUT_OF_TRAVEL"
    return None


def as_port_float(value):
    """`value` rounded to the C float an LV2 control port holds."""
    return struct.unpack("f", struct.pack("f", value))[0]


def preset_entry(uri, name, bank, values, has_state, params, port_symbols=frozenset()):
    """One descriptor `presets[]` entry, with absent fields left out rather than null.

    `port_symbols` are every port of the plugin; a value for one of them that is not a control
    PARAM is dropped (see the module header), any other unknown symbol keeps the preset invalid.
    """
    controls = {p["symbol"] for p in params if p.get("kind", "control") == "control"}
    values = sorted((v for v in values if v["symbol"] in controls or v["symbol"] not in port_symbols),
                    key=lambda v: v["symbol"])
    out = {"uri": uri, "name": name}
    if bank:
        out["bank"] = bank
    out["carries"] = carries_of(values, has_state)
    if values:
        out["values"] = values
    reason = invalid_of(values, params)
    if reason:
        out["invalid"] = reason
    return out


def read_presets(world, plugin, params):
    """Every preset `plugin` ships, as descriptor entries sorted by URI."""
    uri = world.new_uri
    port_symbols = frozenset(str(plugin.get_port_by_index(i).get_symbol())
                             for i in range(plugin.get_num_ports()))
    related = plugin.get_related(uri(PSET + "Preset"))
    out = []
    for node in (related if related is not None else []):
        world.load_resource(node)
        label = world.get(node, uri(RDFS + "label"), None)
        bank_node = world.get(node, uri(PSET + "bank"), None)
        bank = None
        if bank_node is not None:
            bank_label = world.get(bank_node, uri(RDFS + "label"), None)
            bank = str(bank_label) if bank_label is not None else None
        values = []
        for port in (world.find_nodes(node, uri(LV2 + "port"), None) or []):
            symbol = world.get(port, uri(LV2 + "symbol"), None)
            value = as_float(world.get(port, uri(PSET + "value"), None))
            if symbol is not None and value is not None:
                values.append({"symbol": str(symbol), "value": value})
        has_state = world.get(node, uri(STATE + "state"), None) is not None
        name = str(label) if label is not None else str(node)
        out.append(preset_entry(str(node), name, bank, values, has_state, params, port_symbols))
    out.sort(key=lambda p: p["uri"])
    return out
