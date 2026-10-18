// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * The hosting verdict's message codes. Codes, never prose: the
 * surface renders the operator's locale.
 *
 * A UNION list file: `.gitattributes` marks it
 * `merge=union`, so two lanes that each add a code merge with both kept. Only the table lives
 * here, one `key: 'code',` per line, with keys and codes unique; the registry-hotspots gate
 * refuses anything else.
 */
export const HOSTING_CODE = {
  stabilitySoaked: 'hosting.stability.soaked',
  stabilityCrashedAttributed: 'hosting.stability.crashed-attributed-plugin',
  stabilityCrashedLive: 'hosting.stability.crashed-live-on-this-rig',
  stabilityBelowFloor: 'hosting.stability.cycles-below-floor',
  stabilityUnsoaked: 'hosting.stability.unsoaked',
  stabilitySoakFailedAtRate: 'hosting.stability.soak-failed-at-rate',
  stabilityUnmeasured: 'hosting.stability.unmeasured',
  stabilityCrashUnattributed: 'hosting.stability.crash-unattributed',
  stabilitySpawnsThreads: 'hosting.stability.spawns-threads',
  stabilityLinksGuiToolkit: 'hosting.stability.links-gui-toolkit',
  rtSafetyClean: 'hosting.rt-safety.clean-under-sweep',
  rtSafetyViolations: 'hosting.rt-safety.violations-in-run',
  rtSafetyUnmeasured: 'hosting.rt-safety.unmeasured',
  rtSafetyNotReproducible: 'hosting.rt-safety.not-reproducible',
  // The note sweep: an instrument played under the interposer, a count of its own.
  rtSafetyNotesClean: 'hosting.rt-safety.clean-under-notes',
  rtSafetyNotesViolations: 'hosting.rt-safety.violations-under-notes',
  rtSafetyNotesUnmeasured: 'hosting.rt-safety.notes-unmeasured',
  featuresProvided: 'hosting.features.all-provided',
  featuresMissing: 'hosting.features.required-not-provided',
  featuresDisqualifying: 'hosting.features.host-not-provided',
  featuresCv: 'hosting.features.cv-ports',
  featuresMidiIn: 'hosting.features.midi-in-fed-empty',
  featuresUnscanned: 'hosting.features.scan-predates-field',
  costWithinCeiling: 'hosting.cost.within-ceiling',
  costAboveCeiling: 'hosting.cost.above-ceiling',
  costSpiky: 'hosting.cost.spiky-tail',
  costUnmeasured: 'hosting.cost.unmeasured-at-rate-and-quantum',
  costFieldsMissing: 'hosting.cost.fields-missing',
  latencyResolved: 'hosting.latency.resolved',
  latencyUnmeasured: 'hosting.latency.unmeasured',
  latencyNonconforming: 'hosting.latency.nonconforming',
  latencyParameterDependent: 'hosting.latency.parameter-dependent',
  topologyMatched: 'hosting.topology.matched',
  topologyNoAudioInput: 'hosting.topology.no-audio-input',
  topologyNoAudioOutput: 'hosting.topology.no-audio-output',
  topologyExtraInputs: 'hosting.topology.extra-inputs-fed-silence',
  topologyInstrument: 'hosting.topology.instrument',
  // The CLAP arm: the SAME dimensions fed from CLAP facts,
  // minted here where the LV2 table has no code for the fact.
  topologyWiderThanStrip: 'hosting.topology.wider-than-strip',
  clapLatencyMismatch: 'hosting.clap.latency-mismatch',
  clapNotAudioEffect: 'hosting.clap.not-audio-effect',
  clapHeadlessFailed: 'hosting.clap.headless-failed',
  clapNoteInput: 'hosting.clap.note-input',
  clapThreadViolation: 'hosting.clap.thread-violation',
  clapProcessError: 'hosting.clap.process-error',
  clapUnqualified: 'hosting.clap.unqualified',
  clapFormatNotHosted: 'hosting.clap.format-not-hosted',
  clapExtensionsNotCovered: 'hosting.clap.extensions-not-covered',
  outputNonFinite: 'hosting.output.non-finite',
  workerNonconforming: 'hosting.worker.nonconforming',
  // The pin (spec §11; one-contract §10.3): a host's refusal at add, by the daemon's code.
  integrityUnpinned: 'hosting.integrity.unpinned',
  integrityBinaryMismatch: 'hosting.integrity.binary-mismatch',
  integrityLayoutMismatch: 'hosting.integrity.layout-mismatch',
  overrideIsolated: 'hosting.override.curator-isolated',
  hostProvenanceDiffers: 'hosting.provenance.host-differs',
  sweepControlDidNotFire: 'hosting.provenance.sweep-control-did-not-fire',
  // The five REALISED reasons. Everything above answers what a plugin EARNED; these answer
  // what the console DID with that, and the difference between the two is the operator's
  // whole question when a slot is not on the fast path.
  disabled: 'hosting.disabled',
  unjudged: 'hosting.unjudged',
  noRealisation: 'hosting.no-realisation',
  realisedInProcess: 'hosting.realised.in-process',
  // A plugin LINKED into the engine (the static-link registry) runs in-process without a
  // verdict: the library's oracles are its proof.
  linked: 'hosting.linked',
} as const;
