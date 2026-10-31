# plugin-qualify

Can this audio plugin be hosted in a real-time audio engine, and at what cost? `plugin-qualify`
scans a plugin, measures it offline (latency and CPU cost per rate and quantum), runs it
under a real host (mod-host, with an AddressSanitizer build), and gives one verdict.
Licence: GPL-3.0-or-later (`LICENSE`).

## Install

plugin-qualify is published, signed, in the OpenMixer package channel, for Fedora 44 (x86_64, aarch64)
and for Debian bookworm and trixie, including Raspberry Pi OS (amd64, arm64).

Fedora:

```
sudo dnf install https://www.openmixer.org/rpm/openmixer-release.noarch.rpm
sudo dnf install plugin-qualify
```

Debian and Raspberry Pi OS:

```
curl -fsSLO https://www.openmixer.org/deb/openmixer-release.deb && sudo apt install ./openmixer-release.deb
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
plugin-qualify --all --out ./qualification   # every LV2 bundle on LV2_PATH and every CLAP on the search path, one record each
plugin-qualify --help                         # every option and its default
```

`--format json` prints the verdicts as JSON; `--out <dir>` writes the full measurement document.
`--isolate` measures each plugin in a fresh worker so a crash or hang takes only that plugin. The `Containerfile` builds an image
with lilv, mod-host and the ASan mod-host, if you do not want to install them yourself.

A named LV2 plugin is measured the same way as a CLAP one: through the probe runner, then judged from the probe
output it writes (`plugin-qualify judge` below). Exit code: `0` every plugin qualified, `1` some did not, `2`
something could not be measured.

## The measurement grid

A plugin is measured in cells, each one sample rate and one quantum (block size in frames). The verdict a host
gets reads the cell of that host's rate and quantum, so the grid has to hold it.

```
plugin-qualify --all --out ./q                          # the full grid (the default): 4 rates x 4 block sizes
plugin-qualify --all --grid-hosts --out ./q             # the hosts' grid, the fast option (also --grid hosts)
plugin-qualify --grid 48000/128,96000/1024 urn:my:fx    # exactly these cells
```

- `--grid hosts` (the fast option; `--grid-hosts` says the same): the rate and quantum of every host the run judges
  (each `--host-profile`, and the console's two tiers, `openmixer-console` and the format's isolated host), then
  quantum 512 at every `--rates` rate, so that a record stays comparable with the ones written before the grid.
  With the four shipped hosts that is seven cells: 96000/1024 (`openmixer-console`), 48000/256 (`jalv`),
  48000/128 (`mod-host`, `omx-clap-host`), and 512 at 44100, 48000, 96000 and 192000.
