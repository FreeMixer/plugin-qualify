<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com> -->
# Memory: footprint per instance, growth, a hard limit, a verdict per host profile

Status: decided 2026-10-30, for #114. Implemented, with the exceptions under "Not done".

A plugin's memory is judged, never merely recorded, so that a plugin is never qualified as good on a host it would hurt,
including a Raspberry Pi. What this note decides, and why each piece went the way it did.

## 1. Footprint per instance

`MemoryFootprint` (`src/measurement/format.ts`) sits beside the cost on `CostAtRate`, on a probe output's grid point and on
the record's: how far the resident set grew, in KB, after instantiate, after activate, at rest after processing, and with
notes held for an instrument (at the same count and basis as the cost, #78), and what a second instance added.

Each rate's footprint is taken by a child of the prober forked before any instance exists, so no earlier instance has grown
the process, and a plugin that dies there costs that rate its figure and nothing else. The CLAP side adds what loading the
`.clap` itself took to the first instance. An LV2 plugin is loaded by its first instantiate. A figure not taken is absent,
never 0, and `unmeasuredReason` says why.

Two figures come out of it (`src/memory-budget.ts`), and the record writes them beside the raw ones so that a client adds
up the same numbers the verdict read:

- `firstInstanceKb`: the most one instance held at any step, with everything its instances share.
- `perInstanceKb`: what one more instance costs: the second instance's own part, and the voices (notes held less at rest).
  With no second instance measured nothing separates what is shared, so it is the whole of the first.

The second instance is measured to the end of its first blocks, not only to instantiate as the first version of this note
had it: a plugin that allocates at activate would otherwise read as free.

A footprint read under the probe's memory lock would count every page the plugin mapped, and it would not say what the
plugin touched. The child does not inherit the lock.

## 2. Growth over time

A rate whose memory keeps climbing past a ceiling is a soak failure of a new kind, `leaks`, through the existing
`hosting.stability.soak-failed-at-rate`. The native side reads raw figures: the resident set past the settling the first
level skips (`rssAfterWarmupKb`, `warmupSeconds`) and halfway from there to the end (`rssMidKb`, `midSeconds`). The rate is
worked out where it is judged: from the halfway reading to the highest, per minute of audio. Measuring only the second half
is what tells a library that finished loading late from a leak.

The ceiling is `DEFAULT_HOSTING_POLICY.memoryGrowthKbPerMinCeiling`, 10 MB/min. It ships provisional, is tightened from
measurements, and the reason says `provisional`.

## 3. A hard limit

Two, each with its own job:

- **plugin-hostd enforces `memory.max`** on the supervised probe child. The kernel counts what the plugin really holds and
  kills its tree at the limit. Hitting it is the outcome `probe.memory-limit`, known from `memory.events`. A machine with no
  delegated controller falls back to `RLIMIT_DATA` and lists `memory` under `limits.unavailable` with
  `probe.limit.cgroup-absent` or `probe.limit.controller-not-delegated`.
- **plugin-qualify enforces `RLIMIT_AS`** on its own direct spawns, which have no runner: `tools/lv2-measure.mjs`'s hosting
  pass, `tools/benchmark.py`'s worker and the tests' direct prober (`src/direct-limit.ts`). It is all the machine's RAM,
  the far bound of a run rather than its budget, since address space is what a plugin reserves and not what it touches. It is
  off for a sanitizer build, which reserves far more than it uses. The interposer ends the child on the first refused
  allocation, and that is the outcome `memory-limit-exceeded`, with the limit. A Python worker that sees the failure reports
  the same word; one whose plugin dies of it is taken by crash containment as any other death.

Either way the cell carries its outcome and `memoryLimit { bytes, mechanism }`, the record is written, and the other cells
are judged. A host whose own cell hit the limit is `unknown` there, in the `memory` dimension.

## 4. A verdict per host profile

`HostBudget.memory` holds `perInstanceKb`, `perConsoleKb`, and for a host that runs several cells their list. A profile with
no budget declared reads nothing here, which is not a budget of 0: `jalv`, `mod-host` and `omx-clap-host` are general hosts on
no particular machine. `memory` is a dimension of the verdict, unlike the cost's reasons, which sit beside it, because it
has a code family of its own (`hosting.memory.*`, omx-clap-core's) and can decide on its own.

`memoryWithinBudget` reads a footprint against a budget: `perInstanceKb` against the instance's share, `firstInstanceKb`
against the whole console's, so a sampler with a large shared library can fit a small host once and is still read correctly
for two. What it gives the verdict, per cell, the worst standing:

| what was read | rating | code |
|---|---|---|
| a figure above a ceiling | `unsuitable` | `hosting.memory.above-ceiling`, and `provisional` in its params when the ceiling is |
| no figure, or a reason beside the figures | `unknown` | `hosting.memory.unmeasured` |
| under a measured budget | `suitable` | `hosting.memory.within-ceiling` |
| under a provisional budget | `conditional` | `hosting.memory.within-provisional-ceiling` |

A plugin under a provisional budget is therefore not qualified there: the figure and the ceiling are stated, and the verdict
does not say the plugin fits. It takes a measured budget to do that.

**The console**: `openmixer-console` is sized for the desk, 30 GiB: 16 GiB for the plugins of a console, the rest the engine's
and the system's, and 4 GiB for one instance, which is what the probe bounds a run by.

**A Raspberry Pi**: `openmixer-pi-4gb` and `openmixer-pi-8gb` have the shape of `omx-clap-host`, which is what runs a plugin on a
Pi. Their cells are what a Pi is set to, from zynthian-sys's JACK settings: 48000/128 on a Pi 5 with the V5 kit, 48000/256 on a
Pi 4 and the other kits, and on the Pi 5 with no kit card the benchmarks and the stress runs used (plugin-hostd
`docs/zynthian/offer.md`, `stress.md`). The Zynthian matrix sweeps 44100 to 192000 Hz at 128 to 1024 frames to compare hosts;
those are benchmark cells, not what a Pi runs, and a plugin is not judged at them. The cost is read at 48000/128 and the memory
at both cells. The budget is all the board's RAM but 1 GiB for the system and Zynthian's UI, and an instance's share an
eighth of that: 3 GiB and 384 MiB on 4 GB, 7 GiB and 896 MiB on 8 GB. These numbers are provisional until read on a Pi: the
stress runs stopped a level at 400 MB free, and no plugin's footprint has been taken there yet.

Since a missing figure reads as `unknown`, a console that upgrades reads every plugin as `unknown` on the desk until it has been
measured again. That is the rule at work, not a side effect of it: nothing says the old figures fit.

## Not done

1. **CLAP's soak.** The prober has no continuous render, and a soak is more than its loop: something has to schedule it
   and carry it through the runner. `leaks` applies to LV2 until it is built; a CLAP plugin's growth is unmeasured, and it reads
   `unsoaked` as before. The footprint is both formats'.
2. **Consumers.** openmixer's admission and insert-time count read the record; plugin-hostd's `estimate` reads it now.
