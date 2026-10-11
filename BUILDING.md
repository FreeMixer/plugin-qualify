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

The CLAP prober, its interposer and the two fixture plugins its tests qualify (a known RT-safe and
a known RT-unsafe gain) are C, built with make. The CLAP headers come from `pkg-config clap`
(Fedora `clap-devel`) and plugin-hostd's `pin.h` from `pkg-config plugin-hostd`; where those are
not installed, `make deps` fetches both at their pinned release tags into `native/deps/`:

```
make -C native deps all   # native/build/clap-qualify, rt_interpose.so, fixtures/rt-{safe,unsafe}.clap
```

The CLAP tests run the build; without it they skip, except on CI, where a missing build fails.

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

There is no changelog file: git history is the changelog. `debian/changelog` and the spec's `%changelog`
are packaging metadata. Bump `version` in `package.json` and `Version:` in the spec together.

The tag publishes the RPM and DEB through the shared workflows of FreeMixer/.github and attaches the
`pnpm pack` tarball, `openmixer-plugin-qualify-<version>.tgz` with `dist/` built in, to the GitHub
release. Pull requests build both package kinds and pack the tarball as a dry run and publish nothing;
`node packaging/check-tarball.mjs <tarball>` checks it carries every `exports` target.

The npm package is not published yet. `.github/workflows/publish-npm.yml` publishes it by npm trusted
publishing (no token) when run by hand; npm accepts a trusted publisher only for a name that already
exists, so the owner publishes a placeholder and sets the trusted publisher on npmjs.com first, then
the workflow can be moved back to the tag.
