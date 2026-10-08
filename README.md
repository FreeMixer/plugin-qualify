# plugin-qualify

Can this audio plugin be hosted in a real-time audio engine, and at what cost? `plugin-qualify`
scans a plugin, measures it offline (latency and CPU cost per rate and quantum), runs it
under a real host (mod-host, with an AddressSanitizer build), and gives one verdict.
Licence: GPL-3.0-or-later (`LICENSE`).

## Install

Fedora:

```
sudo dnf config-manager addrepo --from-repofile=https://freemixer.github.io/rpm/freemixer.repo
sudo dnf install plugin-qualify
```

Debian bookworm and trixie, and Raspberry Pi OS: add the apt line from <https://freemixer.github.io>, then

```
sudo apt install plugin-qualify
```

Or from npm, to use it as a library or without a system package:

```
npm install @openmixer/plugin-qualify
```

All three give the library and the `plugin-qualify` command. It needs Node.js 22 or newer. The
measuring tools also want Python 3 with the lilv bindings (`python3-lilv`) and, for the hosting
sweep, `mod-host`. Working from a checkout is described in `BUILDING.md`.

## Run it on your own plugin

```
plugin-qualify urn:example:my-plugin          # one plugin, by URI
plugin-qualify ./my-plugin.lv2                # every plugin in a bundle
plugin-qualify --all                          # everything lilv finds (LV2_PATH honoured)
plugin-qualify --help                         # every option and its default
```

`--format json` prints the verdicts as JSON; `--out <dir>` writes the full measurement document.
`--isolate` measures each plugin in a fresh worker so a crash or hang takes only that plugin;
`--no-host-sweep` measures offline only, without mod-host. The `Containerfile` builds an image
with lilv, mod-host and the ASan mod-host, if you do not want to install them yourself.

Exit code: `0` every plugin qualified, `1` some did not, `2` something could not be measured.

## What the verdicts mean

- **suitable**: every dimension was measured and passed. Safe to run inside the engine's own
  process. This is the only verdict that counts as qualified.
- **conditional**: it works, with a caution (for example a high cost at small quanta). It is
  run isolated, and the deciding reason names the caution.
- **unknown**: something was not measured. An unmeasured plugin is never a pass.
- **unsuitable**: a measured failure: a crash, a memory error in the plugin's own binary, a
  real-time violation (allocation, locks or syscalls in `run()`), or a required feature the
  host does not provide.

The worst dimension decides. The text output prints the plugin, its verdict and the reason that
decided it.

## Reproducing a failure

1. Run the plugin alone: `plugin-qualify --format json --out ./out <uri>`.
2. The document in `./out` names the dimension that failed and, for a crash, the sanitizer class
   and the object of the faulting frame.
3. Run the ASan mod-host (`mod-host-asan` in the image) with just that plugin to get the full
   sanitizer report.

`fixtures/zero-path.lv2` is a known-bad plugin (a zero-size `atom:Path` overread). It should
rate **unsuitable**; if it does not, the sweep is not catching memory errors.

## For other projects (zynthian, MOD, packagers)

The measurements describe the plugin and never the host: latency and cost per rate, whether it
survives a thousand lifecycles and a three-hour soak, whether `run()` allocates, locks or makes
syscalls, and which LV2 features it requires. They are taken once. The **verdict** is a separate
step: the same measurements judged against a **host profile**, the facts that differ between
hosts. Two projects share the measurements and differ only in the profile they choose.

### Choosing a host profile

```
plugin-qualify --host-profile jalv ./my-synth.lv2                  # zynthian: one jalv process per plugin
plugin-qualify --host-profile mod-host ./my-fx.lv2                 # MOD: one shared mod-host process
plugin-qualify --host-profile jalv,mod-host,openmixer-console <uri>  # one verdict per profile
plugin-qualify --host-profile ./my-host.json <uri>                 # your own host
```

