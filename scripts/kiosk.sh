#!/usr/bin/env bash
# ==============================================================================
# Tablet Chromium Kiosk Launcher & Watchdog
# Run this script on your tablet (e.g. via ~/.xsession, systemd, or autostart)
# ==============================================================================

# Target dashboard URL with security token (edit this or pass as $1)
DASHBOARD_URL="${1:-http://localhost:3000/?token=your_secret_token}"

echo "Starting Smart Home Kiosk targeting: $DASHBOARD_URL"

# Disable screen blanking, screensaver, and energy saving power management
if command -v xset >/dev/null 2>&1; then
  xset s off
  xset -dpms
  xset s noblank
fi

# Hide mouse cursor after 0.5s of inactivity if unclutter is installed
if command -v unclutter >/dev/null 2>&1; then
  unclutter -idle 0.5 -root &
fi

# Detect chromium executable
CHROME_BIN=""
for bin in chromium-browser chromium google-chrome google-chrome-stable; do
  if command -v "$bin" >/dev/null 2>&1; then
    CHROME_BIN="$bin"
    break
  fi
done

if [ -z "$CHROME_BIN" ]; then
  echo "Error: Chromium/Chrome browser not found on system."
  exit 1
fi

echo "Using browser: $CHROME_BIN"

# Continuous watchdog loop: if Chromium exits or crashes, restart it automatically
while true; do
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Launching Chromium Kiosk..."
  
  "$CHROME_BIN" \
    --kiosk \
    --noerrdialogs \
    --disable-infobars \
    --no-first-run \
    --fast \
    --fast-start \
    --disable-features=Translate \
    --check-for-update-interval=31536000 \
    --overscroll-history-navigation=0 \
    --touch-events=enabled \
    --simulate-outdated-no-au='Tue, 31 Dec 2099 23:59:59 GMT' \
    "$DASHBOARD_URL"

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Chromium closed. Relaunching in 3 seconds..."
  sleep 3
done
