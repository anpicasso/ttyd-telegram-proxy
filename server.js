#!/usr/bin/env node
/**
 * terminal-proxy
 *
 * Telegram Mini App auth → xterm.js + node-pty.
 * On-demand PTY, responsive UI, right-side button bar.
 */

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');

// --- Config ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_ID = parseInt(process.env.TELEGRAM_ALLOWED_USERS || '0', 10);
const PORT = parseInt(process.env.PROXY_PORT || '8443', 10);
const SHELL = process.env.TTYD_SHELL || '/bin/bash';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const IDLE_TIMEOUT_MS = parseInt(process.env.TTYD_IDLE_TIMEOUT || '1800', 10) * 1000;

if (!BOT_TOKEN) { console.error('TELEGRAM_BOT_TOKEN required'); process.exit(1); }

// --- Session store ---
const sessions = new Map();
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { userId, expires: Date.now() + SESSION_TTL_MS });
  return token;
}
function checkSession(cookieHeader) {
  if (!cookieHeader) return false;
  const m = cookieHeader.match(/term_session=([^;]+)/);
  if (!m) return false;
  const s = sessions.get(m[1]);
  if (!s) return false;
  if (Date.now() > s.expires) { sessions.delete(m[1]); return false; }
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) if (now > v.expires) sessions.delete(k);
}, 600_000);

// --- Telegram initData validation ---
function validateInitData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    const sorted = [...params.entries()]
      .filter(([k]) => k !== 'hash')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computed = crypto.createHmac('sha256', secret).update(sorted).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hash, 'hex'))) return null;
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (Math.abs(Date.now() / 1000 - authDate) > 3600) return null;
    const userJson = params.get('user');
    if (!userJson) return null;
    const user = JSON.parse(userJson);
    if (user.id !== ALLOWED_USER_ID) return null;
    return user;
  } catch { return null; }
}

// --- PTY management ---
let ptyProcess = null;
let idleTimer = null;
let activeWs = null; // current WebSocket

function resetIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.log('PTY idle timeout — killing');
    killPty();
  }, IDLE_TIMEOUT_MS);
}

function killPty() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (ptyProcess) {
    console.log('Killing PTY pid=' + ptyProcess.pid);
    ptyProcess.kill();
    ptyProcess = null;
  }
}

function ensurePty(cols, rows) {
  if (ptyProcess) {
    ptyProcess.resize(cols, rows);
    resetIdle();
    return ptyProcess;
  }
  console.log(`Spawning PTY: ${SHELL} (${cols}x${rows})`);
  ptyProcess = pty.spawn(SHELL, ['-l'], {
    name: 'xterm-256color',
    cols, rows,
    cwd: process.env.HOME,
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  ptyProcess.onExit(() => {
    console.log('PTY exited');
    ptyProcess = null;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  });
  resetIdle();
  return ptyProcess;
}

process.on('SIGTERM', () => { killPty(); process.exit(0); });
process.on('SIGINT', () => { killPty(); process.exit(0); });

// --- Static files (xterm.js from node_modules) ---
const STATIC_MAP = {
  '/xterm.css': { path: 'node_modules/@xterm/xterm/css/xterm.css', type: 'text/css' },
  '/xterm.js': { path: 'node_modules/@xterm/xterm/lib/xterm.js', type: 'application/javascript' },
  '/xterm-addon-fit.js': { path: 'node_modules/@xterm/addon-fit/lib/addon-fit.js', type: 'application/javascript' },
  '/xterm-addon-web-links.js': { path: 'node_modules/@xterm/addon-web-links/lib/addon-web-links.js', type: 'application/javascript' },
};

function serveStatic(req, res) {
  const entry = STATIC_MAP[req.url];
  if (!entry) return false;
  const filePath = path.join(__dirname, entry.path);
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': entry.type, 'Cache-Control': 'public, max-age=86400' });
    res.end(data);
    return true;
  } catch {
    res.writeHead(404); res.end('Not found');
    return true;
  }
}

// --- HTML pages ---
const AUTH_HTML = `<!DOCTYPE html>
<html><head>
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
</head><body>
<div class="wrap">
  <div class="logo">█ terminal</div>
  <div class="spinner" id="spin"></div>
  <div class="status" id="status">authenticating...</div>
  <div class="error" id="err"></div>
</div>
<script>
var tg=window.Telegram&&Telegram.WebApp;
function fail(m){document.getElementById('spin').style.display='none';document.getElementById('status').style.display='none';document.getElementById('err').textContent=m}
if(!tg||!tg.initData){fail('Open from Telegram.')}else{
  tg.ready();tg.expand();
  document.body.style.background=tg.themeParams.bg_color||'#0e0e1a';
  var vw=window.innerWidth||document.documentElement.clientWidth;
  var vh=window.innerHeight||document.documentElement.clientHeight;
  fetch('/_auth',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({initData:tg.initData,vw:vw,vh:vh})})
  .then(function(r){return r.json()})
  .then(function(d){if(d.ok)window.location.replace('/_terminal');else fail(d.error||'Auth failed.')})
  .catch(function(){fail('Connection error.')});
}
</script></body></html>`;

const TERMINAL_HTML = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Terminal</title>
<link rel="stylesheet" href="/xterm.css">
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root {
  --bg: #0e0e1a;
  --surface: #1a1a2e;
  --btn: #2a2a3e;
  --btn-active: #7c3aed;
  --text: #c8c8d4;
  --text-dim: #6a6a80;
  --accent: #a78bfa;
  --border: #2a2a3e;
  --btn-radius: 8px;
  --bar-width: 46px;
  --bar-width-kb: 36px;
}
* { margin:0; padding:0; box-sizing:border-box; }
html, body {
  width:100%; height:100%; overflow:hidden;
  background:var(--bg); color:var(--text);
  font-family:-apple-system,system-ui,sans-serif;
  touch-action:manipulation;
}

#container {
  display:flex; width:100%; height:100%;
}

