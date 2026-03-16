#!/usr/bin/env node
/**
 * ttyd-telegram-proxy
 * 
 * Telegram Mini App that authenticates via initData,
 * then proxies to a local ttyd instance.
 * 
 * ttyd must bind to 127.0.0.1 only — this proxy is the
 * sole public entry point.
 */

const http = require('http');
const crypto = require('crypto');
const url = require('url');
const httpProxy = require('http-proxy');

// --- Config ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_ID = parseInt(process.env.TELEGRAM_ALLOWED_USERS || '0', 10);
const TTYD_TARGET = process.env.TTYD_URL || 'http://127.0.0.1:8080';
const PORT = parseInt(process.env.PROXY_PORT || '8443', 10);
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

if (!BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

// --- Session store ---
const sessions = new Map(); // token -> { userId, expires }

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { userId, expires: Date.now() + SESSION_TTL_MS });
  return token;
}

function checkSession(cookieHeader) {
  if (!cookieHeader) return false;
  const match = cookieHeader.match(/ttyd_session=([^;]+)/);
  if (!match) return false;
  const token = match[1];
  const sess = sessions.get(token);
  if (!sess) return false;
  if (Date.now() > sess.expires) {
    sessions.delete(token);
    return false;
  }
  return true;
}

// Cleanup expired sessions every 10 min
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now > v.expires) sessions.delete(k);
  }
}, 600_000);

// --- Telegram initData validation ---
function validateInitData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;

    // Build data-check-string: sorted key=value pairs (decoded) joined by \n
    const sortedPairs = [...params.entries()]
      .filter(([k]) => k !== 'hash')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`);
    const dataCheckString = sortedPairs.join('\n');

    // secret_key = HMAC-SHA256(key="WebAppData", data=bot_token)
    const secretKey = crypto.createHmac('sha256', 'WebAppData')
      .update(BOT_TOKEN).digest();

    // computed_hash = HMAC-SHA256(key=secret_key, data=data_check_string)
    const computed = crypto.createHmac('sha256', secretKey)
      .update(dataCheckString).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hash, 'hex'))) {
      return null;
    }

    // Check auth_date freshness (1 hour tolerance)
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (Math.abs(Date.now() / 1000 - authDate) > 3600) return null;

    // Check user
    const userJson = params.get('user');
    if (!userJson) return null;
    const user = JSON.parse(userJson);
    if (user.id !== ALLOWED_USER_ID) return null;

    return user;
  } catch {
    return null;
  }
}

// --- Auth HTML ---
const AUTH_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
  <title>Terminal</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body {
      background: #0e0e1a;
      color: #c8c8d4;
      font-family: -apple-system, system-ui, 'Segoe UI', sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      overflow: hidden;
    }
    .wrap { text-align: center; padding: 2rem; }
    .spinner {
      width: 36px; height: 36px;
      border: 3px solid #2a2a3e;
      border-top-color: #7c3aed;
      border-radius: 50%;
      animation: spin .7s linear infinite;
      margin: 0 auto 1rem;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .status { font-size: .9rem; color: #8888a0; }
    .error { color: #ef4444; margin-top: .5rem; font-size: .9rem; }
    .logo { font-size: 1.4rem; margin-bottom: 1.2rem; letter-spacing: .05em; color: #a78bfa; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="logo">&#9608; terminal</div>
    <div class="spinner" id="spin"></div>
    <div class="status" id="status">authenticating...</div>
    <div class="error" id="err"></div>
  </div>
  <script>
    const tg = window.Telegram && Telegram.WebApp;
    const $ = id => document.getElementById(id);

    function fail(msg) {
      $('spin').style.display = 'none';
      $('status').style.display = 'none';
      $('err').textContent = msg;
    }

    if (!tg || !tg.initData) {
      fail('This app must be opened from Telegram.');
    } else {
      tg.ready();
      tg.expand();
      // Set theme
      document.body.style.background = tg.themeParams.bg_color || '#0e0e1a';

      fetch('/_auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: tg.initData })
      })
      .then(r => r.json())
      .then(d => {
        if (d.ok) {
          window.location.replace('/');
        } else {
          fail(d.error || 'Authentication failed.');
        }
      })
      .catch(() => fail('Connection error.'));
    }
  </script>
</body>
</html>`;

// --- Proxy ---
const proxy = httpProxy.createProxyServer({
  target: TTYD_TARGET,
  ws: true,
  changeOrigin: true,
});

proxy.on('error', (err, req, res) => {
  console.error('Proxy error:', err.message);
  if (res && res.writeHead) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('ttyd unavailable');
  }
});

// --- HTTP server ---
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  // Auth endpoint
  if (parsed.pathname === '/_auth' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { initData } = JSON.parse(body);
        const user = validateInitData(initData || '');
        if (!user) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
          return;
        }
        const token = createSession(user.id);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `ttyd_session=${token}; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; SameSite=None; Secure; Path=/`,
        });
        res.end(JSON.stringify({ ok: true }));
        console.log(`Auth OK: ${user.first_name} (${user.id})`);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Bad request' }));
      }
    });
    return;
  }

  // Everything else requires auth
  if (!checkSession(req.headers.cookie)) {
    // Serve auth page
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(AUTH_HTML);
    return;
  }

  // Proxy to ttyd
  proxy.web(req, res);
});

// WebSocket upgrade — also needs auth
server.on('upgrade', (req, socket, head) => {
  if (!checkSession(req.headers.cookie)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ttyd-telegram-proxy listening on :${PORT}`);
  console.log(`Proxying to ${TTYD_TARGET}`);
  console.log(`Allowed user: ${ALLOWED_USER_ID}`);
});
