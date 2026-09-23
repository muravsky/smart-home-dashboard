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

# Check if systemd is available
if [ ! -d /run/systemd/system ]; then
  echo ""
  echo "⚠️  NOTE: systemd is not active in this environment."
  echo "You appear to be running inside Google Cloud Shell (or a container/WSL),"
  echo "rather than inside your actual Compute Engine VM ('smart-home-kiosk')."
  echo ""
  echo "To connect to your real Compute Engine VM, run:"
  echo "  gcloud compute ssh smart-home-kiosk --zone=us-central1-a"
  echo ""
  echo "If you want to run the server here anyway, you can use PM2:"
  echo "  npx pm2 start src/server.js --name smart-home"
  echo "Or run in foreground:"
  echo "  npm start"
  exit 0
fi

# Create systemd service unit on real VM
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
