<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com> -->
# Probe mode under the supervised child, and cost keyed by rate and quantum

Status: proposed, for #91. No code in this note's pull request.

The decision this follows: plugin-hostd is the door a plugin passes through and the one place
that looks inside it; it runs the scan and the probes in a supervised, limited child, and plugin-qualify judges the
probe output and still runs without a daemon for packaging CI and catalog curation. The probe-output interface
between the two is specified with it (plugin-hostd's runner and child, the outcome and limit codes,
the document keyed by rate and quantum, the five stages). This note says what that means for plugin-qualify, one
step at a time, and what is not ours to start.

## The three-line gate

1. **Which primitive?** plugin-hostd's supervised worker and its pin hashing (`pin.h`, already used by `clap-qualify`
   and `lv2_measure`), and this package's measurement document (`src/measurement/format.ts`), whose `plugins` half is
   already facts apart from `verdicts`.
2. **Extend the vocabulary first?** Yes, the outcomes: the free text before this note ("worker crashed", "timed out") is mapped to
   `probe-crashed` / `probe-timeout` by `probe-json.ts`, and the new `hosting.worker.nonconforming` is minted. The
   probe outcome codes belong to plugin-hostd's `protocol.h`; this package reads them, it does not invent a second set.
3. **Why not simply grow the measurement document?** It is one run over many plugins and keys cost by rate. The
   probe output is one binary and one offer per document and keys cost by rate and quantum. The record this package
   writes keeps the measurement document's shape; the probe output is what feeds it.

## What is wrong before this note (in this repository)

- `clap-qualify` probe mode runs the plugin in its own process with no fork. Only scan mode forks, with `alarm(30)`.
  Its only bound is the caller's `spawnSync` timeout, which signals the direct child and nothing it started.
- Three watchdogs: the scan alarm, `spawnSync(..., {timeout})` around `clap-qualify` and `lv2_measure`, and
  `benchmark.py`'s per-plugin worker timeout; three ways of naming a death.
- No limit on memory, tasks or open files anywhere.
- Cost is keyed by rate only: `CostMeasurement.perRate`, the classifier's `cpuCost.perRate[String(rate)]`, one block
  size per rate (`benchmark.py` `DEFAULT_COST_BLOCK`), while the code that names a missing figure is
  `hosting.cost.unmeasured-at-rate-and-quantum`. `QUALIFY_QUANTA` has four quanta and the classifier reads one.

## The plan for plugin-qualify

Each step is its own pull request, with its own test and the arm that breaks it. Nothing here moves a figure.

1. **Cost keyed by rate and quantum, in this package alone (no hostd needed).** The descriptor's `cpuCost`
   (`src/hosting-suitability.ts`) adds `perRateQuantum` (rate string, then quantum string) beside `perRate`, which stays readable and is written as the reference
   quantum's entry. `benchmark.py` already takes `--quanta`; the cost pass runs one block size per quantum and the
   merge keeps them apart. `hostingCostReasons` reads `[rate][quantum]` and, for a document of the old format only,
   falls back to `perRate` at the reference quantum, saying so in the reason's detail. Tests by value: two quanta of
   different cost give two different cost reasons; a quantum that was not measured is
   `hosting.cost.unmeasured-at-rate-and-quantum` naming both; the old document still reads. Sabotage arm: the
   classifier reading the wrong quantum goes red.
2. **A single exit vocabulary for the probers.** `clap-qualify` probe mode, `lv2_measure` and `benchmark.py` end with
   the same named outcome (measured, could not instantiate, crashed, timed out, refused), as a field of their line,
   not as free text. `probe-json.ts` stops guessing from words. Test by code for each; the `probe-error` fallback
   stays for text it cannot class and is asserted to be rare in the fixtures.
3. **Call the runner where `spawnSync` is called.** When plugin-hostd ships `plugin-hostd-probe` (its stage 1, the
   runner with the portable limits around the existing programs), `clap-loader.ts` and `lv2-measure.mjs` call it when
   `OMX_PROBE_RUNNER` names one or it is on `PATH`, and read the probe output (`readProbeOutput`, which refuses an
   unknown major). Without a runner they behave as before. The three `spawnSync` timeouts go when the last caller
   moves. Proof: for every fixture plugin, the verdicts from the translated probe output equal those from the existing
   documents, plugin by plugin and profile by profile.
4. **The probing code leaves this repository.** `clap-qualify`'s measure and scan paths, `lv2_measure` and the probing
   half of `benchmark.py` move to plugin-hostd's child in the same change that deletes them here (no two copies).
   plugin-qualify keeps the judge, the report and the catalog. That is plugin-hostd's stage 4.

Steps 1 and 2 are ours and can start now. Step 3 waits for plugin-hostd's runner. Step 4 waits for its child.

## The grid every host is judged on (#193)

The deep run on a Raspberry Pi 5 with plugin-qualify 0.16.1 measured every cell at quantum 512 and most LV2 plugins at 192000
alone, so every host verdict read `hosting.cost.unmeasured-at-rate-and-quantum`. Two causes: the probe runner was
always handed quantum 512 (`--quanta` was parsed and never passed on), and plugin-hostd's runner measures an LV2
plugin at the highest of the rates it is given, one rate a run. The decision: the grid holds each declared host's
rate and quantum, an LV2 plugin is measured at the same cells as a CLAP one, and the sampler's memory is bounded
so an out-of-memory kill is a recorded outcome, not a lost record.

- The grid is a list of cells (rate, quantum): the hosts' cells, 512 at every rate for continuity, or the full
  product of `--rates` and `--quanta`, or cells named one by one. README "The measurement grid" states it.
- A CLAP plugin is run once per quantum, at that quantum's rates; an LV2 plugin once per cell. The runs of one
  plugin and offer are merged into one probe output, which is what the record judges and copies.
- A run that ended badly leaves its cells in the grid with its outcome; the judge reads a host's cost at its cell
  and names the run's outcome when that cell failed. `hosting.cost.unmeasured-at-rate-and-quantum` is for a cell
  the grid does not hold.
- The memory bound is the runner's data limit (`RLIMIT_DATA` on the child), half of the RAM by default; the
  interposer exits 121 on a refused allocation and that, or a `SIGKILL` the runner did not send, is `probe.oom`.
  Since memory-footprint-and-budget.md the runner sets `memory.max` on the child where the controller is delegated, which is
  `probe.memory-limit`; the data limit is what it falls back to.

## Not decided here

- Whether the quantum grid stays four literals or is declared by the contract: the contract has rates but no quanta.
  Until it does, `QUALIFY_QUANTA` keeps the hard-target quantum from the contract and three literals (256, 512 and
  the reference).
- The tolerance within which a moved child's figures must agree with the existing programs (step 4): plugin-hostd's
  protocol states it; this package asserts whatever it is.

## Done means

Step 1 done: a run at `--quanta 128,1024` rates cost at both, and the console's classifier answers differently for
a plugin that fits at 1024 and not at 128. Step 2 done: no code path produces an unmeasured reason from a regular
expression over a prober's words. The note is done when the order of the four steps is accepted.
