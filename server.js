#!/usr/bin/env node
/**
 * ttyd-telegram-proxy
 *
 * Telegram Mini App auth proxy for ttyd.
 * Spawns ttyd on-demand with viewport-matched font size.
 * Single session — new auth reuses the running ttyd instance.
 */

const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const httpProxy = require('http-proxy');

// --- Config ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_ID = parseInt(process.env.TELEGRAM_ALLOWED_USERS || '0', 10);
const TTYD_PORT = parseInt(process.env.TTYD_PORT || '8080', 10);
const PORT = parseInt(process.env.PROXY_PORT || '8443', 10);
const TTYD_BIN = process.env.TTYD_BIN || 'ttyd';
const TTYD_SHELL = process.env.TTYD_SHELL || '/bin/bash';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const IDLE_TIMEOUT_MS = parseInt(process.env.TTYD_IDLE_TIMEOUT || '1800', 10) * 1000; // 30min default

if (!BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

// --- Session store ---
const sessions = new Map();

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

    const sortedPairs = [...params.entries()]
      .filter(([k]) => k !== 'hash')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`);
    const dataCheckString = sortedPairs.join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData')
      .update(BOT_TOKEN).digest();
    const computed = crypto.createHmac('sha256', secretKey)
      .update(dataCheckString).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hash, 'hex'))) {
      return null;
    }

    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (Math.abs(Date.now() / 1000 - authDate) > 3600) return null;

    const userJson = params.get('user');
    if (!userJson) return null;
    const user = JSON.parse(userJson);
    if (user.id !== ALLOWED_USER_ID) return null;

    return user;
  } catch {
    return null;
  }
}

// --- ttyd process management ---
let ttydProcess = null;
let ttydFontSize = 16;
let ttydReady = false;
let idleTimer = null;

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.log('ttyd idle timeout — stopping');
    stopTtyd();
  }, IDLE_TIMEOUT_MS);
}

function stopTtyd() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (ttydProcess) {
    console.log('Stopping ttyd (pid ' + ttydProcess.pid + ')');
    ttydProcess.kill('SIGTERM');
    ttydProcess = null;
    ttydReady = false;
  }
}

function startTtyd(fontSize) {
  // If already running with same font size, just reuse
  if (ttydProcess && !ttydProcess.killed) {
    resetIdleTimer();
    return Promise.resolve();
  }

  // Kill old one if font size changed or stale
  stopTtyd();

  ttydFontSize = fontSize;
  const args = [
    '--writable',
    '-i', 'lo',
    '-p', String(TTYD_PORT),
    '-t', `fontSize=${fontSize}`,
    '-t', 'fontFamily=JetBrains Mono,Menlo,Consolas,monospace',
    '-t', 'cursorBlink=true',
    TTYD_SHELL, '-l',
  ];

  console.log(`Starting ttyd: ${TTYD_BIN} ${args.join(' ')}`);

  return new Promise((resolve, reject) => {
    ttydProcess = spawn(TTYD_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resolved = false;

    ttydProcess.stdout.on('data', (data) => {
      const msg = data.toString();
      process.stdout.write('[ttyd] ' + msg);
    });

    ttydProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      process.stderr.write('[ttyd] ' + msg);
      // ttyd logs "Listening on port XXXX" to stderr when ready
      if (!resolved && msg.includes('Listening')) {
        resolved = true;
        ttydReady = true;
        resetIdleTimer();
        resolve();
      }
    });

    ttydProcess.on('error', (err) => {
      console.error('ttyd spawn error:', err.message);
      ttydProcess = null;
      ttydReady = false;
      if (!resolved) { resolved = true; reject(err); }
    });

    ttydProcess.on('exit', (code, signal) => {
      console.log(`ttyd exited (code=${code}, signal=${signal})`);
      ttydProcess = null;
      ttydReady = false;
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      if (!resolved) { resolved = true; reject(new Error('ttyd exited prematurely')); }
    });

    // Fallback: if no "Listening" message within 3s, assume ready anyway
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ttydReady = true;
        resetIdleTimer();
        resolve();
      }
    }, 3000);
  });
}

// Cleanup on exit
process.on('SIGTERM', () => { stopTtyd(); process.exit(0); });
process.on('SIGINT', () => { stopTtyd(); process.exit(0); });

// --- Auth page ---
const AUTH_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <title>Terminal</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#0e0e1a;color:#c8c8d4;font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;overflow:hidden}
    .wrap{text-align:center;padding:2rem}
    .spinner{width:36px;height:36px;border:3px solid #2a2a3e;border-top-color:#7c3aed;border-radius:50%;animation:spin .7s linear infinite;margin:0 auto 1rem}
    @keyframes spin{to{transform:rotate(360deg)}}
    .status{font-size:.9rem;color:#8888a0}
    .error{color:#ef4444;margin-top:.5rem;font-size:.9rem}
    .logo{font-size:1.4rem;margin-bottom:1.2rem;letter-spacing:.05em;color:#a78bfa}
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
    var tg = window.Telegram && Telegram.WebApp;
    function fail(msg) {
      document.getElementById('spin').style.display='none';
      document.getElementById('status').style.display='none';
      document.getElementById('err').textContent=msg;
    }
    if (!tg || !tg.initData) {
      fail('This app must be opened from Telegram.');
    } else {
      tg.ready(); tg.expand();
      document.body.style.background = tg.themeParams.bg_color || '#0e0e1a';

      // Calculate optimal font size from viewport
      var vw = window.innerWidth || document.documentElement.clientWidth;
      var fontSize = Math.floor(vw / (80 * 0.62));
      fontSize = Math.max(10, Math.min(fontSize, 22));

      document.getElementById('status').textContent = 'starting terminal...';

      fetch('/_auth', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ initData: tg.initData, fontSize: fontSize, viewportWidth: vw })
      })
      .then(function(r){return r.json()})
      .then(function(d){
        if (d.ok) window.location.replace('/_terminal');
        else fail(d.error || 'Authentication failed.');
      })
      .catch(function(){fail('Connection error.')});
    }
  </script>
</body>
</html>`;

// --- Terminal wrapper ---
const TERMINAL_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <title>Terminal</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:100%;height:100%;overflow:hidden;background:#000}
    iframe{width:100%;height:100%;border:none}
  </style>
</head>
<body>
  <iframe id="ttyd" src="/_ttyd/"></iframe>
  <script>
    var tg = window.Telegram && Telegram.WebApp;
    if(tg){tg.ready();tg.expand();}
    // Keep session alive — ping every 5 min
    setInterval(function(){fetch('/_ping').catch(function(){})}, 300000);
  </script>
</body>
</html>`;

// --- Proxy ---
const proxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${TTYD_PORT}`,
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
  const pathname = req.url.split('?')[0];

  // Auth endpoint — also spawns ttyd with client's font size
  if (pathname === '/_auth' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const user = validateInitData(payload.initData || '');
        if (!user) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
          return;
        }

        // Calculate font size from client viewport
        const fontSize = Math.max(10, Math.min(22, parseInt(payload.fontSize || '16', 10)));

        // Start ttyd (or reuse existing)
        try {
          await startTtyd(fontSize);
        } catch (e) {
          console.error('Failed to start ttyd:', e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Failed to start terminal' }));
          return;
        }

        const token = createSession(user.id);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `ttyd_session=${token}; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; SameSite=None; Secure; Path=/`,
        });
        res.end(JSON.stringify({ ok: true }));
        console.log(`Auth OK: ${user.first_name} (${user.id}), fontSize=${fontSize}`);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Bad request' }));
      }
    });
    return;
  }

  // All other routes require auth
  if (!checkSession(req.headers.cookie)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(AUTH_HTML);
    return;
  }

  // Keep-alive ping (resets idle timer)
  if (pathname === '/_ping') {
    resetIdleTimer();
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // Terminal wrapper
  if (pathname === '/_terminal') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(TERMINAL_HTML);
    return;
  }

  // ttyd not running — show "starting" message
  if (!ttydReady) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('Terminal is starting...');
    return;
  }

  // Rewrite /_ttyd/ → / for ttyd backend
  if (req.url.startsWith('/_ttyd')) {
    req.url = req.url.replace(/^\/_ttyd/, '') || '/';
  }

  resetIdleTimer();
  proxy.web(req, res);
});

// WebSocket upgrade
server.on('upgrade', (req, socket, head) => {
  if (!checkSession(req.headers.cookie)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  if (!ttydReady) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    socket.destroy();
    return;
  }
  if (req.url.startsWith('/_ttyd')) {
    req.url = req.url.replace(/^\/_ttyd/, '') || '/';
  }
  resetIdleTimer();
  proxy.ws(req, socket, head);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ttyd-telegram-proxy listening on :${PORT}`);
  console.log(`ttyd will spawn on-demand at :${TTYD_PORT}`);
  console.log(`Allowed user: ${ALLOWED_USER_ID}`);
  console.log(`Idle timeout: ${IDLE_TIMEOUT_MS / 1000}s`);
});
