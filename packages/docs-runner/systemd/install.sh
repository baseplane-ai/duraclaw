#!/usr/bin/env bash
#
# Installs the Duraclaw docs-runner systemd *template* unit on this host
# (GH#27 P1.8). Mirrors packages/agent-gateway/systemd/install.sh.
#
# Unlike the agent-gateway service, this is a template — `%i` is the
# projectId. Installing the template does NOT enable any instances. After
# install, enable one instance per project owning a docs-runner:
#
#   sudo systemctl enable --now duraclaw-docs-runner@<projectId>.service
#
# Prereqs: Linux + systemd, sudo, the docs-runner binary on disk at the
# path in `ExecStart=` (default `/usr/local/lib/duraclaw/docs-runner`). If
# your binary lives elsewhere, drop in
# `/etc/systemd/system/duraclaw-docs-runner@.service.d/override.conf` with
# `[Service]\nExecStart=` (empty) followed by the right `ExecStart=` line,
# OR edit the installed unit in place before `daemon-reload`.
#
# This script is intended for the local-tray launcher (spec 0015). On the
# v1 VPS the docs-runner is spawned lazily by the agent-gateway, not by
# systemd; you do not need to run this on the gateway host.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="duraclaw-docs-runner@"

echo "Installing ${SERVICE_NAME}.service systemd template unit..."

# Copy template service file. Note the trailing `@` — that's part of the
# template filename, NOT a shell artifact. `cp` accepts it literally.
sudo cp "${SCRIPT_DIR}/${SERVICE_NAME}.service" "/etc/systemd/system/${SERVICE_NAME}.service"

# Reload systemd so the new template is visible.
sudo systemctl daemon-reload

echo "Template unit installed."
echo ""
echo "Per-project enable (one instance per projectId):"
echo "  sudo systemctl enable --now duraclaw-docs-runner@<projectId>.service"
echo ""
echo "Useful commands (substitute <projectId>):"
echo "  sudo systemctl status duraclaw-docs-runner@<projectId>"
echo "  sudo journalctl -u duraclaw-docs-runner@<projectId> -f"
echo "  sudo systemctl restart duraclaw-docs-runner@<projectId>"
echo "  sudo systemctl disable --now duraclaw-docs-runner@<projectId>"
