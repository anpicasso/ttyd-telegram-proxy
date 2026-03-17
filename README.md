# ttyd-telegram-proxy

A Telegram Mini App authentication proxy for [ttyd](https://github.com/tsl0922/ttyd). Puts your web terminal behind Telegram's cryptographic auth so only you can access it.

## How It Works

```
┌─────────────┐     HTTPS     ┌──────────────────┐  spawns   ┌──────────────┐
│  Telegram    │ ──────────── │  ttyd-telegram-   │ ───────── │  ttyd        │
│  Mini App    │  (Funnel/    │  proxy (:8443)    │  on       │  (:8080)     │
│  in chat     │   reverse    │  auth + manage    │  demand   │  localhost   │
└─────────────┘   proxy)      └──────────────────┘           └──────────────┘
```

1. **ttyd is not running** until you open the Mini App
2. You tap "Terminal" in Telegram — the auth page loads and sends your viewport width
3. The proxy validates [Telegram's `initData`](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app) (HMAC-SHA256), checks your user ID, and **spawns ttyd with the right font size** for your screen
4. A session cookie is set and you're proxied through to ttyd
5. Subsequent opens reuse the same ttyd instance (single session)
6. After 30 minutes of inactivity (configurable), ttyd is automatically killed

**If you open the URL in a regular browser** (not Telegram), you see "This app must be opened from Telegram."

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [ttyd](https://github.com/tsl0922/ttyd) installed (but **not** running — the proxy manages it)
- A Telegram bot (created via [@BotFather](https://t.me/BotFather))
- An HTTPS reverse proxy (Tailscale Funnel, Cloudflare Tunnel, Caddy, nginx, etc.)

## Setup

### 1. Create a Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot`, follow the prompts — you'll get a **bot token** like `123456789:AABBccDDeeFF...`
3. **Get your Telegram user ID**: message [@userinfobot](https://t.me/userinfobot) — it replies with your numeric ID

### 2. Install

```bash
git clone https://github.com/anpicasso/ttyd-telegram-proxy.git
cd ttyd-telegram-proxy
npm install
```

### 3. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
TELEGRAM_BOT_TOKEN=123456789:AABBccDDeeFF...   # From BotFather
TELEGRAM_ALLOWED_USERS=123456789                 # Your Telegram user ID
TTYD_PORT=8080                                   # Port for ttyd (localhost)
PROXY_PORT=8443                                  # Port for the auth proxy
TTYD_BIN=ttyd                                    # Path to ttyd binary
TTYD_SHELL=/bin/bash                             # Shell to launch
TTYD_IDLE_TIMEOUT=1800                           # Kill ttyd after N seconds idle
```

### 4. Set Up HTTPS

The proxy must be served over HTTPS (Telegram Mini Apps require it). Pick one:

**Tailscale Funnel** (easiest, no domain needed):
```bash
sudo tailscale funnel --bg 8443
# Your URL: https://<hostname>.tail<xxxxx>.ts.net
```

**Cloudflare Tunnel**:
```bash
cloudflared tunnel --url http://127.0.0.1:8443
```

**Caddy** (with a domain):
```
your-domain.com {
    reverse_proxy 127.0.0.1:8443
}
```

### 5. Register the Mini App with Telegram

Set your bot's menu button to open the Mini App:

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setChatMenuButton" \
  -H "Content-Type: application/json" \
  -d '{
    "chat_id": <YOUR_USER_ID>,
    "menu_button": {
      "type": "web_app",
      "text": "Terminal",
      "web_app": {
        "url": "https://<YOUR_HTTPS_URL>/"
      }
    }
  }'
```

Now open your bot's chat in Telegram — you'll see a **"Terminal"** button at the bottom.

### 6. Run

**Directly:**
```bash
node server.js
```

**With systemd (recommended):**

```bash
mkdir -p ~/.config/systemd/user
cp ttyd-proxy.service ~/.config/systemd/user/
```

> **Note:** The service file uses `%h` (home directory). Edit paths if your install differs from `~/.hermes/ttyd-proxy/`.

```bash
systemctl --user daemon-reload
systemctl --user enable --now ttyd-proxy
```

Check status:
```bash
systemctl --user status ttyd-proxy
```

> **Do not** run ttyd as a separate service. The proxy spawns and manages it automatically.

## Responsive Font Sizing

The auth page measures your viewport width and sends it to the server. The proxy calculates an optimal font size (targeting ~80 columns) and spawns ttyd with `-t fontSize=N`. The font size is clamped between 10px and 22px.

Since ttyd's font size is set at spawn time via xterm.js options, the terminal renders at the right size from the first frame — no post-load resizing flicker.

## Mobile Toolbar

xterm.js captures all touch events, which prevents native iOS/Android text selection and arrow key input. The wrapper page includes a compact bottom toolbar:

```
[ ▲ ][ ▼ ][ ◀ ][ ▶ ][ Sel ][ Copy ][ Paste ][ A↓ ][ A↑ ]
```

- **Arrow keys** (▲ ▼ ◀ ▶) — send escape sequences to the terminal (history navigation, cursor movement)
- **Sel** — select all visible terminal buffer text
- **Copy** — copy current selection to clipboard (with fallback for restricted WebView contexts)
- **Paste** — read from clipboard and send to the terminal
- **A↓ / A↑** — decrease/increase font size on the fly (6px–30px, with toast feedback)

Font size adjustments are live — no need to restart ttyd. The toolbar resizes the terminal iframe to avoid overlap.

## Security Model

| Layer | Protection |
|-------|------------|
| **ttyd** | Only runs when needed, bound to `127.0.0.1`, no auth (unreachable from network) |
| **Proxy** | Bound to `127.0.0.1` — only the HTTPS reverse proxy can reach it |
| **Telegram initData** | HMAC-SHA256 validated with bot token — cryptographic proof of identity |
| **User ID check** | Only `TELEGRAM_ALLOWED_USERS` can authenticate |
| **Session cookies** | `HttpOnly`, `Secure`, `SameSite=None`, 24h TTL |
| **WebSocket auth** | Upgrade requests also require valid session cookie |
| **Idle timeout** | ttyd auto-kills after configurable inactivity period (default: 30 min) |
| **HTTPS** | TLS termination by the reverse proxy |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | — | Bot token from BotFather |
| `TELEGRAM_ALLOWED_USERS` | ✅ | — | Your Telegram numeric user ID |
| `TTYD_PORT` | | `8080` | Port ttyd listens on (localhost) |
| `PROXY_PORT` | | `8443` | Port for the proxy |
| `TTYD_BIN` | | `ttyd` | Path to ttyd binary |
| `TTYD_SHELL` | | `/bin/bash` | Shell to spawn |
| `TTYD_IDLE_TIMEOUT` | | `1800` | Seconds of inactivity before killing ttyd |

## Troubleshooting

**"This app must be opened from Telegram"** — You're accessing the URL directly. Open it through the bot's menu button in Telegram.

**"Failed to start terminal"** — Check that `TTYD_BIN` points to a valid ttyd binary. Run `ttyd --version` to verify.

**WebSocket disconnects** — Make sure your reverse proxy supports WebSocket upgrades. Tailscale Funnel and Cloudflare Tunnel handle this automatically.

**Terminal closes after 30 min** — That's the idle timeout. Set `TTYD_IDLE_TIMEOUT` higher in `.env`, or the keep-alive ping in the wrapper page prevents it while the tab is open.

## License

MIT
