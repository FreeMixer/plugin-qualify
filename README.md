# plugin-qualify

Can this audio plugin be hosted in a real-time audio engine, and at what cost? `plugin-qualify`
scans a plugin, measures it offline (latency and CPU cost per rate and quantum), runs it
under a real host (mod-host, with an AddressSanitizer build), and gives one verdict.
Licence: GPL-3.0-or-later (`LICENSE`).

## Install

plugin-qualify is published, signed, in the FreeMixer package channel, for Fedora 44 (x86_64, aarch64)
and for Debian bookworm and trixie, including Raspberry Pi OS (amd64, arm64).

Fedora:

```
sudo dnf config-manager addrepo --from-repofile=https://freemixer.github.io/rpm/freemixer.repo
sudo dnf install plugin-qualify
```

Debian and Raspberry Pi OS:

```
sudo install -d /etc/apt/keyrings
sudo curl -fsSL -o /etc/apt/keyrings/freemixer.asc https://freemixer.github.io/deb/freemixer.asc
echo "deb [signed-by=/etc/apt/keyrings/freemixer.asc] https://freemixer.github.io/deb/debian/$(. /etc/os-release && echo $VERSION_CODENAME) ./" | sudo tee /etc/apt/sources.list.d/freemixer.list
sudo apt update
sudo apt install plugin-qualify
```

From the npm registry:

```
pnpm add @openmixer/plugin-qualify
# or, to install the command globally:
npm install -g @openmixer/plugin-qualify
```

The npm package ships the TypeScript command only, not the native tools. The CLAP prober, the LV2 measurer and
the interposer come with the RPM or DEB, or from `make -C native` in a checkout; with the npm package alone,
point `OMX_CLAP_QUALIFY`, `OMX_LV2_MEASURE` and `OMX_RT_INTERPOSE` at them (the probe runner is plugin-hostd's, `OMX_PROBE_RUNNER`), or CLAP qualification and the LV2
hosting dimensions refuse with "no CLAP prober at ...".

The GitHub release also carries the packed tarball, `openmixer-plugin-qualify-<version>.tgz`. To run from a
checkout instead (Node.js 20 or newer and pnpm 10, see `BUILDING.md`):

```
git clone https://github.com/FreeMixer/plugin-qualify.git
cd plugin-qualify
pnpm install
pnpm exec plugin-qualify --help
```

It needs Node.js 18 or newer to run. The measuring tools also want Python 3 with the lilv bindings
(`python3-lilv`) and, for the hosting sweep, `mod-host`. The `Containerfile` builds an image with all of
them. The commands below are written as `plugin-qualify`; from a checkout run them with `pnpm exec`.

## Run it on your own plugin

```
plugin-qualify urn:example:my-plugin          # one plugin, by URI
plugin-qualify ./my-plugin.lv2                # every plugin in a bundle
plugin-qualify --all                          # every CLAP on the search path; refuses if LV2 bundles are on LV2_PATH
plugin-qualify --help                         # every option and its default
```

`--format json` prints the verdicts as JSON; `--out <dir>` writes the full measurement document.
`--isolate` measures each plugin in a fresh worker so a crash or hang takes only that plugin;
`--no-host-sweep` measures offline only, without mod-host. The `Containerfile` builds an image
with lilv, mod-host and the ASan mod-host, if you do not want to install them yourself.

A named LV2 plugin is measured the same way as a CLAP one: through the probe runner, then judged from the probe
output it writes (`plugin-qualify judge` below). Exit code: `0` every plugin qualified, `1` some did not, `2`
something could not be measured.

## CLAP plugins: the RT-safety verdict

A `.clap` file, or a directory holding one, is scanned by `omx-clap-scan` (from omx-clap-core; set
`OMX_CLAP_SCAN` to its path when it is not on `PATH`) and each plugin in it is then qualified by the
CLAP prober the package installs (from a checkout, the one built from `native/`, see `BUILDING.md`):

```
plugin-qualify ./my-fx.clap                   # every plugin in the file
plugin-qualify --out ./out ./my-fx.clap       # and its RT-safety documents
CLAP_PATH=~/my-clap plugin-qualify --all      # every CLAP on the search path
```

Each plugin is measured by plugin-hostd's probe runner, `plugin-hostd-probe` (from the `plugin-hostd` package, 0.4.0 or later, which
the RPM and DEB require;
`OMX_PROBE_RUNNER` names it when it is not on `PATH`). The runner starts the prober under limits (a wall clock
that kills the whole process tree, CPU time, memory, files), and plugin-qualify waits for the runner and reads
the document it writes, the probe output. Nothing in plugin-qualify times a prober out on its own any more.

