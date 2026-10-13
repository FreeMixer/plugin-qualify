# Building plugin-qualify

You need Node.js 20 or newer (the tool itself runs on 18) and pnpm 10 (`npm install -g pnpm@10`, or `corepack enable`). The
Python tools need Python 3 and, to scan real plugins, the lilv bindings (`python3-lilv` on Fedora,
`python3-lilv` on Debian). The tests use `pytest`.

```
pnpm install            # also compiles src/ into dist/
pnpm test               # the TypeScript tests
pnpm lint               # type-check everything, tests included
pnpm check:generated    # tools/_declarations.py matches src/qualify-declarations.ts
pnpm test:py            # the Python tools' tests
```

`tools/_declarations.py` is generated from `src/qualify-declarations.ts` so the Python scanner and
benchmark read the same rates, quanta and timeouts as the TypeScript code. After changing the
declarations, regenerate it and commit both:

```
node tools/gen-python-declarations.mjs --write
```

The CLAP prober, the LV2 measurer (`lv2_measure`, taken in from openmixer), their interposer and
the fixture plugins their tests qualify (a known RT-safe and a known RT-unsafe gain, as a `.clap` and
as an LV2 bundle, and the LV2 bundle `host-faithfulness.lv2`, five plugins that each need one thing of
the measuring host: options, a worker, patch:Set, a bounded sweep, a stdout of their own) are C, built
with make. The CLAP headers come from `pkg-config clap` (Fedora
`clap-devel`), plugin-hostd's `pin.h` from `pkg-config plugin-hostd`, lilv and the LV2 headers from
`pkg-config lilv-0` (`lilv-devel`, `liblilv-dev` and `lv2-dev`). Where the CLAP and plugin-hostd
headers are not installed, `make deps` fetches both at their pinned release tags into `native/deps/`.
It also fetches the omx-contract header that openmixer's copy of the LV2 measurer reads (kept in
`native/parity/openmixer` as it was at the commit it was taken from, each file's blob id in `BLOBS`),
so the build carries that copy, `native/build/parity/lv2_measure`, beside ours:

```
make -C native deps all   # native/build/clap-qualify, lv2_measure, rt_interpose.so, fixtures/
```

The native tests run the build; without it they skip, except on CI, where a missing build fails. The
parity test runs both LV2 measurers on the fixture bundles and wants the same bytes from each, once
the two things only ours prints are taken out of its line: the `host` object and the soak's
`maxRmsDbfs` (the soak case lifts the sweep's bound, so both sweep the same range).
`make -C native asan` builds the measurer under AddressSanitizer, `native/build/asan/lv2_measure`,
which the leak check runs on every way out of it (a measurement, a soak, a plugin that will not
instantiate). It is not part of `all`, so a package build needs no libasan.

`make -C native install DESTDIR=... LIBEXECDIR=...` installs the prober, the measurer and the
interposer (not the fixtures): exactly `NATIVE_TOOLS` in `src/qualify-declarations.ts`. The command
and `tools/lv2-measure.mjs` look for each by its setting (`OMX_CLAP_QUALIFY`, `OMX_LV2_MEASURE`,
`OMX_RT_INTERPOSE`), then in the directories the packages install into (`NATIVE_TOOL_DIRS`), then in
`native/build/`.

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
come from packages, never from `make deps`: `clap-devel`, `lilv-devel`, `lv2-devel` and
`plugin-hostd-devel` on Fedora, `clap-headers`, `liblilv-dev`, `lv2-dev` and `plugin-hostd-dev` on
Debian (`clap-headers` and `plugin-hostd-dev` from the FreeMixer channel). An installed package is
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
