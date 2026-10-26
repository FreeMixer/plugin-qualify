<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com> -->
# Memory: footprint per instance, growth, a hard limit, a verdict per host profile

Status: proposed 2026-10-26, for #114. No code in this note's first commit.

The ruling this follows (operator, 2026-10-19, #114): a plugin's memory usage and behaviour must be
judged, never merely recorded, so a plugin is never qualified as good on a host it would hurt —
including a Raspberry Pi. Today LV2's soak records `rssStartKb` / `rssMaxKb` / `rssGrowthKb`
(`native/lv2-measure.c`) "for the record; not judged" (`src/hosting-suitability.ts`); CLAP has no
memory figure; there is no limit on a probe's memory; a host's verdict never reads memory at all.

## The three-line gate, per piece

### 1. Footprint per instance — lands beside `nsPerSample`, not as a new dimension

The issue says it directly: "The figures go in the measurement format and the qualification record
next to nsPerSample." `CostAtRate` (`src/measurement/format.ts`) already carries `voices: VoicesHeld`
for an instrument's basis (#78); the footprint is the same shape of fact about the same reading, so
it is a new optional `memory: MemoryFootprint` on `CostAtRate`, not a seventh `HostingDimension`
(today's six are closed: `stability | rtSafety | features | cost | latency | topology`). `cost` is
already "what this plugin spends the host", CPU and now RSS.

`MemoryFootprint` carries `afterInstantiateKb`, `afterActivateKb`, `atRestKb` (settled, post-processing),
and `secondInstanceAfterInstantiateKb` — a second instance's own figure, held apart so one-time shared
load (a sample library, a wavetable, an IR) does not inflate the per-instance number the budget below
reads. `basis` reuses `VoiceBasis` (declared/probed, #78) for an instrument's notes-held context; an
absent figure carries `unmeasuredReason` (the existing `UnmeasuredCode` vocabulary — `probe-failed`
etc. — nothing new there). Format minor bump: additive, a 1.5 reader skips it.

### 2. Growth over time — reuses the existing per-rate soak-failure vocabulary, no new code

`soakFindings` (`src/hosting-suitability.ts`) already folds one `SoakFailureKind` per rate into the
ONE generic code `HOSTING_CODE.stabilitySoakFailedAtRate`, with the kind as a `failure` param — `died`,
`non-finite`, `dead`, `mostly-silent`, `startup-blast`, `timed-out`. A rate whose memory keeps climbing
past a threshold, measured AFTER warm-up so a library's one-time init does not count against it, is
the same shape of fact and earns a seventh kind, `leaks`, through the SAME code. No `hosting.memory.*`
needed, no omx-clap-core change: this is the "extend the vocabulary" gate answered by reuse, not a new
word.

Warm-up is measured, not assumed: `lv2-measure.c`'s soak already skips the first two ~1 s windows
before trusting `firstRmsDbfs` ("skip settling"); the same two windows are where the native side now
also reads `rssAfterWarmupKb` and reports the audio-seconds elapsed to reach it (`warmupSeconds`) — a
RAW reading, not a conclusion, matching every other field `SoakAtRate` carries. The rate, in KB/minute,
is `(rssMaxKb - rssAfterWarmupKb) / ((seconds - warmupSeconds) / 60)`, computed where it is judged
(`soakFindings`), never baked into the C side, for the same reason the dead-rate ratio is computed in
TypeScript and not in C: one rule, one place.

**Open question for the operator** (commented on #114): the growth ceiling has no existing ruling —
unlike `cycleFloor` (1000, §14.4) or `soakSeconds` (3 h, §3), nobody has set a KB/minute number. This
note ships a provisional `DEFAULT_HOSTING_POLICY.memoryGrowthKbPerMinCeiling` (10240, i.e. 10 MB/min)
so the rule is real and testable; the number itself is asked for, not assumed.

CLAP gets the same soak: `native/clap-qualify.c` has no continuous-render loop today (only the bounded
sweep, `CLAP_SWEEP_BLOCKS` × `CLAP_SWEEP_FRAMES`). Building it is its own step, deferred here (see
"Not done in this PR").

### 3. A hard limit in probe isolation

The design this follows (`probe-isolation-and-cost-grid.md`, #91 ruling) puts the supervised, limited
child in plugin-hostd — "the door... it runs the scan and the probes in a supervised, limited child."
plugin-qualify's own direct path (no daemon, for packaging CI and catalog curation —
`direct-prober.support.ts`, `probe-runner.ts`, `benchmark.py`) is the part this repository owns, and
is where a limit can be added without plugin-hostd: `RLIMIT_AS` around the worker process is portable
and needs no privilege (a cgroup needs one this path cannot assume it has). Hitting it is recorded as
an outcome, never a harness crash.

**Open question for the operator** (commented on #114): should the hard limit be plugin-qualify's to
enforce on its own direct spawns (`RLIMIT_AS`, this repo), plugin-hostd's to enforce in the supervised
child (cgroup `memory.max`, that repo, mirroring the #91 ruling's split), or both — and if plugin-hostd's,
what is plugin-qualify's job here beyond reading the outcome plugin-hostd's probe output will carry
(the `probe.*` outcome vocabulary, `src/probe-output.ts`, already structural and additive)?

### 4. A verdict per host profile

`HostProfile` / `HostBudget` (`src/measurement/format.ts`, `src/host-profiles.ts`) already carry a
per-instance CPU budget (`cost.coreFractionCeiling`) that is profile-local, interchange data — adding
a memory ceiling beside it (`HostBudget.memoryPerInstanceCeilingKb`, additive, optional so an old
profile document still reads as "no memory budget declared" rather than zero) needs no upstream
change, and neither does naming two more shipped profiles: `openmixer-pi-4gb` and `openmixer-pi-8gb`,
alongside `OPENMIXER_CONSOLE_PROFILE` / `JALV_PROFILE` / `MOD_HOST_PROFILE` / `OMX_CLAP_HOST_PROFILE`
in `host-profiles.ts`, same `isolation`/`latency` shape as the console (in-process, compensated) since
a Pi running openmixer is still the console's own binary, just smaller.

Reading a footprint against a budget (`memoryWithinBudget` below) is pure and testable on its own —
a missing figure must never read as "fits" (the issue's own words), so the function returns an
explicit `"unmeasured"` outcome, never `true`.

**Open question for the operator**, same shape as #2 and #3: the verdict `classifyPluginHosting`
emits needs a `HostingCode` (`stabilitySoakFailedAtRate` is reusable because it already carries a
`failure` kind param; `costAboveCeiling` is NOT reusable for memory — it means "core-fraction above
ceiling" everywhere else a consumer reads it, and reusing it for a KB figure would make the console
render "CPU cost" next to a RAM number). `HOSTING_CODE` is generated from omx-clap-core
(`tools/gen-hosting-codes.mjs`, `src/contract-vocabulary-conformance.test.ts` holds the two to each
other) — plugin-qualify does not own that vocabulary and cannot mint `hosting.memory.above-ceiling` /
`hosting.memory.within-ceiling` / `hosting.memory.unmeasured` locally without the exact bug the lane
rules call out: a parallel mechanism alongside the real one. This PR ships `memoryWithinBudget` and
the two Pi profiles, tested on their own; wiring the result into `classifyPluginHosting`'s cost
reasons and `DocumentVerdict.deciding` is the follow-up once the codes exist upstream.

**Pi profile numbers are provisional, same reason**: nobody has measured a Pi's own rate/quantum or
decided its memory headroom (OS reserve, other processes) the way §14.2 decided the console's 5 %.
This note ships 48 kHz / 256 frames (the figures `JALV_PROFILE` already uses for a comparable
single-process-per-plugin-ish host) and a per-instance ceiling sized as a fraction of the board's RAM
after a 1 GiB OS/desktop reserve, divided across a modest instance count — numbers that need the
operator's eyes before anyone ships a verdict against a real Pi.

## Not done in this PR (follow-ups, named so nobody re-derives them from silence)

1. CLAP's own continuous soak (so `leaks` and the footprint's `atRestKb` apply to CLAP, not only LV2) —
   needs a render loop in `clap-qualify.c` first; the issue's ask stands, this is sequencing.
2. The three sabotage fixtures (`activate`-time big block, per-block leak, per-voice allocation) and
   the tests that go red without each new rule — the next commits in this lane add the TypeScript-only
   growth rule and a native fixture for it; the CLAP-side and per-voice fixtures follow step 1 above.
3. Wiring `memoryWithinBudget` into `classifyPluginHosting` and `DocumentVerdict` — blocked on the
   omx-clap-core codes asked for above.
4. The hard limit itself (`RLIMIT_AS` around the direct spawns) — blocked on the scope question above;
   the outcome vocabulary it would need (`probe.*`, structural and additive like the rest of
   `probe-output.ts`) is otherwise unaffected by that answer and could land first.
5. openmixer's admission budgeting memory (`RT_COST_UNKNOWN` precedent, #1751) and plugin-hostd's probe
   output carrying the new fields (#106's same gap for cost) — both named under "Consumers" in #114 and
   both other repositories.

## Done means

The pieces that need no upstream vocabulary (1, 2's rule, 4's shape and pure function) are done when:
a document round-trips a `memory` block and a `HostBudget.memoryPerInstanceCeilingKb`; a soak fixture
whose RSS keeps climbing past warm-up earns `leaks` at its rate and a fixture whose RSS is flat does
not (sabotage: deleting the check turns that test red, not merely passing); `memoryWithinBudget` reads
`"unmeasured"` for an absent figure and never `true`. The rest is named above as not done, with the
question that blocks each one asked on #114.