`--all` walks the standard CLAP search path through the same scanner: each directory `CLAP_PATH`
names (colon-separated), then `~/.clap`, then `/usr/lib/clap`, which is the system directory on every
distribution and architecture. A plugin id found twice keeps its first place on that path. LV2 plugins
are measured by `tools/lv2-measure.mjs` (below); this entry point does not drive that pass yet, so
`--all` refuses with exit 2 when any `.lv2` bundle is on the LV2 path (`LV2_PATH`, else `~/.lv2` and the
system lv2 directories) rather than qualify only the CLAP side. A directory on the CLAP path that cannot
be read (permissions, a symlink loop) also refuses with exit 2, naming it.

The prober runs each plugin headless at every `--rates` rate, under an interposer that counts the
allocations, locks and syscalls its `process()` makes while every parameter is swept, and prints
the file's SHA-256 beside what it measured. The verdict is the real-time-safety one: **suitable**
only on a clean count, **unsuitable** on any allocation, lock, syscall, main-thread host call from
`process()` or `CLAP_PROCESS_ERROR`, **unknown** when it could not be counted. An instrument is
quiet until it is played, so a plugin with a note input is also played, at every rate and under a
count of its own: a chord, the pitch bent and a controller moved, pressure, the chord let go, a
burst of 32 note ons in one block and their offs, all notes off, in the dialect its note input
reads (CLAP's, else MIDI's). An allocation, lock or syscall while it plays is **unsuitable**
(`hosting.rt-safety.violations-under-notes`); an instrument that could not be played under the
interposer is **unknown** (`hosting.rt-safety.notes-unmeasured`). `--out` writes the qualification records and the probe outputs they judged (see
"Judging a probe output" below), one pair per plugin binary and offered host extensions. Each plugin's pin is
an `integrity` block in the probe output: the `.clap`'s SHA-256 by its file name and the parameter-layout
fingerprint `omx-layout/1:<sha256>`, both computed through plugin-hostd's `pin.h`, which is what a console
hands plugin-hostd as `pin_set` before it adds the plugin. `OMX_CLAP_QUALIFY` and `OMX_RT_INTERPOSE`
name the prober and the interposer the runner starts when they are not the installed ones or the checkout's
own build.

## Judging a probe output

The probe output is the document `plugin-hostd-probe run` writes: one binary and one offer, the steps the
prober reached and how each ended, and the figures per rate and quantum, with no verdict in it. plugin-qualify
reads it with `readProbeOutput`, which refuses a document of a major version it does not know
(`probe.format.major-unknown`), a document that carries a verdict, and a document whose derived fields disagree
with the fields they are computed from (`probe.format.derived-mismatch`): `machine.class.cstatesLimited` and
`machine.profile.meetsProtocol` are recomputed from `cpuidle[]`, the governor and `unmet[]`, never trusted.

```
plugin-hostd-probe run --out out/plate.probe.json ./example-plate.clap org.example.plate
plugin-qualify judge --host-profile omx-clap-host --qualification-dir ./qualification out/plate.probe.json
```

`judge` writes, into the qualification directory (`--qualification-dir`, else `$XDG_STATE_HOME/omx/qualification`,
else `~/.local/state/omx/qualification`), the qualification record `<id>@<version>-<sha256 first 12>.<offer>.qualification.json`
and, beside it, a byte copy of the probe output it judged, `<same name>.probe.json`, because the probe directory
may be wiped. The record names that copy and its SHA-256 in `probe`, with the run's protocol, reason and machine
class, so a reference figure and a local one are told apart. The record holds, for each host profile, the verdict
(`rating`, `hosting`, the deciding reason code and every reason) and the cost reasons at that profile's rate and
quantum, and the figures as measured. Exit `0` every plugin qualified, `1` some did not, `2` something could not
be read or judged.

The verdict is the same one `plugin-qualify` gives CLAP plugins today, the real-time-safety one, now for LV2 as
well; cost is reported beside it, not folded into it. Cost is read at the profile's rate AND quantum: a pair the
document does not hold reads `hosting.cost.unmeasured-at-rate-and-quantum`, and two quanta of one plugin that cost
differently give two different cost reasons. Only a measurement of the old format, which keeps one figure per
rate, is read per rate. A run that did not end `probe.ok` is `unknown`, with the run's outcome code as the reason.

