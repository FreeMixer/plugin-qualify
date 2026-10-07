# Building plugin-qualify

You need Node.js 22 or newer and pnpm 10 (`npm install -g pnpm@10`, or `corepack enable`). The
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
node tools/gen-python-declarations.mjs
```

The container image (`Containerfile`) bundles lilv, the distribution's mod-host and an
AddressSanitizer build of mod-host:

```
podman build -t plugin-qualify -f Containerfile .
```
