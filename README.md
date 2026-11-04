# plugin-qualify

Can this audio plugin be hosted in a real-time audio engine, and at what cost? `plugin-qualify`
scans an LV2 or CLAP plugin, measures it offline (latency and CPU cost per rate and quantum),
runs it under a real host, and gives one verdict. `plugin-qualify-sync` keeps a record for every
plugin installed on a machine, rescanning when a plugin directory changes.

## Install

Fedora 44 (x86_64, aarch64):

```
sudo dnf install https://www.openmixer.org/rpm/openmixer-release.noarch.rpm
sudo dnf install plugin-qualify
```

Debian bookworm and trixie, including Raspberry Pi OS (amd64, arm64):

```
curl -fsSLO https://www.openmixer.org/deb/openmixer-release.deb && sudo apt install ./openmixer-release.deb
sudo apt update
sudo apt install plugin-qualify
```

The npm package (`npm install -g @openmixer/plugin-qualify`) carries the TypeScript command only;
the native CLAP prober and LV2 measurer come with the RPM or DEB.

## Start

```
plugin-qualify urn:example:my-plugin          # one plugin, by URI
plugin-qualify ./my-plugin.lv2                # every plugin in a bundle
plugin-qualify --all --out ./qualification   # every installed LV2 and CLAP plugin, one record each
plugin-qualify compare --all --out ./compare  # every plugin under omx-clap-host, plugin-hostd, mod-host and jalv
plugin-qualify --help                         # every option and its default
```

Exit code: `0` every plugin qualified, `1` some did not, `2` something could not be measured.
`man plugin-qualify` and `man plugin-qualify-sync` describe the commands.

## Documentation

<https://www.openmixer.org/projects/plugin-qualify>, and in this repository the full guide
([docs/overview.md](docs/overview.md)): the measurement grid, the verdicts and what they mean,
host profiles, the JSON document, qualifying every plugin on a machine and keeping the records.
Building from a checkout: [BUILDING.md](BUILDING.md).

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE).
