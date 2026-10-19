#!/usr/bin/env bash
# ==============================================================================
# Smart Home Dashboard — HTTPS / SSL Certificate Setup Helper
# Supports:
#   1. Let's Encrypt certificate via Certbot for a public DNS name:
#      sudo ./scripts/setup_https.sh your-domain.example.com [your-email@example.com] [port]
#   2. Local / Self-Signed certificate for LAN DNS or IP:
#      ./scripts/setup_https.sh --self-signed your-domain.local [port]
# ==============================================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERTS_DIR="${APP_DIR}/certs"
DB_PATH="${DB_PATH:-${APP_DIR}/data/smart_home.db}"

usage() {
  cat <<EOF
Usage:
  1) Let's Encrypt (Public DNS pointing to this server):
     sudo ./scripts/setup_https.sh <dns-domain> [email] [https-port]

  2) Self-Signed Certificate (Local DNS / LAN / Home Server):
     ./scripts/setup_https.sh --self-signed <dns-domain-or-ip> [https-port]

Examples:
  sudo ./scripts/setup_https.sh home.example.com admin@example.com 443
  ./scripts/setup_https.sh --self-signed dashboard.lan 3443
EOF
}

if [[ "${1:-}" == "" || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

mkdir -p "${CERTS_DIR}"
CERT_FILE="${CERTS_DIR}/fullchain.pem"
KEY_FILE="${CERTS_DIR}/privkey.pem"

update_db_https_settings() {
  local port="$1"
  node -e "
    const { updateSettings } = require('${APP_DIR}/src/db');
    updateSettings({
      https_enabled: 1,
      https_port: Number('${port}') || 443,
      https_cert_path: '${CERT_FILE}',
      https_key_path: '${KEY_FILE}',
      https_redirect_http: 1
    });
    console.log('[DB] Updated HTTPS settings in SQLite database.');
  "
}

if [[ "${1:-}" == "--self-signed" ]]; then
  DOMAIN="${2:-localhost}"
  HTTPS_PORT="${3:-3443}"
  echo "==> Generating self-signed certificate for '${DOMAIN}'..."
  openssl req -x509 -nodes -newkey rsa:2048 \
    -days 365 \
    -keyout "${KEY_FILE}" \
    -out "${CERT_FILE}" \
    -subj "/CN=${DOMAIN}" \
    -addext "subjectAltName=DNS:${DOMAIN},DNS:localhost,IP:127.0.0.1"
  chmod 600 "${KEY_FILE}"
  update_db_https_settings "${HTTPS_PORT}"
  echo "==> Done! Certificate saved to ${CERT_FILE}"
  echo "==> Restart your dashboard server to serve HTTPS on port ${HTTPS_PORT}."
  exit 0
fi

DOMAIN="$1"
EMAIL="${2:-}"
HTTPS_PORT="${3:-443}"

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: Let's Encrypt / Certbot mode requires root privileges. Run with sudo:"
  echo "  sudo $0 $*"
  exit 1
fi

if ! command -v certbot >/dev/null 2>&1; then
  echo "==> Installing certbot..."
  apt-get update && apt-get install -y certbot
fi

EMAIL_ARGS="--register-unsafely-without-email"
if [[ -n "${EMAIL}" ]]; then
  EMAIL_ARGS="--email ${EMAIL}"
fi

echo "==> Requesting Let's Encrypt certificate for ${DOMAIN}..."
certbot certonly --standalone --non-interactive --agree-tos ${EMAIL_ARGS} -d "${DOMAIN}"

LE_LIVE_DIR="/etc/letsencrypt/live/${DOMAIN}"
cp -L "${LE_LIVE_DIR}/fullchain.pem" "${CERT_FILE}"
cp -L "${LE_LIVE_DIR}/privkey.pem" "${KEY_FILE}"

OWNER_USER="${SUDO_USER:-$(stat -c '%U' "${APP_DIR}")}"
chown -R "${OWNER_USER}:${OWNER_USER}" "${CERTS_DIR}"
chmod 644 "${CERT_FILE}"
chmod 600 "${KEY_FILE}"

# Create Certbot renewal deploy-hook so renewed certificates are copied automatically
HOOK_PATH="/etc/letsencrypt/renewal-hooks/deploy/smart-home-dashboard.sh"
mkdir -p "$(dirname "${HOOK_PATH}")"
cat > "${HOOK_PATH}" <<EOF
#!/usr/bin/env bash
cp -L "${LE_LIVE_DIR}/fullchain.pem" "${CERT_FILE}"
cp -L "${LE_LIVE_DIR}/privkey.pem" "${KEY_FILE}"
chown "${OWNER_USER}:${OWNER_USER}" "${CERT_FILE}" "${KEY_FILE}"
chmod 600 "${KEY_FILE}"
systemctl restart smart-home 2>/dev/null || true
EOF
chmod +x "${HOOK_PATH}"

# Allow Node binary to bind to privileged ports (<1024) like 443 and 80 without running as root
NODE_BIN="$(readlink -f "$(command -v node)")"
if command -v setcap >/dev/null 2>&1 && [[ -n "${NODE_BIN}" ]]; then
  setcap 'cap_net_bind_service=+ep' "${NODE_BIN}" || true
fi

sudo -u "${OWNER_USER}" node -e "
  const { updateSettings } = require('${APP_DIR}/src/db');
  updateSettings({
    https_enabled: 1,
    https_port: Number('${HTTPS_PORT}') || 443,
    https_cert_path: '${CERT_FILE}',
    https_key_path: '${KEY_FILE}',
    https_redirect_http: 1
  });
  console.log('[DB] Updated HTTPS settings in SQLite database.');
"

echo "============================================================"
echo " HTTPS configured for https://${DOMAIN}:${HTTPS_PORT}"
echo " Cert: ${CERT_FILE}"
echo " Key:  ${KEY_FILE}"
echo " Restart the dashboard service to apply:"
echo "   sudo systemctl restart smart-home   (or: pm2 restart all)"
echo "============================================================"
