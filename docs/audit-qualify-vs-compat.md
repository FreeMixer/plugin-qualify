<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com> -->
# Audit: plugin-qualify against omx-clap-core's compatibility tests

Status: report for #124, 2026-10-20. No product change.

The question: plugin-qualify (can this plugin run in the real-time engine, and at what cost; a verdict) and
omx-clap-core's compatibility tests (`tests/lv2_parity.py`, `tests/jack_parity.c`, `tests/clap_coverage.py`,
`docs/*-compatibility.md`) look like they overlap. Should they merge, share a library, or stay as they are?

Short answer: **leave them as two products, and share through the three packages that already exist**
(omx-contract for the vocabulary, omx-clap-core's `omx-clap-scan` for the CLAP scan, plugin-hostd's
`plugin-hostd-probe` for running a plugin under limits). No new library earns its keep today. The one real
cross-repo duplicate is clap-qualify's CLAP scan mode, a near copy of `omx-clap-scan`. The larger duplication is
*inside* omx-clap-core's tests: two copies of the private-PipeWire runner, the host driver and the TSV helpers.

## How the numbers were taken

Every number below comes from one command:

```
tools/audit-overlap.sh <omx-clap-core checkout> <plugin-hostd checkout>
tools/audit-overlap.sh --self-test
```

The script finds each unit by its function name, never by a line number. A C or TypeScript function runs to the
first column-0 `}`, a Python `def` or `class` to the next column-0 statement. It prints `unit`, `pair` and `count`
lines; the script's header defines each field. For a pair:

- **shared / a / b / overlap**: normalised lines (comments, blank lines and lone braces dropped) the two bodies
  have in common, out of each side's count; overlap is shared over the smaller side.
- **diff**: lines `diff` adds or removes between the normalised bodies (same language only).
- **strings**: distinct string literals both spell, out of each side's. Messages, field names and codes survive
  a change of brace style or of language, so a port of the same code shows up here when its lines do not.

The audited trees: omx-clap-core `9d65e7d`, plugin-hostd `03d6d27`, plugin-qualify at this pull request.
omx-clap-core #266 (jalv as a third parity host) and #267 (an LV2-adapter code comparison) were still open and do
not change this inventory's shape. #266 adds a host to `lv2_parity.py`'s `Host` loop; it adds no runner.

## 1. Inventory

Line ranges are the script's `unit` lines (`file:first-last`, lines). `q` is plugin-qualify, `c` is
omx-clap-core, `h` is plugin-hostd.

### Plugin enumeration

| Unit | Where | Lines | What it does |
|---|---|---|---|
| q.scan-mode | `native/clap-qualify.c` `put_labels`…`scan` (1076–1375) | 281 | `clap-qualify --json`: walks `.clap` files, forks one child per file under `alarm(30)`, `dlopen`s, lists the factory's descriptors, writes the scan document with enum labels and remote-control pages |
| c (scanner) | `src/scan.c` `has_suffix walk main` 880–1085; `scan_file` 807–867; `put_file put_plugin put_descriptor put_params put_audio_ports` | 142 + 61 + 247 | `omx-clap-scan --json`: the same walk, the same fork plus `alarm(SCAN_TIMEOUT_S=30)`, through the host library's admission rules (`omx_clap_host_configure`) |
| q.clap-path | `src/clap-loader.ts` `clapSearchPath` 434–437 | 4 | `CLAP_PATH`, `~/.clap`, `/usr/lib/clap` (or `OMX_CLAP_SYSTEM_DIR`) |
| c.clap-path | `src/scan.c` `default_paths` 925–946 | 22 | `CLAP_PATH`, `~/.clap`, `/usr/lib64/clap`, `/usr/lib/clap` |
| q.lv2-manifest | `src/lv2-loader.ts` `pluginsInManifest lv2BundlesOnPath` | 30 | regex over `manifest.ttl` for `a lv2:Plugin` and `lv2:binary`; bundles on `LV2_PATH` |
| c.lv2-manifest | `src/lv2_locate.c` `lv2_locate_manifest_names walk_dir lv2_locate` | 119 | a Turtle prefix-aware token scanner: is this URI in this manifest (for `add lv2:<uri>`) |
| q.lv2-lilv | `tools/scan.py` `Scanner` 130–338 | 209 | lilv world, every plugin, its ports, features and controls, for the catalogue |
| c.lv2-lilv | `tests/lv2_parity.py` `lilv_facts` 361–416 | 56 | lilv world, the port layout facts the parity runner needs to plan a feed |