| profile | isolation | instruments | LV2 features read from | cost budget (P95 of a core, rate / quantum) |
|---|---|---|---|---|
| `openmixer-console` (default) | in-process (the console's RT thread) | no | the console's in-process table | 0.05 at 96000 / 1024 |
| `jalv` | per-process | yes | jalv 1.6.8 `src/jalv.c` (zynthian's fork passes the same list) | 0.25 at 48000 / 256 |
| `mod-host` | shared-process | yes | mod-host f14a230 `src/effects.c` | 0.05 at 48000 / 128 |

The `jalv` and `mod-host` budgets are defaults, not a measurement of your board. State your own
by writing a profile file. Every field is required; a missing or mistyped field is refused and
never filled in with a default:

```json
{
  "id": "zynthian-v5",
  "lv2Features": ["http://lv2plug.in/ns/ext/urid#map", "http://lv2plug.in/ns/ext/urid#unmap",
                  "http://lv2plug.in/ns/ext/worker#schedule", "http://lv2plug.in/ns/ext/log#log",
                  "http://lv2plug.in/ns/ext/options#options",
                  "http://lv2plug.in/ns/ext/state#loadDefaultState",
                  "http://lv2plug.in/ns/ext/buf-size#powerOf2BlockLength",
                  "http://lv2plug.in/ns/ext/buf-size#fixedBlockLength",
                  "http://lv2plug.in/ns/ext/buf-size#boundedBlockLength"],
  "clapExtensions": null,
  "instruments": true,
  "cost": { "coreFractionCeiling": 0.3, "rate": 48000, "quantum": 256 },
  "latency": "uncompensated",
  "isolation": "per-process"
}
```

What each field changes. `lv2Features` is what the host passes to `instantiate`: a plugin that
requires anything else is **unsuitable** on that host. `clapExtensions` is `null` for a host with
no CLAP path. `instruments: true` means a MIDI input is fed, and a plugin with no audio input but
a MIDI input and an audio output rates as an instrument. `cost` is the per-instance ceiling, and
the rate and quantum the verdict is judged at. `latency: "compensated"` means the host aligns on
the plugin's latency, so a latency that moves with a control is a caution. `isolation` decides
whether spawned threads and a linked GUI toolkit count as cautions: they do only when the plugin
shares its process. An unmeasured dimension is **unknown** on every host.

With several profiles, the exit code is `0` only if every plugin qualifies under every profile.

### The JSON document

`--out <dir>` writes one interchange document per run (`lv2-plugin-measurements`, format 1.2,
the same format the OpenMixer console reads). The
`plugins` array holds the raw, host-free measurements. Beside it, `hostProfiles` holds each
profile the run judged against, in full, and `verdicts` holds one entry per plugin per profile:

```json
{ "uri": "urn:example:verb", "host": "jalv", "rating": "unknown", "qualified": false,
  "deciding": "hosting.stability.unsoaked" }
```

`host` is the `id` of an entry in `hostProfiles`. `deciding` is a stable code, absent when the
plugin is `suitable`. If you have your own host rules, re-derive them from `plugins` and do not
trust another host's verdict.

### As a library

`classifyPluginHosting(plugin, { rate, quantum, profile })` gives one verdict, and
`qualifyPlugins(measured, { profiles })` gives one per plugin per profile. `readHostProfile(json)`
validates a profile file, and `judgedDocument(run, plugins, profiles, verdicts)` builds the
document. All of them are exported from the package root. The package depends on no other
openmixer package.

### The container image

```
podman build -t plugin-qualify -f Containerfile .
podman run --rm -v "$PWD/my-plugins:/plugins:ro" -e LV2_PATH=/plugins -v "$PWD/out:/out" \
  plugin-qualify --host-profile jalv --all --out /out
```

The image has lilv, the distribution's mod-host and an AddressSanitizer build of mod-host.

**Status:** the pure steps are in place and tested: target resolution, profile resolution, the
verdict, the document and the exit code. The command-line entry point does not yet drive the
measuring tools (`tools/lv2-measure.mjs`, the mod-host sweep). A run that would measure exits
`2` and names the missing step, rather than rate a plugin on less than was asked.
