# Smart Home Tablet Dashboard

A lightweight, robust Smart Home Dashboard designed to run 24/7 on a wall-mounted tablet in Chromium kiosk mode, hosted on a Google Compute Engine (GCE) VM.

## 🚀 Key Features

- **Dark Monochrome Kiosk UI**: High-contrast, OLED-friendly, glare-free aesthetic built with Vue 3 (CDN) and Tailwind CSS (CDN). Zero build tools.
- **Large Clock & Date**: Glanceable typography with ticking second pulse and localized dates.
- **Inactivity Sleep Mode**: Automatically fades out all UI elements to a dim, ambient clock after 5 minutes of no touch/click activity to prevent screen burn-in and save power. Tapping the screen instantly wakes the dashboard.
- **Dual Security Layers**:
  - **Main Dashboard (`/`)**: Guarded by a static URL token query parameter (`/?token=your_secret_token`). Returns `403 Forbidden` for invalid or missing tokens.
  - **Admin Console (`/admin`)**: Guarded with HTTP Basic Authentication (`ADMIN_PASS`).
- **Real-Time Synchronization**: Bidirectional Socket.IO live updates. Any update from Telegram, Admin, or interactive tablet taps is immediately pushed to all connected screens.
- **Interactive Tasks**: Tap any task directly on the tablet screen to mark it completed.
- **Telegram + Gemini 1.5 Flash**: Natural language messages sent to your Telegram bot are parsed via Google Gemini API into strict raw JSON and stored into SQLite tables (`notes`, `tasks`).

---

## 🛠️ Tech Stack

- **Backend**: Node.js v22 LTS, Express.js, Socket.IO, `express-basic-auth`
- **Database**: SQLite3 via `better-sqlite3` (WAL mode enabled)
- **Frontend**: Vanilla HTML/JS, Vue 3 Composition API (CDN), Tailwind CSS (CDN), Socket.IO (CDN)
- **Telegram**: `telegraf` with strict sender ID whitelist filter
- **AI Engine**: `@google/generative-ai` (Gemini 1.5 Flash)

---

## ⚙️ Configuration (`.env`)

```env
PORT=3000

# Kiosk Tablet Token
DASHBOARD_TOKEN=your_secret_token

# Admin Console Basic Auth
ADMIN_PASS=your_admin_pass

# Telegram Bot (from @BotFather)
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz

# Comma-separated list of authorized Telegram user IDs (strictly enforced)
TELEGRAM_WHITELIST_IDS=123456789,987654321

# Google Gemini API Key (from Google AI Studio)
GEMINI_API_KEY=your_gemini_api_key
```

---

## 🏃 Quick Start

### 1. Start the Server
```bash
npm start
```
Or with auto-restart on changes:
```bash
npm run dev
```

### 2. Access the Tablet Kiosk Dashboard
Open in your tablet browser:
```
http://<YOUR_IP>:3000/?token=your_secret_token
```

### 3. Access the Admin Console
Open in your browser:
```
http://<YOUR_IP>:3000/admin
```
- **Username**: `admin`
- **Password**: `your_admin_pass` (configured via `ADMIN_PASS` in `.env`)

---

## 📱 Tablet Chromium Kiosk Mode Setup

To run Chromium in true fullscreen kiosk mode on Linux/Raspberry Pi/Tablet:

```bash
chromium-browser \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --check-for-update-interval=31536000 \
  --disable-translate \
  --overscroll-history-navigation=0 \
  "http://<YOUR_SERVER_IP>:3000/?token=your_secret_token"
```

---

## ☁️ Google Compute Engine (GCE) 24/7 Deployment

### Systemd Service Configuration
Create `/etc/systemd/system/smart-home.service`:

```ini
[Unit]
Description=Smart Home Tablet Dashboard
After=network.target

[Service]
Type=simple
User=muravsky
WorkingDirectory=/home/muravsky/.gemini/antigravity/scratch/smart-home-dashboard
ExecStart=/home/muravsky/.nvm/versions/node/v22.23.2/bin/node src/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable smart-home
sudo systemctl start smart-home
```

---

## 🧪 Running Automated Tests

Run the full automated verification suite:

```bash
# Phase 1: Security, token auth, basic auth & socket
node tests/test_phase1.js

# Phase 2: SQLite database, Gemini schema & live broadcast
node tests/test_phase2.js

# Full System: Admin CRUD & interactive tablet socket toggles
node tests/test_full_system.js
```