plugin-qualify's TypeScript loader already calls omx-clap-core's scanner: `src/clap-loader.ts` names
`omx-clap-scan` as the default scanner (`count q.calls-omx-clap-scan` = 14 lines in `src/`), and accepts
`clap-qualify` in its place (`SCANNER_NAMES`, line 35). `omx-clap-scan` writes no enum labels and no
remote-control pages (`count c.scan-labels-pages` = 0); that is the only reason qualify's copy is still used.

### Deterministic input

| Unit | Where | Generator |
|---|---|---|
| q, CLAP sweep and cost | `native/clap-qualify.c` 493–515, 755–778 (inside `measure_rate`, `cost_rate`) | LCG `x·1664525+1013904223`, seeds `0x6f6d78`, `0x636f73`; sample `((x>>8)/2^24 − 0.5)·0.5` |
| q.noise-lv2 | `native/lv2-measure.c` `fill_input` 766–778 (13) | LCG `x·1103515245+12345`, seed `12345`, amplitude 0.1; or a 1 kHz sine at 0.1 (`OMX_STIM`) |
| q, Python | `tools/benchmark.py` `render`, `cost_one` | numpy: unit impulse at frame 0, sine pre-roll and cost tone |
| q, impulse | `native/clap-qualify.c` 443–459 | unit impulse at frame 0, onset at a fraction of peak |
| q.notes | `native/clap-qualify.c` `note_event note_midi note_key note_block note_dialect` (77) | CLAP note or MIDI events, A4 = key 69, n voices spread over 88 keys |
| q.notes-py | `tools/benchmark.py` `held_keys midi_sequence` (22) | LV2 atom MIDI, held keys |
| c.signal | `tests/jack_parity.c` `noise signal_at` (18) | LCG `x·1664525+1013904223`, seeds `{12345, 54321}` per channel, amplitude 0.15; plus `0.2·sin(2π·441·(c+1.5)·t)`, `+0.5` impulse each second, silent last 40 % |
| c.notes | `tests/jack_parity.c` `midi_events` (38) | keys `{60,64,67,72,48,55,62,69}`, one every 250 ms, held 200 ms, velocity 100 |

The Numerical Recipes constants appear twice in each repository (`count q.lcg-nr` = 2, `c.lcg-nr` = 2).
qualify's LV2 measurer uses the other (glibc) constants (`q.lcg-glibc` = 1). Seeds, scale and mix differ
everywhere.

### Feeder and isolated PipeWire

plugin-qualify has none. The 7 lines that `count q.pipewire` matches in `src native tools bin` are a crash
attribution rule (`pipewire-jack-close-double-free`) and comments saying it runs without PipeWire. omx-clap-core
has `unshare` 15 times in `tests/` (`count c.unshare`):

| Unit | Where | Lines |
|---|---|---|
| c.ns-parity | `tests/lv2_parity.py` `inside_run cmd_run`: re-exec under `unshare --user --map-root-user --net --pid --fork --mount-proc`, tmpfs over the runtime dir, refuse if a desktop socket is visible | 78 |
| c.pw-parity | `tests/lv2_parity.py` `start_pipewire`: fixed rate and quantum, `factory.dummy-driver = false`, `factory.freewheel-driver = false` | 19 |
| c.clock | `tests/jack_parity.c` `clock_*`: a `pw_filter` driver (`PW_KEY_PRIORITY_DRIVER` 1000000), one graph cycle per `pw_filter_trigger_process`, paced or back to back | 86 |
| c.ns-coverage | `tests/clap_coverage.py` `inside_host cmd_host`: the same re-exec | 39 |
| c.pw-coverage | `tests/clap_coverage.py` `start_pipewire`: private PipeWire with a null sink | 19 |
| (shell) | `tests/clap_lv2_identity.sh`, `tests/jack_*_e2e.sh`: the same `unshare` line, PipeWire's own driver | — |

### Host launch, teardown, crash and hang

