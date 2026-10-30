#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
#
# The scan after a plugin package is installed, upgraded or removed: the dpkg trigger (postinst triggered) and the
# rpm file trigger (%transfiletriggerin, %transfiletriggerpostun) both run this, once per transaction.
#
# With systemd running the scan is the plugin-qualify-sync service, started without waiting: the service has the
# unit's limits and the package transaction does not wait for a sweep. Without it (an image build, a chroot) a
# transaction never qualifies plugins itself (#237): a sweep of every plugin took 95 minutes inside an image build.
# The trigger leaves the pending marker (qualify-pending in the sync's state directory) and the next plugin-qualify-sync
# run scans and clears it. A scan that fails never fails the transaction: it says so on stderr and exits 0.
#
# PLUGIN_QUALIFY_SYSTEMD_RUN names the directory whose presence means systemd is running (/run/systemd/system).
# PLUGIN_QUALIFY_STATE_DIR names the sync's state directory (/var/lib/omx).
# PLUGIN_QUALIFY_SYNC_INLINE=1 runs the sync here at the lowest CPU priority, for a host with no systemd at all.

# rpm hands a file trigger the matched paths on stdin; the scan walks the folders itself
[ -t 0 ] || cat >/dev/null 2>&1

if [ -d "${PLUGIN_QUALIFY_SYSTEMD_RUN:-/run/systemd/system}" ]; then
	systemctl start --no-block plugin-qualify-sync.service ||
		echo "plugin-qualify: could not start plugin-qualify-sync.service; the next trigger or boot scans" >&2
elif [ "${PLUGIN_QUALIFY_SYNC_INLINE:-}" = "1" ]; then
	nice -n 19 plugin-qualify-sync --system ||
		echo "plugin-qualify: plugin-qualify-sync --system failed; run it again by hand or wait for the next trigger" >&2
else
	state="${PLUGIN_QUALIFY_STATE_DIR:-/var/lib/omx}"
	{ mkdir -p "$state" && : >"$state/qualify-pending"; } 2>/dev/null ||
		echo "plugin-qualify: could not leave $state/qualify-pending" >&2
	echo "plugin-qualify: no systemd; the next plugin-qualify-sync run scans (PLUGIN_QUALIFY_SYNC_INLINE=1 scans now)"
fi
exit 0
