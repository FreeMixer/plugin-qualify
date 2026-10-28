#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
#
# The scan after a plugin package is installed, upgraded or removed: the dpkg trigger (postinst triggered) and the
# rpm file trigger (%transfiletriggerin, %transfiletriggerpostun) both run this, once per transaction.
#
# With systemd running the scan is the plugin-qualify-sync service, started without waiting: the service has the
# unit's limits and the package transaction does not wait for a sweep. Without it (an image build, a chroot) the
# sync runs here, at the lowest CPU priority. A scan that fails never fails the transaction: it says so on stderr
# and exits 0; the timer's next run and the next trigger scan again.
#
# PLUGIN_QUALIFY_SYSTEMD_RUN names the directory whose presence means systemd is running (/run/systemd/system).

# rpm hands a file trigger the matched paths on stdin; the scan walks the folders itself
[ -t 0 ] || cat >/dev/null 2>&1

if [ -d "${PLUGIN_QUALIFY_SYSTEMD_RUN:-/run/systemd/system}" ]; then
	systemctl start --no-block plugin-qualify-sync.service ||
		echo "plugin-qualify: could not start plugin-qualify-sync.service; the next trigger or boot scans" >&2
else
	nice -n 19 plugin-qualify-sync --system ||
		echo "plugin-qualify: plugin-qualify-sync --system failed; run it again by hand or wait for the next trigger" >&2
fi
exit 0
