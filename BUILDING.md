# Building plugin-qualify

You need Node.js 20 or newer (the tool itself runs on 18) and pnpm 10 (`npm install -g pnpm@10`, or `corepack enable`). The
Python tools need Python 3 and, to scan real plugins, the lilv bindings (`python3-lilv` on Fedora,
`python3-lilv` on Debian), and `jsonschema` (`python3-jsonschema`) to write the scanned descriptors. The tests
use `pytest`.

```
pnpm install            # also compiles src/ into dist/
pnpm test               # the TypeScript tests
pnpm lint               # type-check everything, tests included
pnpm check:generated    # tools/_declarations.py and src/hosting-codes.generated.ts are current
pnpm test:py            # the Python tools' tests
```

`tools/_declarations.py` is generated from `src/qualify-declarations.ts` so the Python scanner and
benchmark read the same rates, quanta and timeouts as the TypeScript code. After changing the
declarations, regenerate it and commit both:

```
node tools/gen-python-declarations.mjs --write
```

`src/hosting-codes.generated.ts` is omx-clap-core's hosting tables (`HOSTING_<DIMENSION>_CODES` in
the TypeScript modules under `pkg-config --variable=tsdir omx-clap-core`), flattened into the plain
data `HOSTING_CODE` is, so no public subpath a browser bundles reads a file or imports a `node:`
module. `pnpm build` rewrites it whenever it finds omx-clap-core's modules (`OMX_CLAP_CORE_TSDIR`,
else pkg-config, else the checkout `make -C native deps` fetches, else `/usr/share/omx-clap-core/ts`)
and keeps the committed one where it finds none. After moving to a new omx-clap-core, regenerate it
and commit it:

```
node tools/gen-hosting-codes.mjs --write
```

The CLAP prober, the LV2 measurer (`lv2_measure`, taken in from openmixer), their interposer and
the fixture plugins their tests qualify (a known RT-safe and a known RT-unsafe gain, as a `.clap` and
as an LV2 bundle, and the LV2 bundle `host-faithfulness.lv2`, five plugins that each need one thing of
the measuring host: options, a worker, patch:Set, a bounded sweep, a stdout of their own) are C, built
with make. The CLAP headers come from `pkg-config clap` (Fedora
`clap-devel`), plugin-hostd's `pin.h` from `pkg-config plugin-hostd`, lilv and the LV2 headers from
`pkg-config lilv-0` (`lilv-devel`, `liblilv-dev` and `lv2-dev`). Where the CLAP and plugin-hostd
headers are not installed, `make deps` fetches both at their pinned release tags into `native/deps/`.
The measurer's sample rates are omx-contract's `OMX_DECLARED_RATES`: the header comes from
`pkg-config omx-contract` (`omx-contract-devel`, `libomx-contract-dev`), else `make deps` fetches it.
Its host features are omx-clap-core's LV2 feature provider, the static `libomx-clap-lv2` and its
header: `pkg-config omx-clap-lv2` (`omx-clap-lv2-devel`, `libomx-clap-lv2-dev`), else `make deps`
fetches omx-clap-core at the packages' floor, builds the archive against the fetched CLAP headers and
installs it into `native/deps/omx-clap-lv2`.

```
make -C native deps all   # native/build/clap-qualify, lv2_measure, rt_interpose.so, fixtures/
```

The native tests run the build; without it they skip, except on CI, where a missing build fails.
`make -C native asan` builds the measurer under AddressSanitizer, `native/build/asan/lv2_measure`,
which the leak check runs on every way out of it (a measurement, a soak, a plugin that will not
instantiate). It is not part of `all`, so a package build needs no libasan.

`make -C native install DESTDIR=... LIBEXECDIR=...` installs the prober, the measurer, the
interposer and the LV2 host probe (not the fixtures): exactly `NATIVE_TOOLS` in
`src/qualify-declarations.ts`. The host probe (`lv2_host_probe <bundle> [uri]`) loads a worker plugin
through lilv and drives it as a host does, so a console that exports an LV2 plugin tests that
plugin's host-facing half with it. The command
and `tools/lv2-measure.mjs` look for each by its setting (`OMX_CLAP_QUALIFY`, `OMX_LV2_MEASURE`,
`OMX_RT_INTERPOSE`), then in `native/build/`, then in the directories the packages install into
(`NATIVE_TOOL_DIRS`). An installed package has no `native/build/`; in a checkout, its own build wins
over an installed one. A tool and the interposer it runs under share `rt-interpose.h`, so the ones no
setting names come from one place, the first of those that holds either; a place holding only one of
them is refused rather than paired with the other from elsewhere.

The container image (`Containerfile`) bundles lilv, the distribution's mod-host and an
AddressSanitizer build of mod-host:

```
podman build -t plugin-qualify -f Containerfile .
```

## Packages

The npm package, the RPM and the DEB are made from this tree; a release is a `v<version>` tag.

```
npm pack --dry-run                                # the files npm would publish
packaging/build.sh "$PWD/root" /usr/lib           # the same files, installed into ./root
rpmbuild -ba packaging/plugin-qualify.spec        # needs the source tarball in ~/rpmbuild/SOURCES
dpkg-buildpackage -b -uc -us                      # the DEB
```

Both are built per architecture: they carry the CLAP prober, the LV2 measurer and their interposer,
in `/usr/libexec/plugin-qualify/` on Fedora and `/usr/lib/plugin-qualify/` on Debian. Their headers
come from packages, never from `make deps`: `clap-devel`, `lilv-devel`, `lv2-devel`,
`plugin-hostd-devel` and `omx-clap-lv2-devel` on Fedora, `clap-headers`, `liblilv-dev`, `lv2-dev`,
`plugin-hostd-dev` and `libomx-clap-lv2-dev` on Debian (`clap-headers`, `plugin-hostd-dev` and
`libomx-clap-lv2-dev` from the FreeMixer channel). An installed package is
checked with `packaging/check-installed.sh <rt-safe.clap> <rt-unsafe.clap> <lv2-fixture-dir>`, run
with nothing set.

There is no changelog file: git history is the changelog. `debian/changelog` and the spec's `%changelog`
are packaging metadata. Bump `version` in `package.json` and `Version:` in the spec together.

The tag publishes the RPM and DEB through the shared workflows of FreeMixer/.github and attaches the
`pnpm pack` tarball, `openmixer-plugin-qualify-<version>.tgz` with `dist/` built in, to the GitHub
release. Pull requests build both package kinds, install each in its distribution's container and run
`packaging/check-installed.sh` there, and pack the tarball, as a dry run that publishes nothing;
`node packaging/check-tarball.mjs <tarball>` checks it carries every `exports` target.

A version tag also publishes the npm package: `.github/workflows/publish.yml` publishes it by npm
trusted publishing (no token), with provenance; npmjs.com names this repository and that workflow file as
the package's trusted publisher. Run by hand, the workflow is a dry run unless asked otherwise.
