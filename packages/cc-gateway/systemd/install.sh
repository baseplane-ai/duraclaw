#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="duraclaw-cc-gateway"
OLD_SERVICE_NAME="baseplane-cc-gateway"

echo "Installing ${SERVICE_NAME} systemd service..."

# Stop and disable old service if it exists
if systemctl list-unit-files "${OLD_SERVICE_NAME}.service" &>/dev/null; then
  echo "Stopping and disabling old ${OLD_SERVICE_NAME} service..."
  sudo systemctl stop "${OLD_SERVICE_NAME}" 2>/dev/null || true
  sudo systemctl disable "${OLD_SERVICE_NAME}" 2>/dev/null || true
  sudo rm -f "/etc/systemd/system/${OLD_SERVICE_NAME}.service"
fi

# Copy service file
sudo cp "${SCRIPT_DIR}/${SERVICE_NAME}.service" "/etc/systemd/system/${SERVICE_NAME}.service"

# Reload systemd
sudo systemctl daemon-reload

# Enable and start
sudo systemctl enable "${SERVICE_NAME}"
sudo systemctl start "${SERVICE_NAME}"

echo "Service installed and started."
echo ""
echo "Useful commands:"
echo "  sudo systemctl status ${SERVICE_NAME}"
echo "  sudo journalctl -u ${SERVICE_NAME} -f"
echo "  sudo systemctl restart ${SERVICE_NAME}"