| Unit | Where | Lines | What |
|---|---|---|---|
| q.probe-runner | `src/probe-runner.ts` `runOne probeTarget` | 49 | `plugin-hostd-probe run …`; no timer of its own; exit 0/1 document, 2 none, 3 no such plugin |
| h.run-child | `src/probe.c` `apply_limits kill_tree run_child child_end` | 203 | fork, `setpgid`, `PR_SET_PDEATHSIG`, `PR_SET_NO_NEW_PRIVS`, `RLIMIT_CPU/DATA/NOFILE/FSIZE/CORE/RTPRIO`, wall deadline, SIGTERM then SIGKILL to the tree, signal to outcome code. One attempt, no retry |
| q.bench-worker | `tools/benchmark.py` `WorkerQueue _Worker` | 112 | per-plugin worker processes with a timeout |
| q, LV2 | `src/measurement/cli.ts` 235–274 | — | spawns `lv2_measure` with the interposer preloaded; crash `128+signal`, timeout `124` |
| c.host-parity | `tests/lv2_parity.py` `Host run_plugin` | 87 | `mod-host` or `omx-clap-host -n -p <port>`, own session, socket protocol, `killpg(SIGKILL)`; a stuck pass is rerun per host alone to attribute it |
| c.host-coverage | `tests/clap_coverage.py` `Host` | 96 | the same for `omx-clap-host` alone |

plugin-hostd's probe runs plugin-qualify's own programs as its children: `clap-qualify` (`count
h.runs-clap-qualify` = 5) and `lv2_measure` from `/usr/libexec/plugin-qualify/` (`h.runs-lv2-measure` = 8).

### Records, outcomes, vocabulary, reports

| Function | plugin-qualify | omx-clap-core |
|---|---|---|
| per plugin, per rate | JSON: the measurement document (`src/measurement/format.ts`, 1243 lines), the qualification record (`src/qualification-record.ts`), the probe output read by `src/probe-output.ts` (format `plugin-hostd.probe-output`, major 1); sweep JSONL read by `src/measurement/sweep-jsonl.ts` (q.records, 32) | `raw/<rate>.jsonl` then `parity.tsv` (`lv2_parity.py` `row_of`, 22 columns), `plugins.tsv`, `host.tsv`, `coverage.tsv`; TSV helpers twice (c.tsv-parity 10, c.tsv-coverage 23) |
| outcome classes | the rating `suitable / conditional / unknown / unsuitable`, worst dimension decides (`src/rating.ts`, `classifyPluginHosting` 981–1061, 81 lines) | `IDENTICAL … HANG`, ten parity classes (`_classify` 229–330, 102 lines), plus `tests/lv2_parity_known.tsv` |
| failure vocabulary | `hosting.*` from omx-contract's `HOSTING_*_CODES` (`src/hosting-codes.ts`; 4 import sites, `count q.contract-imports`); the one hand-typed `hosting.` string in `src/` is the retired `required-not-provided` code of the `hosting.features` family (`q.handtyped-hosting` = 1). Probe outcomes `probe.*` are plugin-hostd's `protocol.h` `PHD_PROBE_OUTCOMES`, read, never minted | `OMX_HOSTING_*` from omx-contract's generated `omx_vocabulary.h` (33 lines in `src lv2`, `count c.contract-macros`), enforced by `tests/hosting-codes-check.sh` |
| report writers | the JSON document and the text verdict; no Markdown writer | `report_text` 1082–1242 (161 lines) writes `summary.md`; `docs/clap-compatibility.md` and `docs/lv2-compatibility.md` are hand-written and checked by `tests/clap_doc_check.sh` |

### Cost and latency under deterministic cycles

