# ttyd-telegram-proxy

A Telegram Mini App authentication proxy for [ttyd](https://github.com/tsl0922/ttyd). Puts your web terminal behind Telegram's cryptographic auth so only you can access it.

## How It Works

```
┌─────────────┐     HTTPS     ┌──────────────────┐    HTTP     ┌──────────────┐
│  Telegram    │ ──────────── │  ttyd-telegram-   │ ─────────  │  ttyd        │
│  Mini App    │  (Funnel/    │  proxy (:8443)    │  localhost  │  (:8080)     │
│  in chat     │   reverse    │  validates auth   │   only      │  no auth     │
└─────────────┘   proxy)      └──────────────────┘             └──────────────┘
```

1. **ttyd** runs on `127.0.0.1:8080` with no authentication — it's unreachable from the internet
2. **ttyd-telegram-proxy** runs on `127.0.0.1:8443` — also unreachable directly
3. A reverse proxy (Tailscale Funnel, Cloudflare Tunnel, nginx, etc.) terminates HTTPS and forwards to `:8443`
4. When you open the Mini App in Telegram, the proxy receives [Telegram's `initData`](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app) — a cryptographically signed payload proving who you are
5. The proxy validates the HMAC-SHA256 signature using your bot token, checks the user ID matches `TELEGRAM_ALLOWED_USERS`, and sets a session cookie
6. With a valid session, all HTTP and WebSocket traffic is proxied through to ttyd

**If you open the URL in a regular browser** (not from Telegram), you see an auth page that says "This app must be opened from Telegram." — the `initData` is only available inside the Telegram client.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [ttyd](https://github.com/tsl0922/ttyd) installed and running
- A Telegram bot (created via [@BotFather](https://t.me/BotFather))
- An HTTPS reverse proxy to expose port 8443 publicly (Tailscale Funnel, Cloudflare Tunnel, Caddy, nginx, etc.)

## Setup

### 1. Create a Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot`, follow the prompts — you'll get a **bot token** like `123456789:AABBccDDeeFF...`
3. **Get your Telegram user ID**: message [@userinfobot](https://t.me/userinfobot) — it will reply with your numeric ID

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
TTYD_URL=http://127.0.0.1:8080                   # Where ttyd is running
PROXY_PORT=8443                                   # Port for the auth proxy
```

### 4. Configure ttyd (localhost only)

Make sure ttyd binds to localhost so it's not directly accessible:

```bash
ttyd --writable -i lo -p 8080 /bin/bash -l
```

The `-i lo` flag binds to the loopback interface only. A systemd unit is included — see `ttyd.service`.

### 5. Set Up HTTPS

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

### 6. Register the Mini App with Telegram

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

### 7. Run

**Directly:**
```bash
node server.js
```

**With systemd (recommended):**

Copy the service files to your user systemd directory:
```bash
cp ttyd.service ttyd-proxy.service ~/.config/systemd/user/
```

> **Note:** The service files use `%h` (home directory) specifiers. If your install path differs from `~/.hermes/ttyd-proxy/`, edit `ttyd-proxy.service` accordingly.

```bash
systemctl --user daemon-reload
systemctl --user enable --now ttyd ttyd-proxy
```

Check status:
```bash
systemctl --user status ttyd ttyd-proxy
```

## Security Model

| Layer | Protection |
|-------|------------|
| **ttyd** | Bound to `127.0.0.1` — unreachable from the network |
| **Proxy** | Bound to `127.0.0.1` — only the HTTPS reverse proxy can reach it |
| **Telegram initData** | HMAC-SHA256 validated with bot token — cryptographic proof of identity |
| **User ID check** | Only `TELEGRAM_ALLOWED_USERS` can authenticate |
| **Session cookies** | `HttpOnly`, `Secure`, `SameSite=None`, 24h TTL |
| **WebSocket auth** | Upgrade requests also checked for valid session cookie |
| **HTTPS** | TLS termination handled by the reverse proxy (Funnel/Cloudflare/etc.) |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | — | Bot token from BotFather |
| `TELEGRAM_ALLOWED_USERS` | ✅ | — | Your Telegram numeric user ID |
| `TTYD_URL` | | `http://127.0.0.1:8080` | ttyd backend URL |
| `PROXY_PORT` | | `8443` | Port for the proxy to listen on |

## Troubleshooting

**"This app must be opened from Telegram"** — You're accessing the URL directly in a browser. Open it through the bot's menu button in the Telegram app.

**Auth fails silently** — Check that `TELEGRAM_ALLOWED_USERS` matches your exact numeric user ID (not your username). Use [@userinfobot](https://t.me/userinfobot) to confirm.

**WebSocket disconnects** — Make sure your reverse proxy supports WebSocket upgrades. Tailscale Funnel and Cloudflare Tunnel handle this automatically.

**ttyd unavailable (502)** — The proxy can't reach ttyd. Check that ttyd is running on the configured port: `ss -tlnp | grep 8080`.

## License

MIT