#term-wrap {
  flex:1; min-width:0; height:100%;
  display:flex; flex-direction:column;
  position:relative;
}
#terminal {
  flex:1; min-height:0;
}
#terminal .xterm { height:100%; }
#terminal .xterm-viewport { overflow-y:auto !important; }

/* Right-side button bar */
#sidebar {
  width:var(--bar-width);
  background:var(--surface);
  border-left:1px solid var(--border);
  display:flex; flex-direction:column;
  padding:3px; gap:3px;
  overflow:hidden;
  flex-shrink:0;
}

#sidebar button {
  width:100%;
  background:var(--btn); color:var(--text);
  border:none; border-radius:var(--btn-radius);
  font-size:15px;
  font-family:-apple-system,system-ui,sans-serif;
  cursor:pointer;
  -webkit-tap-highlight-color:transparent;
  touch-action:manipulation;
  display:flex; align-items:center; justify-content:center;
  transition: background .1s;
  flex-shrink:0;
  padding:0;
}
#sidebar button:active { background:var(--btn-active); color:#fff; }
#sidebar button.flash { background:#22c55e; color:#000; }

/* Arrow group + clipboard group fill height equally */
#sidebar .group {
  display:flex; flex-direction:column;
  gap:3px;
}
#sidebar .group.arrows { flex:1; }
#sidebar .group.clip { flex:1; }
#sidebar .group button { flex:1; min-height:0; }
#sidebar .sep {
  height:1px; background:var(--border);
  flex-shrink:0; margin:2px 0;
}

/* Label inside button */
#sidebar button .lbl-full { display:inline; }
#sidebar button .lbl-short { display:none; }

/* Keyboard-open compact mode */
body.kb-open #sidebar { width:var(--bar-width-kb); }
body.kb-open #sidebar button { font-size:13px; }
body.kb-open #sidebar button .lbl-full { display:none; }
body.kb-open #sidebar button .lbl-short { display:inline; }

/* Toast */
#toast {
  position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
  background:rgba(0,0,0,.85); color:#fff;
  padding:8px 20px; border-radius:8px; font-size:13px;
  font-family:-apple-system,system-ui,sans-serif;
  pointer-events:none; opacity:0; transition:opacity .2s; z-index:200;
}
#toast.show { opacity:1; }

/* Loading overlay */
#loading {
  position:absolute; top:0; left:0; right:0; bottom:0;
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  background:var(--bg); z-index:50;
  transition:opacity .4s;
}
#loading.hidden { opacity:0; pointer-events:none; }
#loading .logo {
  font-size:1.4rem; letter-spacing:.05em; color:var(--accent);
  margin-bottom:1.2rem;
}
.ldspinner {
  width:28px; height:28px;
  border:3px solid var(--border); border-top-color:var(--accent);
  border-radius:50%; animation:spin .7s linear infinite;
  margin-bottom:.7rem;
}
@keyframes spin { to { transform:rotate(360deg); } }
.ldtext { font-size:.85rem; color:var(--text-dim); }
</style>
</head><body>
<div id="container">
  <div id="term-wrap">
    <div id="loading"><div class="logo">█ terminal</div><div class="ldspinner"></div><div class="ldtext">loading...</div></div>
    <div id="terminal"></div>
  </div>
  <div id="sidebar">
    <div class="group arrows">
      <button id="btnUp">▲</button>
      <button id="btnDown">▼</button>
      <button id="btnLeft">◀</button>
      <button id="btnRight">▶</button>
    </div>
    <div class="sep"></div>
    <div class="group clip">
      <button id="btnSel"><span class="lbl-full">Sel</span><span class="lbl-short">S</span></button>
      <button id="btnCopy"><span class="lbl-full">Copy</span><span class="lbl-short">C</span></button>
      <button id="btnPaste"><span class="lbl-full">Paste</span><span class="lbl-short">P</span></button>
    </div>
  </div>