- `--grid full` (the default; every plugin is measured under the same conditions, so any host's verdict can be read at any cell and the figures compare): every `--rates` rate at every `--quanta` quantum, 16 cells with the defaults
  (44100, 48000, 96000, 192000 by 128, 256, 512, 1024).
- `--grid <rate>/<quantum>,...`: exactly the cells named.

The cells are taken in that order: the hosts' own cells first, in the order the hosts are named, then the
512 cells, then the rest by rate and quantum. `--cells-per-plugin-budget N` keeps the first N, so a first pass
over a large machine can measure the hosts' cells alone (`--cells-per-plugin-budget 3` with the four shipped hosts).
`--blocks N` shortens the CLAP sweep of each cell from 512 blocks to N; the LV2 pass has a fixed shape (30
lifecycles and 3 swept runs per cell) and is not shortened by it.

An LV2 plugin is measured on the same grid as a CLAP one. plugin-hostd's runner measures an LV2 plugin at one
rate per run (the highest it is given), which is why records written before the grid hold LV2 figures at 192000
only; plugin-qualify now runs it once per cell. A CLAP plugin is run once per quantum, at every rate of the grid
at that quantum. The runs of one plugin and one offer make one probe output: the grid points of every run, the
steps of every run, and the run's outcome. The record and its byte copy hold that document.

A run that ended badly leaves a grid point at each of its cells with the run's outcome in place of figures, so a
cell is never silently absent. The cost a host is judged by is read at its cell: a measured cell is compared with
the host's budget; a cell whose run failed reads `unknown` with that run's outcome (`probe.oom`, say); only a
cell the grid does not hold reads `hosting.cost.unmeasured-at-rate-and-quantum`.

### The memory bound

A sampler loading its library can take all the memory of a small machine, and the kernel then kills it, or
something else. Every run is bounded: `--memory-limit <bytes>` (`512M`, `2G`, or `off`), by default half of
the machine's RAM. The bound is the runner's data limit (`--data-bytes`, `RLIMIT_DATA` on the measuring child:
its heap and private writable mappings), and the interposer the child runs under turns an allocation refused
under that limit into an immediate exit with status 121. A run that ends that way, or by a `SIGKILL` the
runner did not send (the kernel's out-of-memory killer), is recorded as `probe.oom`: its cells carry the
outcome and `memoryLimit { bytes, mechanism }`, the plugin's record is still written, and the other cells are
judged as usual. A plugin whose every run ended `probe.oom` is `unknown` under every host, deciding `probe.oom`.
A host whose own cell ended `probe.oom` is `unknown` there as well (`memory`, `probe.oom`): the plugin did not
run within the bound at that host's rate and quantum.

Where the machine delegates the memory controller, the runner sets the bound as `memory.max` of a cgroup instead: a run the
kernel kills at it is `probe.memory-limit`, read the same way, and the document's `limits` says which it was. A process
plugin-qualify spawns itself, with no runner (`tools/lv2-measure.mjs`, `tools/benchmark.py`), runs under `RLIMIT_AS` at the
machine's RAM, off for a sanitizer build; hitting it is `memory-limit-exceeded`, with the limit.

### Memory

Each cell carries a footprint: how far the resident set of a process of its own grew, in KB, after instantiate, after
activate, at rest after processing, with notes held for an instrument, and what a second instance added. A record adds what
they come to: `firstInstanceKb`, the most one instance held with everything its instances share, and `perInstanceKb`, what
one more costs.

A host with a memory budget reads them, at every cell it runs, and the verdict follows:
`hosting.memory.within-ceiling`, `hosting.memory.above-ceiling` (`unsuitable`), or `hosting.memory.unmeasured` (`unknown`,
since a missing figure never reads as fitting). `openmixer-console` has one, sized for the desk, and the Raspberry Pi hosts
`openmixer-pi-4gb` and `openmixer-pi-8gb`, at 48000/128 and 48000/256, have one each. The Pi budgets are not measured on a Pi
yet, so a plugin under them is `conditional`, `hosting.memory.within-provisional-ceiling`: that gives the figure and the
ceiling and does not say the plugin fits. The other hosts have no budget, and read nothing.

A soak (LV2; the CLAP prober has no continuous render yet) also reads the growth: past 10 MB per minute of audio over its
second half, provisional, the rate fails as `leaks`.

### How long a run takes

The default grid is the full one, so the expected time of a run with no grid option is the `full` row: about 65 hours on a Raspberry Pi 5 for the vangelis set (1823 records). `--grid-hosts` is the fast option, about 30 hours there.

Times from one deep run on a Raspberry Pi 5 (4 cores, 4 GB), 1823 records (494 CLAP, two offers of each of 247,
and 1329 LV2), six hours in all with the grid of before (CLAP at four rates in one run at quantum 512, LV2 at
192000/512 alone):

| | runs | mean a run | total |
| --- | --- | --- | --- |
| CLAP, one run per offer (4 cells) | 494 | 2.8 s | 0.38 h |
| LV2, one run (1 cell) | 1329 | 10.5 s | 3.86 h |
| host admissions (jalv, mod-host) and the scan | | | about 1.8 h |

A CLAP plugin takes one run per quantum of the grid, an LV2 plugin one run per cell; the admissions do not
grow with the grid. On that machine, then, about:

| grid | CLAP runs a plugin | LV2 runs a plugin | expected |
| --- | --- | --- | --- |
| hosts (7 cells) | 4 | 7 | 1.5 h + 27 h + 1.8 h, about 30 h |
| full (16 cells) | 4 | 16 | 1.5 h + 62 h + 1.8 h, about 65 h |
| hosts, `--cells-per-plugin-budget 3` | 3 | 3 | 1.1 h + 11.6 h + 1.8 h, about 15 h |

These are ceilings: the LV2 time a run was taken at 192000, the dearest rate. `--blocks 128` takes a quarter of
the CLAP sweep a cell. A first pass with `--cells-per-plugin-budget 3`, then `--grid full` over the plugins worth
it, keeps a small machine's night bounded.

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

The files a pin holds are plugin-hostd's: the sync writes each pin with the files `plugin-hostd --pin-files <uri>`
prints for the device's LV2 directories (plugin-hostd 0.15.0 or later; `PLUGIN_HOSTD` names the daemon when it is not
on `PATH`), the list an add checks, and hashes exactly those. When plugin-hostd cannot name them, or is older, the
plugin gets no pin, the log says why, and the daemon pins it on its first add (`pin_mode first-use`).

`--all` walks the standard CLAP search path through the same scanner: each directory `CLAP_PATH`
names (colon-separated), then `~/.clap`, then `/usr/lib/clap`, which is the system directory on every
distribution and architecture. A plugin id found twice keeps its first place on that path. LV2 plugins
are measured by `tools/lv2-measure.mjs` (below); this entry point does not drive that pass yet, so
`--all` refuses with exit 2 when any `.lv2` bundle is on the LV2 path (`LV2_PATH`, else `~/.lv2` and the
system lv2 directories) rather than qualify only the CLAP side. A directory on the CLAP path that cannot
be read (permissions, a symlink loop) also refuses with exit 2, naming it.

The prober runs each plugin headless at every cell of the grid (see "The measurement grid"), under an interposer that counts the
allocations, locks and syscalls its `process()` makes while every parameter is swept, and prints
the file's SHA-256 beside what it measured. The verdict is the real-time-safety one: **suitable**
only on a clean count, **conditional** (isolated in the pin: it runs in a worker of its own, never refused) on any
allocation, lock, syscall or main-thread host call from `process()`, **unsuitable** on `CLAP_PROCESS_ERROR`, **unknown** when it could not be counted. An instrument is
quiet until it is played, so a plugin with a note input is also played, at every rate and under a
count of its own: a chord, the pitch bent and a controller moved, pressure, the chord let go, a
burst of 32 note ons in one block and their offs, all notes off, in the dialect its note input
reads (CLAP's, else MIDI's). An allocation, lock or syscall while it plays is **conditional**, isolated in the pin like the same
violation in the run (`hosting.rt-safety.violations-under-notes`); an instrument that could not be played under the
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

The verdict is the same one `plugin-qualify` gives CLAP plugins, the real-time-safety one, now for LV2 as
well; cost is reported beside it, not folded into it. Cost is read at the profile's rate AND quantum: a pair the
document does not hold reads `hosting.cost.unmeasured-at-rate-and-quantum`, and two quanta of one plugin that cost
differently give two different cost reasons. Only a measurement of the old format, which keeps one figure per
rate, is read per rate. A run that did not end `probe.ok` is `unknown`, with the run's outcome code as the reason.

An instrument costs nothing until a voice plays, so its cost is taken with notes held down, at velocity 127,
spread across the keyboard, while every parameter is swept: as many notes as the voice capacity the plugin
declares (CLAP `voice-info`, basis `declared`), or, when it declares none, the count `--probe-notes` gives
(basis `probe`; LV2 declares none). Each rate's figure says how many notes it held and why (`voices: { held,
basis, capacity }`). An instrument with no count to hold is not timed (`voices-unknown`).

An LV2 plugin's record holds the same two figures, under the same field names, in `measurements.grid[]`:
`latency { declaredFrames, measuredFrames }` and `cost`. `lv2_measure` takes them at the run's rate and block, the
way the CLAP prober does: the declared figure is what the plugin reports on its latency port
(`lv2:designation lv2:latency`, or the older `lv2:reportsLatency`; 0 when it has none), the measured one is where an
impulse at frame 0 lands (the first frame at or above 1e-3 of the response's own peak), or, for an instrument, where a
struck A4 sounds. A plugin that has no latency port is measured, never read as 0. An instrument's cost holds
`OMX_PROBE_NOTES` keys down (the LV2 counterpart of `--probe-notes`). A figure the run could not take (a response that
stays silent, an instrument with no count to hold) is left out of the grid point and named in
`measurements.unmeasured` with its hosting code (`hosting.latency.unmeasured`,
`hosting.cost.unmeasured-at-rate-and-quantum`).

Every cell of a record carries `latency`: the two figures when the run took them, else
`{ unmeasuredReason, code }`, the contract's word for why and the hosting code a reader classifies by. A latency
step that did not end well gives the child's reason (`silent-output`, say); a cell whose run failed, its outcome's
word (`probe-crashed`, or `probe-error` for `probe.oom`); a run that took no latency at all (a runner or a child
older than the latency arm), `not-attempted`. The declared figure alone, for a plugin whose response could not be
measured, is not in the probe output: plugin-hostd's runner writes a cell's latency only with both figures.


The prober also scans: `OMX_CLAP_SCAN=native/build/clap-qualify` makes it the scanner, and its scan
keeps what a console needs to draw a third-party plugin's controls: an enum parameter's labels (as
the plugin's `value_to_text` renders them), each parameter's module, and the plugin's
remote-control pages.

## Adjusting a verdict by what the plugin did on this machine

```
plugin-qualify adjust --history ~/.local/state/plugin-hostd/history --qualification-dir ./qualification --host-profile omx-clap-host
plugin-qualify adjust --history history --qualification-dir ./qualification --host-class aarch64/4/2400 --pins pins.txt
```

plugin-hostd keeps a running history of every plugin binary on every host class it ran on (windows run alone and in a
group, CPU, xrun windows, crashes, restarts, quarantines). `adjust` reads that file directly, so it runs without a daemon,
and writes a second verdict beside the measured one in each qualification record: a `history` block per host class of the
file, holding the line it looked for (the plugin's plugin-hostd uri and the digest of the first file of its pin), whether
the history has it, the windows it counts, and for each `--host-profile` the measured pin verdict, the adjusted one, the
move (`demote`, `promote` or `none`) and a reason code. The measured `verdicts` and the measurement are never changed: the
same plugin on another host class has another history and another adjusted verdict.

| move | when | reason |
|---|---|---|
| `in-process` to `isolated` | a crash was counted within 30 days, on this host class | `history.crashed` |
| `in-process` to `isolated` | from 30 grouped windows, the share of xrun windows grouped exceeds the share alone by 5 points | `history.xruns-grouped` |
| `isolated` to `refused` | three or more solo crashes, the latest within 30 days | `history.crashed-alone` |
| `isolated` to `in-process` | every reason against the plugin is a `hosting.cost.*` one, 360 windows run alone (six hours), no crash or restart ever counted, no xruns raised when grouped, `cpu_p95_solo` under the host profile's ceiling | `history.steady` |
| none | no line for this binary on this class | `history.no-record` |
| none | a line, and no rule moves the verdict | `history.no-change` |
| none | the line would promote, but the verdict is a fact about the plugin: a real-time-safety, feature, stability, latency or topology reason, an `unknown`, or a `refused` | `history.not-liftable`, with `blockedBy` |

History never lifts a real-time-safety, feature or unknown verdict, and never promotes a refused one; a demotion is one
step. The thresholds are one table, `HISTORY_POLICY` in `src/history-adjust.ts`. `--pins <file>` writes the pins with the
adjusted verdict of the first `--host-profile` instead of the measured one; it needs exactly one host class, so name one
with `--host-class` when the history holds several. `--now <seconds>` fixes the time the history is read at. A line of the
history outside its grammar is not read and is named on stderr; a history of a version this tool does not know is refused.

## LV2 plugins: the hosting measurement

`tools/lv2-measure.mjs` measures the hosting dimensions (`stability`, `rtSafety`, `features`) through
the LV2 measurer the package installs, `lv2_measure`: each plugin is loaded through lilv in its own
process, instantiated and destroyed 30 times, and run under the interposer while every control is
swept. `tools/lv2-measure.mjs` measures at the highest `--rates` rate; `plugin-qualify` runs the measurer
once per cell of its grid (see "The measurement grid"):

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
| `--features LIST` | the kinds offered: `map`, `unmap`, `options`, `bounded`, `worker`, `default-state`, `log`, `rtmempool` (empty: none) | all but `default-state` |
| `--strict` / `--no-strict` | refuse a plugin requiring a feature not offered (the record's `refusedFeature` names it), or hand it to its own instantiate without it | `--no-strict` |
| `--block-declares LIST` | the buf-size declarations made when `bounded` is offered: `bounded`, `fixed`, `pow2` (empty: none) | `bounded` |
| `--block-min N` | `bufsz:minBlockLength`; 0 is the run's block | 1 |
| `--block-max N` | `bufsz:maxBlockLength`; 0 is the run's block | 0 |
| `--block-nominal N` | `bufsz:nominalBlockLength`; 0 is the maximum | 0 |
| `--log MODE` | `log:log` lines: `silent`, `route` (to stderr) or `capture` (into the record's `featureOptions.log.lines`) | `silent` |
| `--log-capture-bytes N` | the capture buffer, its NUL included | 4096 |

The defaults are the measurement as it has always been, so a verdict reached under them does not
move. `lv2_measure --help` lists the same flags.

## Scanned descriptors

Both scanners also write what each plugin states about itself as a scanned descriptor: one JSON file per
plugin in omx-contract's descriptor words (identity, controls, ports, what it needs from a host, whether it
reports latency), held to omx-contract's descriptor schema before it is written. A descriptor holds no
measurement and no verdict; those are the qualification record's.

The files go into the descriptor directory, the key `descriptor_dir`:

| | where |
| --- | --- |
| named | `--descriptor-dir <dir>` |
| a user (the default) | `$XDG_STATE_HOME/omx/descriptors`, else `~/.local/state/omx/descriptors` |
| a system service | `/var/lib/omx/descriptors` (`--system`) |

Each file is named `<id>@<version>-<sha256 first 12>.json`: the CLAP id or the LV2 URI, the version the
plugin states (`unversioned` when it states none) and the SHA-256 of its binary (the `.clap`, or the LV2
bundle's `lv2:binary`), with every character other than letters, digits, `.`, `_` and `-` written `_`. The hash
keys which file describes which binary: a changed binary is a new file, and the old one stays as history.

```
tools/scan.py --out catalog.json                                     # LV2: the catalog, and the descriptors beside it
tools/scan.py --descriptor-dir ./descriptors urn:my:plugin           # one plugin, into a directory of your own
native/build/clap-qualify --json ./my-fx.clap | tools/descriptors.py clap --descriptor-dir ./descriptors
```

`scan.py --no-descriptors` writes the catalog only. A descriptor the schema refuses is not written and is
reported as `contract.file.invalid`, omx-contract's code; a plugin whose binary cannot be read is
`qualify.descriptor.binary-unhashed`; a directory that cannot be written is `qualify.descriptor.dir-unwritable`;
no schema found is `qualify.descriptor.schema-missing`. Any of them makes the run exit `2`, and the other
plugins are still written. The schema is the omx-contract package plugin-qualify depends on, else
`/usr/share/omx-contract/omx-contract.schema.json`; `OMX_CONTRACT_SCHEMA` names another one, for a test. The
writer needs Python's `jsonschema` (`python3-jsonschema`).

## What the verdicts mean

- **suitable**: every dimension was measured and passed. Safe to run inside the engine's own
  process. This is the only verdict that counts as qualified.
- **conditional**: it works, with a caution (for example a high cost at small quanta, or an
  allocation, lock or syscall in `run()`). It is run isolated, and the deciding reason names the caution.
- **unknown**: something was not measured. An unmeasured plugin is never a pass.
- **unsuitable**: a measured failure: a crash, a memory error in the plugin's own binary, or a
  required feature the host does not provide. An allocation, lock or syscall in `run()` is not
  one: that plugin is **conditional**, and runs isolated.

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

| profile | isolation | verdict | instruments | LV2 features read from | cost budget (P95 of a core, rate / quantum) |
|---|---|---|---|---|---|
| `openmixer-console` (default) | in-process (the console's RT thread) | judged from a declaration | no | the console's in-process table | 0.05 at 96000 / 1024 |
| `jalv` | per-process | **measured by a run** (`jalv -n <name> <uri>`, headless) | yes | jalv 1.6.8 `src/jalv.c` (zynthian's fork passes the same list) | 0.25 at 48000 / 256 |
| `mod-host` | shared-process | **measured by a run** (`add`, `activate`, `remove` on mod-host's socket) | yes | mod-host f14a230 `src/effects.c` | 0.05 at 48000 / 128 |
| `omx-clap-host` | shared-process | judged from a declaration | yes | the console's in-process table (the same LV2 feature provider) | 0.05 at 48000 / 128 |

**Measured or declared.** A *declared* verdict is what the profile's feature list and cost budget make of
the one probe output. A *measured* verdict (`jalv`, `mod-host`, LV2 plugins) also runs the plugin under that
host, one admission per plugin, and its record entry carries `arm: "run"` and `measured: true`. A refusal
(`resp -102`), a crash (the signal), a host that dies on `add`, or a port type the host does not know makes the
plugin `unsuitable` for that host, with the code as the deciding reason (`mod-host.resp-102`,
`mod-host.signal-SIGABRT`, `mod-host.died-on-add`, `jalv.unknown-port-type`, `jalv.signal-SIGABRT`). A host
that is not installed leaves the verdict unmeasured (`unknown`, deciding `<host>.not-installed`). After any
death on mod-host the next admission starts a fresh host. `plugin-qualify judge` reads a probe output
that holds no run, so its `jalv` and `mod-host` entries stay `arm: "declaration"`.

**The console's two tiers.** Every record carries `tiers`: the *in-process* verdict (`openmixer-console`) and the
*isolated* verdict (`omx-clap-host`, an LV2 plugin through plugin-hostd's LV2 adapter), `offeredOn` (`in-process` when its
verdict qualified, `isolated` when its verdict qualified or is `conditional`) and, when neither, `dimmed` with the reason. A
`conditional` plugin, RT-unsafe for instance, is offered on the isolated tier with `runsAlone: true`: it runs in a worker of
its own, never grouped, and its pin says `isolated`. An LV2 plugin is run once under the adapter, and
that run decides its `omx-clap-host` verdict as a mod-host run decides mod-host's. A plugin that kills the isolated
host and qualifies in-process is offered in-process only. The tiers are judged for every plugin whether or not
`--host-profile` names them; mod-host and jalv are run only when `--host-profile` asks for them.

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

`--out <dir>` writes one interchange document per run (`lv2-plugin-measurements`, format 1.6,
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

### Qualifying every plugin on a machine

`plugin-qualify-sync` qualifies every plugin installed on the machine, and again each one whose files
change. With its pin file in plugin-hostd's settings, the daemon runs in its default mode (`require_pins 1`)
and chains any plugin that qualified, the image's own and any installed later:

```
pin_file /var/lib/omx/qualified.pins          # in plugin-hostd.conf
```

The package ships it as a service that runs two minutes after boot and whenever a plugin directory
changes, once the directory has been quiet for a minute. A run finds every `.clap` under the CLAP
directories and every plugin of every bundle under the LV2 ones, and hashes each one's files as
plugin-hostd does for a pin. A plugin whose files hash as recorded is skipped. A new or changed one gets the
quick qualification through the probe runner, on the grid `grid` names (see "The measurement grid"): its pin, the RT-safety sweep, cost and latency, its
qualification record and its descriptor. The soak is not part of it, and every record it writes says so in
`notMeasured` (`hosting.stability.unsoaked`).

Each run of the runner (one cell of an LV2 plugin, one quantum of a CLAP one) has `budget_s` seconds, under `memory_limit`. One that crashes or hangs is recorded as `crashed` or `hung`, one that
fails the sweep is pinned `verdict=refused`, and the run goes on to the next. The pin file and the state are
written whole after every plugin, so a run cut short keeps what it finished. The last line counts the run:

```
qualified 2, skipped 0, refused 0, crashed 1, hung 1, unmeasured 0, distributed 0, 4.6 s
```

A plugin that is no longer found, or whose bytes changed, leaves nothing behind: its pin, its qualification
record (with the probe output copied beside it) and its descriptor are removed. Records the sync did not write
stay, and nothing is removed in a run that could not read a bundle, so a half-written install is no uninstall.
A run looks only where its settings point: a plugin outside every directory of its format that the run scans is
kept as it is (a run scoped to LV2 keeps every CLAP pin), and only one missing from a directory it scans is gone.
A running plugin-hostd is told with `pin_clear`.

When plugin-hostd answers on `hostd_port`, the changed pins are also sent to it with `pin_set` and apply at
once. plugin-hostd serves one controller at a time, so while one is connected the run says so and the pins
apply at the daemon's next start.

The settings are `/etc/omx/qualify.conf`, one `key value` per line, and each is also a flag
(`--budget-s 30`):

| key | default |
| --- | --- |
| `lv2_path` | `$LV2_PATH`, else plugin-hostd's: `/usr/lib64/lv2:/usr/lib/lv2:/usr/local/lib/lv2` |
| `lv2_extra` | `/zynthian/zynthian-plugins/lv2:/zynthian/zynthian-my-data/plugins/lv2` |
| `clap_path`, `clap_extra` | `$CLAP_PATH`, then `~/.clap`, then `/usr/lib/clap`; none |
| `pin_file` | `/var/lib/omx/qualified.pins` |
| `qualification_dir`, `descriptor_dir` | `/var/lib/omx/qualification`, `/var/lib/omx/descriptors` |
| `state_file` | `/var/lib/omx/qualify-sync.json` |
| `budget_s` | `60` |
| `host_profile` | `omx-clap-host` |
| `grid` | `full`: every rate at every block size, 16 cells (`hosts`, or `--grid-hosts`: the cells of `host_profile` and of the console's two tiers, then 512 at every rate; or `<rate>/<quantum>,...`) |
| `cells_per_plugin_budget` | `0`, every cell of the grid |
| `memory_limit` | half of the machine's RAM (`off` for none) |
| `memory_notes` | `16`: the notes an instrument with no declared capacity holds in a `--memory-only` run |
| `hostd_port`, `hostd_feedback_port` | `5555`, the next port |
| `host_class` | the board's own, from the device tree (`rpi5`); none elsewhere |
| `distributed_dir` | `/usr/share/omx/qualification` |

Those are the service's (`--system`); run by a user, the files go under `$XDG_STATE_HOME/omx`. An LV2
directory added here belongs in plugin-hostd's `lv2_path` too, or the daemon cannot find the bundle it
pinned. `--force` qualifies everything again, and `--no-distributed` reads no distributed record. A second `plugin-qualify-sync` waits for the run in progress (a lock on `<state_file>.lock`); `--no-wait` exits 0 at once and leaves a marker, and the holder runs once more at its end over what changed meanwhile.

Every run starts by bringing each pin's files up to the ones `plugin-hostd --pin-files` names, measuring nothing: a pin
written before 0.17.3 lacks the preset files an LV2's manifest names, which plugin-hostd 0.15.0 also checks, and its add
answers -509 until then. The new list replaces the old one when no file both lists hold changed its hash, so the verdict
stands; a changed file is measured again by the run. `--refresh-pins` does only that, writes the pin file and sends the
changed pins to a running plugin-hostd; the package's upgrade runs it (plugin-qualify#239).

The path unit names the standard folders (`/usr/lib/lv2`, `/usr/lib64/lv2`, `/usr/local/lib/lv2`,
`/usr/lib/clap`, `/usr/lib64/clap`). The folders the settings file adds (`lv2_path`, `lv2_extra`, `clap_path`,
`clap_extra`) are written into a drop-in of the unit by a systemd generator at boot and at every
`systemctl daemon-reload`, so the file is the one place a machine's extra folders are written.

The path unit watches a folder, not the bundles inside it: a new bundle appearing in a watched folder is
seen at once, but a package's own files being replaced in place (an upgrade) is not a change of the folder
itself. A packaged plugin is still caught at once, by the distribution's install triggers over the standard
folders. An unpackaged bundle replaced in place in an extra folder is caught at the next run of
plugin-qualify-sync.timer, at most about 15 minutes after the change.

### Keeping the records through an upgrade

An upgrade of plugin-qualify, of the plugins' libraries or of the judge's rules does not call for measuring every plugin
again. The figures in the records are carried across and judged again:

```bash
plugin-qualify-sync --system --rejudge
```

`--rejudge` measures nothing and needs no measuring tool. It reads every record in `qualification_dir` with the probe
output it names, and passes them through the same judge a measurement goes through, under the rules of the running
version: a real-time violation under `run()` or under notes is `conditional` and pinned `isolated`, each host's budget is
read, and a plugin with no footprint is `unknown` on a host with a memory budget, never read as fitting. It also judges
each record for `omx-clap-host`, `openmixer-console` and the Pi boards `openmixer-pi-4gb` and `openmixer-pi-8gb`. The
verdicts, the tiers and the plugin's pin word are replaced; the figures, the probe output and who took them stay as they
were. The record gains a `rejudged` block with `at`, `by` (the version that judged) and `figures` (`tool`, `measuredAt`
and `runId`, as measured). A run that finds nothing to change writes nothing.

A verdict never says more than the figures do. An LV2 plugin's `omx-clap-host` verdict is decided by its run under the LV2
adapter (the record's `adapter` block). A record with no measured adapter run reads `unknown`
(`qualify.sync.adapter-run-owed`), is not offered on the isolated tier, and its pin has no verdict word: plugin-hostd loads
such a plugin without grouping it. The same goes for a `mod-host` or `jalv` verdict with no run under that host. A record
whose plugin's bytes changed, or whose probe output is not the copy it names, is left as it is. Everything left owing
is listed under `owes` in the record and in `qualify-owed.json` beside the state file (`--rejudge` prints each line too),
with the measurement it needs:

| `measurement` | code | what pays it |
|---|---|---|
| `adapter-run` | `qualify.sync.adapter-run-owed` | `--adapter-only`, then `--rejudge` |
| `host-run` | `qualify.sync.host-run-owed` | a run under that host; today, qualifying the plugin again with `--host-profile` |
| `qualification` | `qualify.sync.bytes-changed`, `qualify.sync.figures-unreadable`, `qualify.sync.no-figures` | qualifying the plugin again; the next run does so for changed bytes |

A probe that crashed took no figures: its record stays `unknown` with `probe.crashed`, no pin word and the state's
outcome `crashed`. A crash under a host's run stays `unsuitable` and `refused`.

Footprints older records lack are taken apart from everything else:

```bash
plugin-qualify-sync --system --memory-only   # the footprints, at the cells a Pi runs
plugin-qualify-sync --system --rejudge       # the verdicts that read them
```

`--memory-only` takes the footprint of each plugin the state holds (after instantiate, after activate, at rest, a second
instance, and notes held for an instrument) at 48 kHz in blocks of 128 and 256 frames, and nothing else: no sweep, no
cost, no latency, no lifecycle, no soak. It goes through the probe runner under the limits of an ordinary run (`budget_s`,
`memory_limit`), each plugin in processes of its own, an LV2 plugin in a world of its own bundle. An instrument that
declares its voice capacity holds that many notes; one that does not holds `memory_notes`, with basis `probe`. Only the
`memory` of those cells changes in the record, a cell it lacked joins with no other figure, and a `memoryRun` block says
which runner took them and when. A cell whose run failed holds a reason and no figure. A plugin whose footprints are
already merged is skipped, so a pass cut short can be run again; `--force` takes them again. The pass judges nothing:
`--rejudge` afterwards does.

The adapter runs a record owes are taken apart as well:

```bash
plugin-qualify-sync --system --adapter-only  # the runs, at the cells a Pi runs
plugin-qualify-sync --system --rejudge       # the verdicts they decide
```

`--isolated-only` runs the isolated step a record still owes: a plugin rated conditional, or one that crashed or hung in
the probe, added alone under a plugin-hostd of its own on a private JACK server, with a sine through it for 3 seconds. The
record's `run` keeps its id and gains the step, and the pin follows it; nothing else is measured. A step the machine could
not run stays owed.

`--adapter-only` starts each LV2 plugin the state holds under a fresh omx-clap-host, `add` then `remove` through the LV2
adapter, once per cell: 48 kHz in blocks of 128 and 256 frames. Each cell has a private JACK server (`jackd -d dummy`, so
`jackd` must be installed), so the device's live server is never touched. A command has `budget_s` seconds, the host's
address space is limited as a direct spawn's is, and it is killed with whatever it started. Only the record's `adapter`
block changes: `versions` (omx-clap-host and plugin-hostd, read from `--version`), `measuredAt`, `cells`, and at its top
what the judge reads. A crash or a command that gets no answer in time is the plugin's recorded outcome, at the cell it
happened, and reads `unsuitable` at the next `--rejudge`. A host that could not be run decides nothing: the block says
`measured: false`, and the run stays owed and is tried again. The pass refuses to start, writing nothing, when a host does
not say its version or there is no `jackd`. A plugin whose block was taken at these host versions is skipped, so a pass
cut short can be run again; a host upgrade or `--force` takes them again. A plugin whose probe failed is skipped: it has
no verdict a run could decide.

**A leak is not measured.** Growth over time takes a soak, which this pass does not run: every record it writes names
`memoryGrowth` under `notMeasured`, and the last line says `leaks not measured`.

On a Raspberry Pi 5 a plugin takes under 0.6 s at the median, 5 s at the 90th percentile and 22 s at the 99th; about an
hour at most for the 1,542 plugins of the Zynthian set. Those are upper bounds: twice the time the 2026-10-28 records say a
whole pass at one cell took, which also ran 30 lifecycles, the sweep, the latency and the cost. A plugin that hangs
takes `budget_s` a cell. The test fixtures take 0.1 s each, both cells, on an x86-64 desktop.

### Distributed records

A device that ships with a known plugin set need not measure it again at first start. The qualification records
another device of the same machine class wrote for that set are installed read-only, and the sync takes from them
every plugin whose files are the bytes that were measured:

```
/usr/share/omx/qualification/<host class>/<set>/          # system (--system)
$XDG_DATA_HOME/omx/qualification/<host class>/<set>/      # a user run, then each $XDG_DATA_DIRS/omx/qualification
```

Each `<set>` directory holds the records (`*.qualification.json`, each with its probe output `*.probe.json`) and a
`provenance.json` that says where they come from: the set, the host class, the image, the package versions of the
measuring device, the date and the package that installed them. The host class is a directory name: `host_class`
in the settings, or, when it is unset, the board's own name read from the device tree (`rpi5` on a Raspberry Pi 5,
`rpi4` on a Raspberry Pi 4). Where neither gives one, the layer is not read and the run says so.

Before a plugin is measured, the sync looks for a distributed record of it: a CLAP record whose binary is the same
`.clap` path, or an LV2 record of the same plugin uri. The name only finds the record; a record applies when, and
only when:

- every file of its `binary.files` is installed at that path relative to the plugin's root, with that SHA-256,
  computed on the device;
- its schema is the one this version writes and its probe output is one this version's reader accepts, the copy
  intact (its SHA-256 the one the record names): the same acceptance the sync gives a record of its own, which it
  never measures again for a newer tool;
- it holds a verdict for the sync's `host_profile`, and that verdict ended `qualified`, `refused`, `crashed` or
  `hung`. One that could not be measured at the source (`unmeasured`) is measured here.

A plugin whose distributed records apply is not measured: the records are copied into `qualification_dir` with the
set's `provenance` object added, its pin is taken from the probe output the record judged, its descriptor is
written, and the run says

```
distributed: http://distrho.sf.net/plugins/3BandEQ: applied (zynthian-vangelis)
```

A plugin with a distributed record whose files differ is measured as before, and the run says
`distributed: <uri>: binary differs`; one with no distributed record is measured without a word. The summary counts
the plugins taken from the layer, `distributed N`, apart from the ones measured and skipped. A later run treats an
applied plugin like one it measured: skipped while its files are unchanged, measured when they change. `--force`
measures everything and reads no distributed record; `--no-distributed` keeps the layer out of a run.

The package that installs a set is built from a device's `qualification_dir` by `plugin-qualify-records-package`:

```
plugin-qualify-records-package /var/lib/omx/qualification --host-class rpi5 --set zynthian-vangelis \
  --provenance provenance.json --out .
```

It writes `omx-qualification-<host class>-<set>_<version>_all.deb`, the version the build date
(`2026.10.29`) unless `--version` names one. The package installs the records under
`/usr/share/omx/qualification/<host class>/<set>/` with `provenance.json`, depends on the plugin-qualify that reads
the layer, and is `Architecture: all`. `--provenance` names a JSON file (or holds the JSON itself) with what the tool
cannot know: the image, the package versions and the source revisions of the device. The tool adds the set, the host
class, the package and the date. A record whose probe output is missing or does not match its SHA-256 is left out
and named; a record of a plugin that could not be measured (`*.unmeasured.json`) is left out, since it never
applies. The tool builds the Debian package only; an RPM of a set is not built yet.

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
