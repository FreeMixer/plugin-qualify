# SPDX-License-Identifier: GPL-3.0-or-later
# plugin-qualify in a box: lilv for the scan and the offline measurement, the distro's mod-host
# for the hosting sweep, and an ASan build of mod-host so a plugin's memory error is caught and
# attributed to the plugin.
#
#   podman build -t plugin-qualify -f Containerfile .
#   podman run --rm -v /usr/lib64/lv2:/usr/lib64/lv2:ro plugin-qualify <uri|bundle-path>
FROM registry.fedoraproject.org/fedora:44

RUN dnf -y install --setopt=install_weak_deps=False \
      nodejs npm python3 python3-lilv lilv lv2 mod-host \
      git gcc make pkgconf-pkg-config libasan \
      jack-audio-connection-kit-devel readline-devel fftw-devel lilv-devel \
    && dnf clean all

# mod-host with AddressSanitizer, symbolizable (no -s), beside the distro binary.
RUN git clone -q --depth 1 https://github.com/mod-audio/mod-host.git /opt/mod-host-src \
    && CFLAGS="-g -fsanitize=address -fno-omit-frame-pointer" LDFLAGS="-fsanitize=address" \
       make -C /opt/mod-host-src -j2 mod-host \
    && install -m 0755 /opt/mod-host-src/mod-host /usr/local/bin/mod-host-asan \
    && rm -rf /opt/mod-host-src

WORKDIR /opt/plugin-qualify
COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY src ./src
COPY bin ./bin
COPY tools ./tools
COPY fixtures ./fixtures
RUN npm install -g pnpm@10.33.0 && pnpm install --frozen-lockfile

ENTRYPOINT ["node", "/opt/plugin-qualify/bin/plugin-qualify.mjs"]
