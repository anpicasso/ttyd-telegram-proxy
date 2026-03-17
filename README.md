# tg-terminal

A Telegram Mini App that gives you a full terminal on your phone. Authenticates via Telegram's cryptographic initData, then connects you to a real PTY over WebSocket with xterm.js.

Built by **Yuqi** — a [Hermes Agent](https://github.com/NousResearch/hermes-agent) by [Nous Research](https://nousresearch.com), working with [Angello Picasso](https://github.com/anpicasso).

**Current use case:** Mobile server management for a Hermes Agent running on a remote Linux server — full terminal access from Telegram, anywhere.

## How It Works

```
┌─────────────┐     HTTPS     ┌──────────────────┐    PTY     ┌──────────────┐
│  Telegram    │ ──────────── │  tg-terminal      │ ────────── │  /bin/bash   │
│  Mini App    │  (Funnel/    │  xterm.js + auth  │  node-pty  │  (on-demand) │
│  in chat     │   reverse)   │  (:8443)          │            │              │
└─────────────┘               └──────────────────┘            └──────────────┘
```

1. You tap "Terminal" in Telegram — the auth page validates initData (HMAC-SHA256)
2. xterm.js initializes in-place — one spinner from auth through terminal ready
3. WebSocket connects, server spawns a PTY on first input
4. Full terminal: vim, htop, colors, resize, everything works
5. After 30 min idle (configurable), the PTY is killed automatically

## Features

- **Real terminal** — xterm.js + node-pty, full VT100/xterm emulation
- **On-demand PTY** — shell only runs when you're using it
- **Single page** — one loading spinner covers auth → init → connect
- **Responsive** — font size adapts to viewport (phones get ~45 cols, tablets/desktop ~80)
- **Right-side button bar** — arrows (▲▼◀▶) + clipboard (Select, Copy, Paste)
- **Keyboard-aware** — buttons shrink to S/C/P when the keyboard is open
- **Themed** — dark purple-accent UI
- **Session reuse** — reconnects pick up the same PTY
- **Idle timeout** — auto-kills PTY after configurable inactivity

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- A C compiler (for node-pty native addon)
- A Telegram bot ([@BotFather](https://t.me/BotFather))
- HTTPS reverse proxy (Tailscale Funnel, Cloudflare Tunnel, Caddy, etc.)

## Setup

### 1. Create a Telegram Bot

1. Message [@BotFather](https://t.me/BotFather), send `/newbot`
2. Get your **bot token**
3. Get your **user ID** from [@userinfobot](https://t.me/userinfobot)

### 2. Install

```bash
git clone https://github.com/anpicasso/tg-terminal.git
cd tg-terminal
npm install
```

### 3. Configure

```bash
cp .env.example .env
# Edit .env with your bot token and user ID
```

### 4. HTTPS

```bash
# Tailscale Funnel (easiest)
sudo tailscale funnel --bg 8443

# Or Cloudflare Tunnel
cloudflared tunnel --url http://127.0.0.1:8443
```

### 5. Register Mini App

```bash
curl "https://api.telegram.org/bot<TOKEN>/setChatMenuButton" \
  -H "Content-Type: application/json" \
  -d '{"chat_id":<USER_ID>,"menu_button":{"type":"web_app","text":"Terminal","web_app":{"url":"https://<YOUR_URL>/"}}}'
```

### 6. Run

```bash
node server.js

# Or with systemd
cp ttyd-proxy.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ttyd-proxy
```

## Mobile UX

The terminal has a right-side button bar that stays the same height as the terminal:

```
┌─────────────────────┬────┐
│                     │ ▲  │
│                     │ ▼  │
│     terminal        │ ◀  │
│                     │ ▶  │
│                     │────│
│                     │Sel │
│                     │Copy│
│                     │Paste│
└─────────────────────┴────┘
```

When the keyboard opens, buttons shrink to `S`, `C`, `P` to save space.

Clipboard works through the toolbar — xterm.js renders to canvas, so native text selection doesn't apply.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | — | Bot token from BotFather |
| `TELEGRAM_ALLOWED_USERS` | ✅ | — | Your Telegram user ID |
| `PROXY_PORT` | | `8443` | Port for the server |
| `TTYD_SHELL` | | `/bin/bash` | Shell to spawn |
| `TTYD_IDLE_TIMEOUT` | | `1800` | Seconds idle before killing PTY |

## Security

| Layer | Protection |
|-------|------------|
| Telegram initData | HMAC-SHA256 validated |
| User ID | Only allowed user can auth |
| Session cookie | HttpOnly, Secure, SameSite=None, 24h TTL |
| WebSocket | Session cookie required for upgrade |
| Bind address | 127.0.0.1 only (requires HTTPS reverse proxy) |
| Idle timeout | PTY auto-killed after inactivity |

## Credits

Built by **Yuqi** ([Hermes Agent](https://github.com/NousResearch/hermes-agent) by [Nous Research](https://nousresearch.com)), the AI assistant of [Angello Picasso](https://github.com/anpicasso). Yuqi handles infrastructure, development, and server management through [Hermes](https://github.com/NousResearch/hermes-agent) — and this terminal is how Angello manages the server she runs on, from his phone.

## License

MIT
