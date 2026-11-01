Plugins that change a callee-saved register
============================================

What a qualification records when a plugin returns from a call with a callee-saved register changed, and what is done
with such a plugin.

What happens
------------

Every calling convention gives a callee registers it must hand back as it found them:

- aarch64: x19 to x28, d8 to d15, FPCR
- x86-64: rbx, rbp, r12 to r15, MXCSR's control bits, the x87 control word

A caller may keep a value in one of them across the call. A plugin that returns with one changed replaces that value
without anything crashing at the time. The damage shows later, somewhere else.

Seen with
---------

- The four LSP limiters in their LV2 build (`limiter_mono`, `limiter_stereo`, `sc_limiter_mono`, `sc_limiter_stereo`),
  lsp-plugins 1.2.26, on a Raspberry Pi 5 (Debian 13 arm64).
- Their `run()` returns with d14 and d15 changed. That starts at block 227 of the measurer's control sweep and recurs
  in 386 of its calls.
- `lv2_measure` kept its sample rate in d15. Its next instance was opened at 0 Hz, LSP sized a buffer from that rate,
  and the plugin wrote through a NULL pointer. Each of the four was recorded as `probe.crashed` (SIGSEGV).
- Built at -O0, where the compiler keeps its locals in memory rather than in those registers, the measurer ran them to
  the end. At -O2 it crashed every time.

What is done
------------

- omx-clap-core 0.26.2 calls every plugin function through `omx_abi_call6` (`abi_guard.S`).
  - It saves those registers, calls, compares, and puts them back.
  - It records the first call that changed any: the registers, the plugin function and the run block.
  - Cost: 14 to 15 ns per call on a Raspberry Pi 5, and 5.6 ns on an x86-64 desktop. For 24 plugins at 48 kHz in
    256-frame blocks, that is 0.36 µs of each 5,333 µs block.
- `lv2_measure` makes every plugin call through the same guard, `lilv_plugin_instantiate` and `lilv_instance_free`
  included. Its record carries `abi`, for example:
  `{"clobbered":true,"registers":["d14","d15"],"call":"run","block":227,"calls":386}`.
  A plugin that never clobbered reads `{"clobbered":false}`.
- The verdict is `hosting.stability.callee-saved-clobbered`, rated conditional: the plugin is offered isolated only, in
  a worker of its own, never in-process on the console and never in a shared chain. The guard keeps the host's own
  frame whole. It does not cover the other members' state in the same process.
- A worker writes `abi_clobber <instance> <mask> <registers> <call> <block>` on its feedback port, once per instance.
  plugin-hostd then quarantines the instance and moves it to a worker of its own with its state.

Under the guard, the four limiters now measure to the end: 0 allocations in `run()`, and all six rates sound. Their
numbers before the guard may have been corrupted and are not used.

Not shown
---------

- raffo crashed in `handle_midi` at -O2 without the guard and runs to the end with it, recording no clobber. That does
  not prove it clean: the guard changes the measurer's frame and may hide a memory fault.
- calf Wavetable and dexed still crash with the guard and at -O0. Their cause is elsewhere and is still being followed.

How to see it again
-------------------

The fixture `native/fixtures/lv2-gain.c`, built with `-DFIXTURE_ABI_BREAKER` (`abi-breaker.lv2`), returns from its third
`run()` with x19 and d15 changed (rbx and r15 on x86-64), in assembly after the C `run()` has returned.
`src/lv2-measure-native.test.ts` measures it to the end and checks the record.