</div>
<div id="toast"></div>

<script src="/xterm.js"></script>
<script src="/xterm-addon-fit.js"></script>
<script src="/xterm-addon-web-links.js"></script>
<script>
(function() {
  var tg = window.Telegram && Telegram.WebApp;
  if (tg) { tg.ready(); tg.expand(); }

  // --- Theme ---
  var theme = {
    background: '#0e0e1a',
    foreground: '#c8c8d4',
    cursor: '#a78bfa',
    cursorAccent: '#0e0e1a',
    selectionBackground: 'rgba(124,58,237,0.35)',
    selectionForeground: '#ffffff',
    black: '#1a1a2e',
    brightBlack: '#4a4a5e',
    red: '#ef4444',
    brightRed: '#f87171',
    green: '#22c55e',
    brightGreen: '#4ade80',
    yellow: '#eab308',
    brightYellow: '#facc15',
    blue: '#3b82f6',
    brightBlue: '#60a5fa',
    magenta: '#a78bfa',
    brightMagenta: '#c4b5fd',
    cyan: '#06b6d4',
    brightCyan: '#22d3ee',
    white: '#c8c8d4',
    brightWhite: '#f0f0f4'
  };

  // --- Responsive font size ---
  var vw = window.innerWidth || document.documentElement.clientWidth;
  var sidebarW = 46;
  var termW = vw - sidebarW;
  var cols = termW < 400 ? 45 : 80;
  var fontSize = Math.floor(termW / (cols * 0.602));
  fontSize = Math.max(13, Math.min(fontSize, 20));

  // --- Create terminal ---
  var term = new Terminal({
    fontSize: fontSize,
    fontFamily: "'JetBrains Mono','Fira Code','Cascadia Code',Menlo,Consolas,monospace",
    theme: theme,
    cursorBlink: true,
    cursorStyle: 'bar',
    allowTransparency: true,
    scrollback: 5000,
    convertEol: true,
  });

  var fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  var linksAddon = new WebLinksAddon.WebLinksAddon();
  term.loadAddon(linksAddon);

  var termEl = document.getElementById('terminal');
  term.open(termEl);

  // Fit after open
  setTimeout(function() { fitAddon.fit(); }, 50);

  // --- WebSocket ---
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var ws = new WebSocket(proto + '//' + location.host + '/_ws');

  var loadingHidden = false;
  function hideLoading() {
    if (loadingHidden) return;
    loadingHidden = true;
    var ld = document.getElementById('loading');
    if (ld) ld.classList.add('hidden');
  }

  ws.onopen = function() {
    // Send initial size
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  };

  ws.onmessage = function(e) {
    hideLoading();
    term.write(e.data);
  };

  ws.onclose = function() {
    term.write('\\r\\n\\x1b[1;31m[connection closed]\\x1b[0m\\r\\n');
  };

  // Terminal input → WebSocket
  term.onData(function(data) {
    if (ws.readyState === 1) ws.send(data);
  });

  // Resize handling
  term.onResize(function(size) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
    }
  });

  function doFit() {
    try { fitAddon.fit(); } catch(e) {}
  }

  window.addEventListener('resize', doFit);
  if (tg) tg.onEvent('viewportChanged', doFit);

  // --- Keyboard detection (iOS) ---
  var initialVH = window.innerHeight;
  function checkKeyboard() {
    var ratio = window.innerHeight / initialVH;
    if (ratio < 0.75) {
      document.body.classList.add('kb-open');
    } else {
      document.body.classList.remove('kb-open');
    }
    doFit();
  }
  window.visualViewport && window.visualViewport.addEventListener('resize', checkKeyboard);
  window.addEventListener('resize', checkKeyboard);

  // --- Toast ---
  var toast = document.getElementById('toast');
  var toastTimer;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function() { toast.classList.remove('show'); }, 1000);
  }
  function flashBtn(btn) {
    btn.classList.add('flash');
    setTimeout(function() { btn.classList.remove('flash'); }, 200);
  }

  // --- Prevent focus steal from buttons ---
  document.getElementById('sidebar').addEventListener('mousedown', function(e) {
    if (e.target.closest('button')) e.preventDefault();
  });

  function refocus() { term.focus(); }

  // --- Arrow keys ---
  var ESC = '\\x1b';
  document.getElementById('btnUp').addEventListener('click', function() { if(ws.readyState===1) ws.send(ESC+'[A'); flashBtn(this); refocus(); });
  document.getElementById('btnDown').addEventListener('click', function() { if(ws.readyState===1) ws.send(ESC+'[B'); flashBtn(this); refocus(); });
  document.getElementById('btnRight').addEventListener('click', function() { if(ws.readyState===1) ws.send(ESC+'[C'); flashBtn(this); refocus(); });
  document.getElementById('btnLeft').addEventListener('click', function() { if(ws.readyState===1) ws.send(ESC+'[D'); flashBtn(this); refocus(); });

  // --- Clipboard ---
  document.getElementById('btnSel').addEventListener('click', function() {
    term.selectAll();
    showToast('Selected');
    flashBtn(this);
    refocus();
  });

  document.getElementById('btnCopy').addEventListener('click', function() {
    var sel = term.getSelection();
    if (!sel) { showToast('Nothing selected'); return; }
    var btn = this;
    navigator.clipboard.writeText(sel).then(function() {
      showToast('Copied');
      flashBtn(btn);
      term.clearSelection();
      refocus();
    }).catch(function() {
      var ta = document.createElement('textarea');
      ta.value = sel; ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('Copied'); flashBtn(btn);
      term.clearSelection(); refocus();
    });
  });

  document.getElementById('btnPaste').addEventListener('click', function() {
    var btn = this;
    navigator.clipboard.readText().then(function(text) {
      if (text && ws.readyState === 1) {
        ws.send(text);
        showToast('Pasted'); flashBtn(btn);
      } else { showToast('Empty'); }
      refocus();
    }).catch(function() {
      showToast('Clipboard denied'); refocus();
    });
  });

  // --- Keep-alive ---
  setInterval(function() {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
  }, 300000);

  // Initial focus
  setTimeout(refocus, 200);
})();
</script>
</body></html>`;

// --- HTTP server ---
const server = http.createServer((req, res) => {
  const pathname = req.url.split('?')[0];

  // Static files (xterm assets)
  if (serveStatic(req, res)) return;

  // Auth endpoint
  if (pathname === '/_auth' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const user = validateInitData(payload.initData || '');
        if (!user) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
          return;
        }
        const token = createSession(user.id);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `term_session=${token}; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; SameSite=None; Secure; Path=/`,
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

  // Auth check for all other routes
  if (!checkSession(req.headers.cookie)) {
    if (pathname !== '/') {
      res.writeHead(302, { 'Location': '/' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(AUTH_HTML);
    return;
  }

  // Authenticated root → terminal
  if (pathname === '/') {
    res.writeHead(302, { 'Location': '/_terminal' });
    res.end();
    return;
  }

  // Terminal page
  if (pathname === '/_terminal') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(TERMINAL_HTML);
    return;
  }

  // Ping
  if (pathname === '/_ping') {
    resetIdle();
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// --- WebSocket ---
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!checkSession(req.headers.cookie)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  const pathname = req.url.split('?')[0];
  if (pathname !== '/_ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  // Update the active WebSocket — PTY output always goes to the latest connection
  activeWs = ws;
  console.log('WS connected');

  // If PTY already exists, wire it to this new WS (rebind)
  if (ptyProcess && !ptyProcess._wsBound) {
    ptyProcess._wsBound = true;
    ptyProcess.onData((data) => {
      if (activeWs && activeWs.readyState === 1) activeWs.send(data);
    });
  }

  ws.on('message', (msg) => {
    resetIdle();
    const str = msg.toString();

    // Try JSON control messages
    try {
      const ctrl = JSON.parse(str);
      if (ctrl.type === 'resize') {
        const cols = Math.max(10, Math.min(500, ctrl.cols || 80));
        const rows = Math.max(2, Math.min(200, ctrl.rows || 24));
        const p = ensurePty(cols, rows);
        // Bind PTY output to active WS (uses activeWs ref, not closure)
        if (!p._wsBound) {
          p._wsBound = true;
          p.onData((data) => {
            if (activeWs && activeWs.readyState === 1) activeWs.send(data);
          });
        }
        return;
      }
      if (ctrl.type === 'ping') return;
    } catch {}

    // Regular terminal input
    if (ptyProcess) ptyProcess.write(str);
    else {
      const p = ensurePty(80, 24);
      if (!p._wsBound) {
        p._wsBound = true;
        p.onData((data) => {
          if (activeWs && activeWs.readyState === 1) activeWs.send(data);
        });
      }
      p.write(str);
    }
  });

  ws.on('close', () => {
    if (activeWs === ws) {
      // Don't null it — next connection will replace it
      console.log('WS closed (was active)');
    } else {
      console.log('WS closed (stale)');
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`terminal-proxy listening on :${PORT}`);
  console.log(`Allowed user: ${ALLOWED_USER_ID}`);
  console.log(`Idle timeout: ${IDLE_TIMEOUT_MS / 1000}s`);
});