An instrument costs nothing until a voice plays, so its cost is taken with notes held down, at velocity 127,
spread across the keyboard, while every parameter is swept: as many notes as the voice capacity the plugin
declares (CLAP `voice-info`, basis `declared`), or, when it declares none, the count `--probe-notes` gives
(basis `probe`; LV2 declares none). Each rate's figure says how many notes it held and why (`voices: { held,
basis, capacity }`). An instrument with no count to hold is not timed (`voices-unknown`).


The prober also scans: `OMX_CLAP_SCAN=native/build/clap-qualify` makes it the scanner, and its scan
keeps what a console needs to draw a third-party plugin's controls: an enum parameter's labels (as
the plugin's `value_to_text` renders them), each parameter's module, and the plugin's
remote-control pages.

## LV2 plugins: the hosting measurement

`tools/lv2-measure.mjs` measures the hosting dimensions (`stability`, `rtSafety`, `features`) through
the LV2 measurer the package installs, `lv2_measure`: each plugin is loaded through lilv in its own
process, instantiated and destroyed 30 times, and run under the interposer while every control is
swept, at the highest `--rates` rate:

```
node tools/lv2-measure.mjs --rates 48000 --dimensions stability,rtSafety,features \
  --plugins urn:my:plugin --out measurements.json --run
```

Without `--plugins` it measures every plugin the scan finds. Each plugin's entry carries its pin, an
`integrity` block: the SHA-256 of the files the host loads and the parameter-layout fingerprint,
through plugin-hostd's `pin.h`, as for CLAP. `OMX_LV2_MEASURE` and `OMX_RT_INTERPOSE` name the
measurer and the interposer when they are not the installed ones or the checkout's own build.

The features the measurer offers a plugin are the console's own: omx-clap-core's LV2 feature
provider, the code its LV2 host builds every instance's features with. Each of the provider's
options is a flag of `tools/lv2-measure.mjs` and of `lv2_measure` itself, and each plugin's record
names the options it ran under, `featureOptions`:

| flag | what it sets | default |
| --- | --- | --- |
| `--features LIST` | the kinds offered: `map`, `unmap`, `options`, `bounded`, `worker`, `default-state`, `log` (empty: none) | all but `default-state` |
| `--strict` / `--no-strict` | refuse a plugin requiring a feature not offered (the record's `refusedFeature` names it), or hand it to its own instantiate without it | `--no-strict` |
| `--block-declares LIST` | the buf-size declarations made when `bounded` is offered: `bounded`, `fixed`, `pow2` (empty: none) | `bounded` |
| `--block-min N` | `bufsz:minBlockLength`; 0 is the run's block | 1 |
| `--block-max N` | `bufsz:maxBlockLength`; 0 is the run's block | 0 |
| `--block-nominal N` | `bufsz:nominalBlockLength`; 0 is the maximum | 0 |
| `--log MODE` | `log:log` lines: `silent`, `route` (to stderr) or `capture` (into the record's `featureOptions.log.lines`) | `silent` |
| `--log-capture-bytes N` | the capture buffer, its NUL included | 4096 |

The defaults are the measurement as it has always been, so a verdict reached under them does not
move. `lv2_measure --help` lists the same flags.

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
plugin-qualify --host-profile omx-clap-host ./my-synth.clap        # omx-clap-host, alone or under plugin-hostd
plugin-qualify --host-profile jalv,mod-host,openmixer-console <uri>  # one verdict per profile
plugin-qualify --host-profile ./my-host.json <uri>                 # your own host
```

| profile | isolation | instruments | LV2 features read from | cost budget (P95 of a core, rate / quantum) |
|---|---|---|---|---|
| `openmixer-console` (default) | in-process (the console's RT thread) | no | the console's in-process table | 0.05 at 96000 / 1024 |
| `jalv` | per-process | yes | jalv 1.6.8 `src/jalv.c` (zynthian's fork passes the same list) | 0.25 at 48000 / 256 |
| `mod-host` | shared-process | yes | mod-host f14a230 `src/effects.c` | 0.05 at 48000 / 128 |
| `omx-clap-host` | shared-process | yes | the console's in-process table (the same LV2 feature provider) | 0.05 at 48000 / 128 |

`omx-clap-host` offers a CLAP plugin the console's six host extensions and three more,
`clap.preset-load/2`, `clap.track-info/1` and `clap.remote-controls/2`. A CLAP plugin judged
under it is probed again with those three offered, so its verdict holds for the host it runs in.

The `jalv`, `mod-host` and `omx-clap-host` budgets are defaults, not a measurement of your board. State your own
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
OpenMixer package.

### Pinning what was qualified

```
plugin-qualify --pins pins.txt ./my-synth.clap     # a pin and a verdict per plugin, in a file plugin-hostd loads
```

`--pins <file>` writes one line per qualified plugin, the same line as plugin-hostd's `pin_set` verb with the verdict as
a last word: the SHA-256 of every file the host loads, the parameter-layout fingerprint, and `verdict=in-process`
(suitable), `isolated` (conditional) or `refused` (unsuitable). A plugin with no verdict is pinned without one. Put the
file in plugin-hostd's settings as `pin_file` and an `add` of that plugin needs no `pin_set`; a changed file is refused
with -509. The verdict is the first `--host-profile`'s. A run that took no pin leaves an existing file alone.

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
