LSP plugins (CLAP) crash when reactivated at another sample rate
================================================================

A note for the LSP maintainers, to be sent by hand. It records what was seen and how to see it again.

What happens
------------

Some LSP plugins in their CLAP build crash (SIGSEGV, sometimes SIGABRT) when one instance is deactivated and activated
again at a different sample rate. The same plugins run at each rate when activated once, and their LV2 builds pass the
same sequence, since an LV2 host instantiates per rate.

The CLAP specification allows `activate()` with other values after `deactivate()`, so a host may do this, for example
when the graph rate changes at runtime.

Seen with
---------

- lsp-plugins 1.2.26 (Debian package 6:1.2.26-1kxstudio1), `/usr/lib/clap/lsp-plugins.clap`
- Raspberry Pi 5, Debian 13 arm64
- `in.lsp-plug.sc_mb_dyna_processor_stereo` crashes on every run going from 48000 Hz to 96000 Hz. Each of 44100, 48000,
  96000 and 192000 alone passes, and so do 44100 then 48000, and 96000 then 192000.
- Of nine LSP plugins that crashed in a qualification run, all nine pass at one rate, and six crash across the four rates
  44100, 48000, 96000, 192000 (`mb_compressor_stereo`, `mb_gate_stereo`, `para_equalizer_x16_stereo`,
  `para_equalizer_x8_stereo`, `sc_mb_dyna_processor_lr`, `sc_mb_expander_ms`); the other three passed that time, so it
  does not happen on every run.
- The crash is in the plugin's code on the host's main thread (gdb, no symbols in the packaged build).

How to see it again
-------------------

With plugin-qualify installed, `clap-qualify` runs one instance through each rate in turn:

    /usr/lib/plugin-qualify/clap-qualify --rates 48000,96000 --block 512 \
        /usr/lib/clap/lsp-plugins.clap in.lsp-plug.sc_mb_dyna_processor_stereo
    echo $?     # 139: SIGSEGV

    /usr/lib/plugin-qualify/clap-qualify --rates 96000 --block 512 \
        /usr/lib/clap/lsp-plugins.clap in.lsp-plug.sc_mb_dyna_processor_stereo
    echo $?     # 0

Any CLAP host shows it with: create, `activate(48000, 512, 512)`, process a few blocks, `deactivate()`,
`activate(96000, 512, 512)`, process.

What plugin-qualify does about it
---------------------------------

A host at a fixed graph rate never takes this path, so it no longer decides whether a plugin is offered. Each rate is
judged in a fresh instance, and reactivation at another rate is a check of its own, recorded but not deciding.
omx-clap-host and the console's engine are being changed to recreate an instance, carrying its state, when the graph
rate changes, so a plugin with this fault keeps working there too.
