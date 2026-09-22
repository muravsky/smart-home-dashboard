#!/usr/bin/env bash
# ==============================================================================
# Google Compute Engine (GCE) Production Deployment Script
# Run this script on your GCE VM to register and run the service 24/7.
# ==============================================================================

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_NAME="$(whoami)"
NODE_BIN="$(which node || echo "/home/$USER_NAME/.nvm/versions/node/v22.23.2/bin/node")"

echo "=== Smart Home Dashboard GCE Deployment ==="
echo "Project Directory: $PROJECT_DIR"
echo "Running as User:   $USER_NAME"
echo "Node Binary:       $NODE_BIN"

# Check .env
if [ ! -f "$PROJECT_DIR/.env" ]; then
  echo "Creating .env from .env.example..."
  cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
  echo "Please edit $PROJECT_DIR/.env with your secrets!"
fi

# Create systemd service unit
SERVICE_FILE="/etc/systemd/system/smart-home.service"
echo "Generating systemd service definition..."

sudo bash -c "cat <<EOF > $SERVICE_FILE
[Unit]
Description=Smart Home Tablet Dashboard (Express + Socket.IO + Telegram)
After=network.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$PROJECT_DIR
ExecStart=$NODE_BIN src/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF"

echo "Reloading systemd daemon..."
sudo systemctl daemon-reload

echo "Enabling and starting smart-home.service..."
sudo systemctl enable smart-home
sudo systemctl restart smart-home

echo ""
echo "=== Deployment Successful! ==="
echo "Status: sudo systemctl status smart-home"
echo "Logs:   sudo journalctl -u smart-home -f"
echo ""
echo "Note: If your GCE firewall blocks port 3000, allow it via Google Cloud CLI:"
echo "gcloud compute firewall-rules create allow-smart-home --allow tcp:3000 --target-tags=smart-home-server"
