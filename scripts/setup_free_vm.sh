#!/usr/bin/env bash
# ==============================================================================
# 1-Click Bootstrap Script for Google Cloud e2-micro Free Tier VM
# Run this directly on your new GCE VM after connecting via SSH!
# ==============================================================================

set -e

echo "=== Setting up Smart Home Dashboard on GCE e2-micro ==="

# 1. Setup 2GB Swap (CRITICAL for e2-micro 1GB RAM to prevent Out-Of-Memory)
if [ ! -f /swapfile ]; then
  echo "Creating 2GB swap file..."
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  echo "Swap configured successfully."
else
  echo "Swap file already exists."
fi

# 2. Update packages and install prerequisites
echo "Updating apt packages..."
sudo apt-get update -y
sudo apt-get install -y curl git ufw

# 3. Install Node.js 22 LTS
if ! command -v node >/dev/null 2>&1; then
  echo "Installing Node.js v22 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "Node version: $(node -v)"
echo "NPM version:  $(npm -v)"

# 4. Create App Directory
APP_DIR="$HOME/smart-home-dashboard"
if [ ! -d "$APP_DIR" ]; then
  mkdir -p "$APP_DIR"
fi

echo ""
echo "=== VM System Setup Complete! ==="
echo "Next steps:"
echo "1. Copy your project files to $APP_DIR"
echo "2. Create $APP_DIR/.env with your secrets"
echo "3. Run: cd $APP_DIR && npm install && ./scripts/deploy_gce.sh"