| plugin-qualify | omx-clap-core |
|---|---|
| `cost_rate` (85 lines, `native/clap-qualify.c`): `CLOCK_MONOTONIC_RAW` around each `process()`, 64 warm-up blocks dropped, median and p95 ns per sample (`percentile_sorted`, numpy's linear interpolation); the same `percentile` again in `tools/benchmark.py` (16 lines) | `Host.cpu_ns`: `/proc/<pid>/task/*/schedstat` summed over the whole host process before and after a run, so CPU ms per run, not per cycle; `stage_bench.c` `main` (28): median of 9 runs of ns per block of `omx_clap_run`, a library microbenchmark |
| latency: an impulse in, the onset measured (`impulse-onset`), checked against the declared figure | latency: what the host reports through JACK (`jack_port_get_latency_range`, `print_latencies`), measured nowhere |

## 2. Pairs: the same function in two places

Each row is one `pair` line of the script.

| Pair | Lines shared / a / b, overlap, diff | strings | Kind | Owner today | Ought to own |
|---|---|---|---|---|---|
| q.clap-fork / c.clap-fork (fork + alarm per file) | 13/41/43, 31 %, 58 | **5/5/10** | near-duplicate: same steps, same 30 s alarm, all five of qualify's messages are omx-clap-core's; brace style differs | both | omx-clap-core |
| q.clap-walk / c.clap-walk (directory walk) | 11/44/95, 25 %, 119 | 2/3/7 | near-duplicate; omx-clap-core's adds realpath dedupe | both | omx-clap-core |
| q.clap-describe / c.clap-describe (descriptor, params, ports) | 10/109/189, 9 %, 284 | 4/12/15 | same job, different code; qualify's adds labels and pages | both | omx-clap-core |
| q.clap-path / c.clap-path | 0/3/15 | 0/2/6 | same job, different code (TS and C); the lists differ by `/usr/lib64/clap` | both | omx-clap-core's list, read once |
| q.lv2-manifest / c.lv2-manifest | 0/25/94 | 1/7/10 | same file, different questions (list the plugins; does it name this URI) | both | leave |
| q.lv2-lilv / c.lv2-lilv | 6/172/56, 10 %, 218 | 2/48/11 | same library, different facts (catalogue; feed plan) | both | leave |
| q.noise-lv2 / c.signal | 0/9/13, diff 22 | 0/0/0 | same job, different signal | both | leave (see §4) |
| q.notes / c.notes | 0/67/26, diff 93 | 0/2/0 | same job, different code | both | leave |
| q.bench-worker / c.host-parity | 8/95/78, 10 %, 163 | 0/10/26 | different jobs: a one-shot measuring worker; a long-lived host over a socket | both | qualify's goes to plugin-hostd (§3) |
| q.classify / c.classify | 0/53/95 | 0/9/116 | different jobs: a verdict over dimensions; a parity class over two outputs | both | leave |
| q.cost-c / c.stage-bench | 0/76/22, diff 98 | 0/9/0 | different jobs: a plugin's cost; the library's per-block overhead | both | leave |
| **inside omx-clap-core** | | | | | |
| c.pw-parity / c.pw-coverage | 8/19/19, 42 %, 22 | 8/11/14 | near-duplicate | omx-clap-core tests | one module in omx-clap-core |
| c.ns-parity / c.ns-coverage | 12/70/35, 34 %, 83 | 17/44/28 | near-duplicate | omx-clap-core tests | one module in omx-clap-core |
| c.host-parity / c.host-coverage | 30/78/89, 38 %, 119 | 4/26/11 | near-duplicate | omx-clap-core tests | one module in omx-clap-core |
| c.tsv-parity / c.tsv-coverage | 7/10/20, 70 %, 16 | 5/5/8 | near-identical | omx-clap-core tests | one module in omx-clap-core |
| **inside plugin-qualify** | | | | | |
| q.pct-c / q.pct-py (percentile) | 0/5/15 | 0/0/1 | same maths in C and Python, by design (one checks the other) | qualify | goes with the probing code (§3) |

Nothing is identical across the two repositories. The only cross-repo near-duplicate is the CLAP scan (fork, walk,
describe: 223 lines in qualify, 281 with the labels, pages and helpers of its scan mode, against 450 in
omx-clap-core). The near-duplicates that add up are inside omx-clap-core's `tests/`: 194 lines in `lv2_parity.py`
against 177 in `clap_coverage.py` for the namespace re-exec, the private PipeWire, the host and the TSV helpers.

## 3. The mod-host dependency

**Where plugin-qualify runs a plugin under mod-host: nowhere in its code.** `count q.modhost-spawn` = 0: no
`spawn`, `exec` or `Popen` of `mod-host` in `src native tools bin`. The 66 lines that name mod-host
(`count q.modhost-words`) fall in four kinds:

1. **mod-host as a judged host, not as a runner.** `src/host-profiles.ts` 82–124 (`MOD_HOST_LV2_FEATURES`, the
   `mod-host` profile: shared process, 0.05 of a core at 48000/128), `src/qualify-declarations.ts` 189–199
   (`HOST_BUDGETS["mod-host"]`), and `src/hosting-suitability.ts` 234–238 (the `mod-host-effects-remove` crash
   attributed to the host). These stay: qualify judges for MOD whoever measures.
2. **A sweep it reads but does not run.** `tools/hosting-sweep.mjs` reads a sweep directory (`sweep-run.json` and
   its JSONL passes) that a mod-host sweep produced outside this repository. `--no-host-sweep`
   (`src/qualify-options.ts` 41) is parsed into `hostSweep` (`src/qualify-cli.ts` 102), and nothing reads it. The
   README says so (line 331): the entry point "does not yet drive … the mod-host sweep".
3. **Packaging and the image.** `Containerfile` 11–21 (the distribution's mod-host and an ASan build,
   `mod-host-asan`), `debian/control` 23 and `packaging/plugin-qualify.spec` 33 (`Recommends: mod-host`), and the
   `package.json` description ("a mod-host hosting sweep").
4. **Prose.** README 5, 54, 68–69, 215 (reproduce a crash with `mod-host-asan`), comments in `native/` and `tools/`
   that compare a behaviour with mod-host's.

**ASan in plugin-qualify** is its own: `make -C native asan` builds `lv2_measure` with AddressSanitizer
(`BUILDING.md` 43), and `src/lv2-measure-native.test.ts` runs it with `detect_leaks=1` over a measurement, a soak and a plugin that
will not instantiate. omx-clap-core runs no parity or coverage test under ASan. Its ASan builds are unit tests
(`test-untrusted-asan`, `test-lv2-asan`).

**What replaces mod-host with omx-clap-host.** The measuring already happens without mod-host: `clap-qualify` and
`lv2_measure` load the plugin in their own process, and plugin-hostd's probe runs both as its supervised children.
Two things still point at mod-host as a *runner*: the external hosting sweep (kind 2) and the crash reproduction
with `mod-host-asan` (kind 3). For both, the replacement is the same and is plugin-hostd's, not a new harness:

- plugin-hostd already drives `omx-clap-host` as the LV2 worker (`lv2_worker omx-clap-host`, its `docs/own-host.md`
  and the `lv2-clap` row of `src/formats.c`). The step that pulls `clap-qualify`, `lv2_measure` and
  `benchmark.py`'s probing half into plugin-hostd's child (step 4 of this repository's probe-isolation note) is
  what retires the sweep. The probe output is the record, keyed by rate and quantum.
- What that needs from a shared harness: an ASan build of the probe child (for the crash reproduction), and the
  isolation stage plugin-hostd has declared but not applied (namespaces, cgroups; `PHD_PROBE_LIMIT_*` says
  `not-implemented` today). Neither is a test directory's code.

**What qualify would reuse from the parity runner.** Little, measured: the runner's CPU figure is
`schedstat` over a whole run of a whole host process (per run, not per cycle). Its latency is the host's JACK
report, not a measurement. qualify's per-`process()` timing with a p95 is the finer figure, and its impulse onset
measures where the parity runner only reads what the host reports. The one piece qualify has no equivalent of is
the **feeder clock** (`c.clock`, 86 lines: PipeWire with no driver but the feeder, one cycle per trigger). It
would give "the cost of this plugin inside a real host graph at a fixed quantum", a figure qualify does not take
today. If qualify ever needs it, it belongs in plugin-hostd's probe child next to the isolation stage, because
qualify must not depend on a test directory.

## 4. Candidate shared pieces, ranked

| # | Piece | Contents | Owner | Language, ABI | Consumers and migration | Risk | Deletion it buys |
|---|---|---|---|---|---|---|---|
| 1 | **CLAP scan document** | enum labels and remote-control pages added to `omx-clap-scan --json`; then clap-qualify's scan mode deleted | omx-clap-core (`omx-clap-scan` is a shipped binary, not a test) | C; the JSON document `src/clap-loader.ts` already parses, so no new ABI | (a) omx-clap-core: write labels and pages; (b) plugin-qualify: drop `clap-qualify` from `SCANNER_NAMES`, delete the scan mode; tests stay on `omx-clap-scan` (already on CI via `install-scanners`) | low: one document, both sides already tested against it | **281** lines of `native/clap-qualify.c` |
| 2 | **omx-clap-core test harness module** | `ns`, `start_pipewire`, `Host`, the TSV helpers, once, in `tests/` | omx-clap-core (internal) | Python, no ABI | `lv2_parity.py` and `clap_coverage.py` import it; the shell e2e scripts keep their `unshare` line | low; both runners have `--self-test` with sabotage | about **177** lines (the smaller copies) |
| 3 | **Feeder clock and private PipeWire as a probe stage** | `c.clock` + `ns` + `start_pipewire`, as plugin-hostd's in-graph cost stage | plugin-hostd | C (the clock is already C); the probe-output document | plugin-hostd adds the stage; qualify reads its grid points; omx-clap-core's parity runner could call the stage | medium: a new figure, a new namespace dependency | none today; it adds a figure |
| 4 | **One stimulus generator** | the noise, sine, impulse and note sequences | omx-dsp (DSP maths in C) | C header | clap-qualify, lv2_measure, jack_parity | high: every cost and parity figure moves when the stimulus moves; parity needs its own mix to tell hosts apart | about 13 + 18 + 77 + 38 lines, no file |
| 5 | Records, classifiers, report writers | — | — | — | — | — | none: different jobs (§2) |
| — | Vocabulary | already shared: omx-contract (TS for qualify, the C header for omx-clap-core) and plugin-hostd's `protocol.h` for `probe.*` | — | — | nothing to build | — | — |

**Build now: 1 and 2.** Both are cheap, both delete code, and neither adds a dependency. **Leave 3** until
plugin-hostd applies its isolation stage; then it is that stage's work, not a library. **Leave 4 and 5**: no
deletion to speak of, and 4 would move every figure.

The larger deletion is already planned and is not a shared library: the probing code that moves into
plugin-hostd's child (`native/clap-qualify.c` 1587, `native/lv2-measure.c` 1288, and the probing half of
`tools/benchmark.py` 2685; units `q.prober-clap`, `q.prober-lv2`, `q.benchmark`). Piece 1 takes the scan out of
that move.

## 5. Verdict

**Leave them separate; share what is already shared; deduplicate twice.** The two sides answer different
questions with different evidence. plugin-qualify takes a verdict per plugin and per host from in-process
measurements: per-`process()` cost with a p95, impulse-onset latency, interposer RT-safety, ASan. omx-clap-core's
tests take a parity class per plugin by comparing two hosts' outputs on one deterministic graph. Across the two
repositories no function is identical. The classifiers share 0 normalised lines and 0 string literals; the records and reports are different formats
(JSON documents against TSV and Markdown). The failure
vocabulary is already one source (omx-contract), and running a plugin under limits is already plugin-hostd's.
The one cross-repo near-duplicate is the CLAP scan: 5 of 5 of qualify's fork-and-alarm messages are omx-clap-core's,
and qualify already prefers `omx-clap-scan`. It ends when `omx-clap-scan` writes labels and pages (281 lines
deleted). The remaining duplication is inside omx-clap-core's tests: runner, host and TSV, 34–70 % line overlap.
That is a module in that repository, not a shared library. A merge would put a test runner's code into a
shipped verdict tool, or the reverse, for no deletion beyond these two.

## Follow-ups

To be filed, one issue each (this report's pull request does not file them):

1. omx-clap-core: `omx-clap-scan --json` writes enum-parameter labels and remote-control pages (piece 1a).
2. plugin-qualify: drop clap-qualify's scan mode once `omx-clap-scan` writes labels and pages (piece 1b; depends
   on 1).
3. omx-clap-core: one test-harness module for `lv2_parity.py` and `clap_coverage.py` (namespace re-exec, private
   PipeWire, `Host`, TSV helpers) (piece 2).
4. plugin-qualify: `--no-host-sweep` is parsed and read by nothing. Delete the flag and the "mod-host hosting
   sweep" claims in `package.json`, the man page and the spec, or wire it to plugin-hostd's probe. Refuse or
   report, never silently do less (§3, kind 2).
