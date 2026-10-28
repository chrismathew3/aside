const {
  app, BrowserWindow, globalShortcut, ipcMain, screen, desktopCapturer,
  systemPreferences, safeStorage, shell, Tray, Menu, nativeImage, dialog,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { SYSTEM_PROMPT } = require('./prompt');
const { buildClaudeLaunch } = require('./harness');
const { createScreenshotQueue } = require('./screenshot-queue');
const { createLocalTranscriber } = require('./local-transcriber');
const { configureWindowSizing } = require('./window-sizing');

app.setName('Aside');
if (!app.requestSingleInstanceLock()) app.quit();

// ---------- settings ----------
const SECRET_KEYS = ['deepgramKey', 'anthropicKey'];
const DEFAULTS = { provider: 'max', model: 'sonnet', transcription: 'local', deepgramKey: '', anthropicKey: '', about: '', claudePath: '', onboardingDone: false, useHarness: true, projectPath: '' };
const configPath = () => path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    for (const k of SECRET_KEYS) {
      if (raw[k]) {
        try { raw[k] = safeStorage.decryptString(Buffer.from(raw[k], 'base64')); } catch { raw[k] = ''; }
      }
    }
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig(next) {
  const out = { ...next };
  for (const k of SECRET_KEYS) {
    if (out[k]) out[k] = safeStorage.encryptString(out[k]).toString('base64');
  }
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(out, null, 2), { mode: 0o600 });
}

let cfg;

// ---------- window ----------
let win;
let tray;
const WIDTH = 660;

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: WIDTH,
    height: 96,
    x: Math.round(workArea.x + (workArea.width - WIDTH) / 2),
    y: workArea.y + 10,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    minWidth: 560,
    minHeight: 96,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    hiddenInMissionControl: true,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  configureWindowSizing(win, { ipcMain, screen });

  // Request OS content protection for private notes; capture behavior varies by app and macOS version.
  win.setContentProtection(true);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => showOverlay());
}

function showOverlay() {
  win.showInactive();
  setActiveShortcuts(true);
  send('visibility', true);
}

function hideOverlay() {
  win.hide();
  setActiveShortcuts(false);
  send('visibility', false);
}

function toggleOverlay() {
  if (win.isVisible()) hideOverlay();
  else showOverlay();
}

ipcMain.on('focus', () => { app.focus({ steal: true }); win.focus(); });
// Give focus back to the call app after typing in Aside.
ipcMain.on('blur', () => {
  if (process.platform === 'darwin') {
    app.hide();
    setTimeout(() => win.showInactive(), 60);
  } else {
    win.blur();
  }
});
ipcMain.on('hide', () => hideOverlay());
ipcMain.on('quit', () => app.quit());
ipcMain.on('open-external', (_e, url) => {
  if (/^https:\/\//.test(url) || url.startsWith('x-apple.systempreferences:')) shell.openExternal(url);
});

// ---------- shortcuts ----------
// ⌘\ always works. The rest only while Aside is on screen, so ⌘↵ goes back to
// your other apps when it is hidden.
const ACTIVE = {
  'CommandOrControl+Return': () => send('hotkey', 'answer'),
  'CommandOrControl+Shift+Return': () => send('hotkey', 'ask'),
  'CommandOrControl+Shift+L': () => send('hotkey', 'listen'),
  'CommandOrControl+Shift+Backspace': () => send('hotkey', 'clear'),
  'CommandOrControl+Shift+Up': () => send('hotkey', 'scroll-up'),
  'CommandOrControl+Shift+Down': () => send('hotkey', 'scroll-down'),
};
let activeOn = false;
function setActiveShortcuts(on) {
  if (on === activeOn) return;
  activeOn = on;
  for (const [acc, fn] of Object.entries(ACTIVE)) {
    if (on) globalShortcut.register(acc, fn);
    else globalShortcut.unregister(acc);
  }
}

// ---------- screenshot ----------
async function captureScreen() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const longEdge = 2000;
  const { width, height } = display.size;
  const scale = longEdge / Math.max(width, height);
  const thumbnailSize = { width: Math.round(width * scale), height: Math.round(height * scale) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
  const src = sources.find((s) => s.display_id === String(display.id)) || sources[0];
  if (!src || src.thumbnail.isEmpty()) return null;
  return src.thumbnail.toJPEG(85).toString('base64');
}

// The queue is session-only; image data is never written to settings or disk.
const screenshotQueue = createScreenshotQueue({
  capture: async () => {
    const wasVisible = win && !win.isDestroyed() && win.isVisible();
    if (wasVisible) win.hide();
    try {
      // Let the compositor remove Aside before capturing the underlying page.
      if (wasVisible) await new Promise(resolve => setTimeout(resolve, 100));
      return await captureScreen();
    } finally {
      if (wasVisible && win && !win.isDestroyed()) win.showInactive();
    }
  },
  onChange: entries => send('screenshots-changed', entries),
});
async function queueScreenshot() {
  try { await screenshotQueue.capture(); return { ok: true }; }
  catch (error) { if (error.code !== 'CAPTURE_CLEARED') send('status', { error: error.message }); return { ok: false, error: error.message }; }
}
ipcMain.handle('screenshots-get', () => screenshotQueue.snapshot());
ipcMain.handle('screenshots-capture', () => queueScreenshot());
ipcMain.on('screenshots-remove', (_event, { id } = {}) => screenshotQueue.remove(id));
ipcMain.on('screenshots-clear', () => screenshotQueue.clear());

// ---------- transcription (Deepgram) ----------
let transcriptEpoch = 0;
function openDeepgramTranscriber(who, epoch) {
  const params = new URLSearchParams({
    model: 'nova-3',
    encoding: 'linear16',
    sample_rate: '24000',
    channels: '1',
    interim_results: 'true',
    smart_format: 'true',
    endpointing: '300',
    language: 'en',
  });
  const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
    headers: { Authorization: `Token ${cfg.deepgramKey}` },
  });
  const pending = [];
  let keepAlive;
  let closed = false;

  ws.on('open', () => {
    if (closed) { pending.length = 0; ws.close(); return; }
    for (const b of pending) ws.send(b);
    pending.length = 0;
    keepAlive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }));
    }, 8000);
  });
  ws.on('message', (raw) => {
    if (closed) return;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type !== 'Results') return;
    const text = msg.channel?.alternatives?.[0]?.transcript ?? '';
    send('transcript', { who, text, final: !!msg.is_final, epoch });
  });
  ws.on('unexpected-response', (_req, res) => {
    const reason = res.statusCode === 401 ? 'Deepgram rejected the key. Check it in Settings.' : `Deepgram error ${res.statusCode}`;
    send('status', { error: reason });
  });
  ws.on('error', (e) => { if (!closed) send('status', { error: `Transcription: ${e.message}` }); });
  ws.on('close', () => { clearInterval(keepAlive); });

  return {
    write(buf) {
      if (ws.readyState === WebSocket.OPEN) ws.send(buf);
      else if (ws.readyState === WebSocket.CONNECTING && pending.length < 100) pending.push(buf);
    },
    close() {
      closed = true;
      pending.length = 0;
      clearInterval(keepAlive);
      try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' })); } catch {}
      setTimeout(() => { try { ws.close(); } catch {} }, 500);
    },
  };
}

function localPaths() {
  return {
    binary: [
      ...(app.isPackaged ? [path.join(process.resourcesPath, 'whisper-cli')] : []),
      path.join(__dirname, 'bin', 'whisper-cli'),
      '/opt/homebrew/bin/whisper-cli',
      '/usr/local/bin/whisper-cli',
    ].find((file) => {
      try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
    }) || '/opt/homebrew/bin/whisper-cli',
    model: app.isPackaged
      ? path.join(process.resourcesPath, 'ggml-base.en.bin')
      : path.join(__dirname, 'models', 'ggml-base.en.bin'),
  };
}
function openTranscriber(who) {
  const epoch = transcriptEpoch;
  if (cfg.transcription === 'deepgram') return openDeepgramTranscriber(who, epoch);
  return createLocalTranscriber({
    who, ...localPaths(),
    onTranscript: (entry) => send('transcript', { ...entry, epoch }),
    onError: (error) => send('status', { error: typeof error === 'string' ? error : error.message }),
  });
}

let listening = null;

function helperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'aside-audio')
    : path.join(__dirname, 'bin', 'aside-audio');
}

function startListening() {
  if (listening) return { ok: true };
  if (cfg.transcription === 'deepgram' && !cfg.deepgramKey) return { ok: false, error: 'Add a Deepgram key or choose Local Whisper in Settings.' };
  if (cfg.transcription !== 'deepgram') {
    const { binary, model } = localPaths();
    try { fs.accessSync(binary, fs.constants.X_OK); fs.accessSync(model, fs.constants.R_OK); }
    catch { return { ok: false, error: 'Local Whisper or its model is missing. Reinstall the local transcription files.' }; }
  }

  try { fs.accessSync(helperPath(), fs.constants.X_OK); } catch {
    return { ok: false, error: 'The audio helper is missing or not executable. Rebuild Aside with npm run build.' };
  }
  const me = openTranscriber('me');
  const them = openTranscriber('them');
  const proc = spawn(helperPath(), [], { stdio: ['ignore', 'pipe', 'pipe'] });
  let carry = null;
  proc.stdout.on('data', (chunk) => {
    // Keep 16-bit samples aligned across pipe reads.
    let buf = carry ? Buffer.concat([carry, chunk]) : chunk;
    carry = null;
    if (buf.length % 2) { carry = buf.subarray(buf.length - 1); buf = buf.subarray(0, buf.length - 1); }
    if (buf.length && listening?.proc === proc) listening.them.write(buf);
  });
  proc.stderr.on('data', (d) => {
    const s = d.toString();
    if (s.includes('error:')) {
      send('status', { error: 'Aside needs Screen Recording permission to hear the call. Turn it on in System Settings → Privacy & Security, then reopen Aside.', permission: 'screen' });
    }
  });
  proc.on('error', (error) => {
    if (listening?.proc !== proc) return;
    them.close();
    send('status', { error: `System audio could not start: ${error.message}. Your mic is still being transcribed.` });
  });
  proc.on('exit', (code) => {
    if (listening && listening.proc === proc && code !== 0 && code !== null) {
      send('status', { error: 'System audio stopped. Your mic is still being transcribed.' });
    }
  });

  listening = { me, them, proc };
  return { ok: true };
}

function stopListening() {
  if (!listening) return;
  listening.me.close();
  listening.them.close();
  try { listening.proc.kill('SIGINT'); } catch {}
  listening = null;
}

ipcMain.handle('listen-start', async () => {
  if (process.platform === 'darwin') {
    const mic = systemPreferences.getMediaAccessStatus('microphone');
    if (mic !== 'granted') {
      const ok = await systemPreferences.askForMediaAccess('microphone');
      if (!ok) return { ok: false, error: 'Aside needs microphone access. Turn it on in System Settings → Privacy & Security → Microphone.', permission: 'mic' };
    }
  }
  return startListening();
});
ipcMain.on('listen-stop', () => stopListening());
ipcMain.on('mic-chunk', (_e, ab) => {
  if (listening) listening.me.write(Buffer.from(ab));
});

// ---------- answering ----------
function systemPrompt() {
  return SYSTEM_PROMPT.replace('{{ABOUT}}', cfg.about?.trim() || '(nothing provided)');
}

// Uses the Claude Code CLI you are already signed in to, so answers come out of
// your Claude plan. One process is kept warm so the first token is quick, and a
// conversation stays in the same process so follow-ups have context.
function findClaude() {
  const candidates = [
    cfg.claudePath,
    path.join(os.homedir(), '.local/bin/claude'),
    path.join(os.homedir(), '.claude/local/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ].filter(Boolean);
  return candidates.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
}

class ClaudeSession {
  constructor() {
    const bin = findClaude();
    if (!bin) throw new Error('Could not find the claude command. Install Claude Code or set its path in Settings.');
    const isolatedCwd = path.join(app.getPath('userData'), 'claude-cwd');
    fs.mkdirSync(isolatedCwd, { recursive: true });
    const { cwd, args } = buildClaudeLaunch({ cfg, home: os.homedir(), isolatedCwd, asidePrompt: systemPrompt() });
    // Leave the default config directory implicit: an explicit override changes
    // Claude Code's credential lookup even when it names the same directory.
    const claudeEnv = { ...process.env, PATH: `${path.dirname(bin)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` };
    delete claudeEnv.CLAUDE_CONFIG_DIR;
    this.proc = spawn(bin, args, {
      cwd,
      env: claudeEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.dead = false;
    this.turn = null;
    this.stderr = '';
    this.proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d.toString()).slice(-2000); });
    const fail = (message) => {
      this.dead = true;
      const turn = this.turn;
      this.turn = null;
      turn?.onError(message);
    };
    this.proc.on('error', (error) => fail(`Claude could not start: ${error.message}`));
    this.proc.stdin.on('error', (error) => {
      fail(`Could not write to Claude: ${error.message}`);
      this.kill();
    });
    this.proc.on('exit', () => {
      this.dead = true;
      if (this.turn) {
        const msg = /log ?in|auth|credential/i.test(this.stderr)
          ? 'Claude Code is not signed in. Run `claude` in Terminal and log in with your Max account.'
          : `Claude stopped unexpectedly. ${this.stderr.trim().split('\n').pop() || ''}`;
        this.turn.onError(msg);
        this.turn = null;
      }
    });
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => this.onLine(line));
  }

  onLine(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (!this.turn) return;
    if (m.type === 'stream_event') {
      const ev = m.event;
      if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') this.turn.onStep?.(ev.content_block.name === 'Skill' ? 'skill' : 'context');
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') this.turn.onDelta(ev.delta.text);
    } else if (m.type === 'result') {
      const t = this.turn;
      this.turn = null;
      if (m.is_error) t.onError(typeof m.result === 'string' ? m.result : 'Claude returned an error.');
      else t.onDone();
    }
  }

  ask(content, handlers) {
    if (this.dead) throw new Error('Claude session ended.');
    this.turn = handlers;
    if (this.turn !== handlers || this.proc.stdin.destroyed) throw new Error('Claude input is unavailable.');
    this.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
  }

  kill() {
    this.dead = true;
    this.turn = null;
    try { this.proc.kill(); } catch {}
  }
}

let session = null;   // the current conversation
let spare = null;     // a warm process waiting for the next conversation

function warmSpare() {
  if (cfg.provider !== 'max' || (spare && !spare.dead)) return;
  try { spare = new ClaudeSession(); } catch { spare = null; }
}

function takeSession() {
  let s = spare && !spare.dead ? spare : new ClaudeSession();
  spare = null;
  setTimeout(warmSpare, 1500);
  return s;
}

function resetConversation() {
  cancelAnswer();
  session?.kill();
  session = null;
  apiHistory = [];
  warmSpare();
}

// Fallback: Anthropic API key, for when you'd rather not use your plan.
let apiHistory = [];
async function askApi(content, h, signal) {
  const messages = [...apiHistory, { role: 'user', content }];
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.model === 'opus' ? 'claude-opus-5-5' : cfg.model === 'haiku' ? 'claude-haiku-5-5' : 'claude-sonnet-5-5',
      max_tokens: 4096,
      stream: true,
      system: systemPrompt(),
      messages,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(res.status === 401 ? 'The Anthropic key was rejected. Check it in Settings.' : `Anthropic error ${res.status}: ${body.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const evt = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = evt.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const j = JSON.parse(line.slice(5));
      if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') { full += j.delta.text; h.onDelta(j.delta.text); }
      if (j.type === 'error') throw new Error(j.error?.message || 'Anthropic stream error');
    }
  }
  if (signal.aborted) return;
  // Keep text-only history so follow-ups stay cheap.
  const textOnly = content.filter((c) => c.type === 'text');
  apiHistory.push({ role: 'user', content: textOnly.length ? textOnly : [{ type: 'text', text: '(screen only)' }] });
  apiHistory.push({ role: 'assistant', content: full || '(no answer)' });
  apiHistory = apiHistory.slice(-12);
  h.onDone();
}

let inflight = null;

function cancelAnswer() {
  const previous = inflight;
  inflight = null;
  if (!previous) return;
  previous.controller.abort();
  if (previous.session) {
    previous.session.kill();
    if (session === previous.session) session = null;
  }
}

ipcMain.on('answer', async (_e, { id, transcript, question, withScreen }) => {
  cancelAnswer();
  const request = { controller: new AbortController(), session: null, screenshotIds: [] };
  inflight = request;
  const current = () => inflight === request && !request.controller.signal.aborted;
  const h = {
    onStep: (step) => { if (current()) send('ai-step', { id, step }); },
    onDelta: (text) => { if (current()) send('ai-delta', { id, text }); },
    onDone: () => { if (current()) { screenshotQueue.consume(request.screenshotIds); inflight = null; send('ai-done', { id }); } },
    onError: (error) => { if (current()) { inflight = null; send('ai-error', { id, error }); } },
  };

  try {
    const content = [];
    await screenshotQueue.settled();
    if (!current()) return;
    const screenshots = screenshotQueue.snapshot();
    request.screenshotIds = screenshots.map(shot => shot.id);
    if (screenshots.length) {
      screenshots.forEach((shot, index) => {
        content.push({ type: 'text', text: `Screenshot ${index + 1} of ${screenshots.length} (capture order; views may overlap):` });
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: shot.data } });
      });
    } else if (withScreen) {
      send('ai-step', { id, step: 'screen' });
      const jpeg = await captureScreen();
      if (!current()) return;
      if (jpeg) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg } });
      else send('status', { error: 'Screenshot was blank. Give Aside Screen Recording permission.', permission: 'screen' });
    }
    if (!current()) return;
    const parts = [];
    if (transcript) parts.push(`<transcript>\n${transcript}\n</transcript>`);
    if (question) parts.push(`My request: ${question}`);
    if (!parts.length) parts.push('No conversation yet. Help with whatever is on my screen.');
    content.push({ type: 'text', text: parts.join('\n\n') });

    send('ai-step', { id, step: 'thinking' });
    if (cfg.provider === 'api') {
      if (!cfg.anthropicKey) throw new Error('Add an Anthropic API key in Settings, or switch back to your Claude plan.');
      await askApi(content, h, request.controller.signal);
    } else {
      if (!session || session.dead) session = takeSession();
      request.session = session;
      session.ask(content, h);
    }
  } catch (err) {
    if (request.session) {
      request.session.kill();
      if (session === request.session) session = null;
    }
    if (err.name !== 'AbortError') h.onError(err.message || String(err));
  }
});

ipcMain.on('clear', () => {
  screenshotQueue.clear();
  transcriptEpoch++;
  if (listening) {
    listening.me.close();
    listening.them.close();
    listening.me = openTranscriber('me');
    listening.them = openTranscriber('them');
  }
  resetConversation();
});

// ---------- settings IPC ----------
ipcMain.handle('pick-project', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose a project', properties: ['openDirectory'],
    defaultPath: cfg.projectPath || path.join(os.homedir(), 'Desktop'),
  });
  return result.canceled ? null : { path: fs.realpathSync(result.filePaths[0]) };
});
ipcMain.handle('get-settings', () => ({
  ...cfg,
  transcriptEpoch,
  deepgramKey: cfg.deepgramKey ? '••••••••' + cfg.deepgramKey.slice(-4) : '',
  anthropicKey: cfg.anthropicKey ? '••••••••' + cfg.anthropicKey.slice(-4) : '',
  hasDeepgram: !!cfg.deepgramKey,
  claudeFound: !!findClaude(),
  localReady: (() => {
    const { binary, model } = localPaths();
    try {
      fs.accessSync(binary, fs.constants.X_OK);
      fs.accessSync(model, fs.constants.R_OK);
      fs.accessSync(helperPath(), fs.constants.X_OK);
      return true;
    } catch { return false; }
  })(),
}));
ipcMain.handle('save-settings', (_e, next) => {
  const merged = { ...cfg };
  for (const k of ['provider', 'model', 'about', 'claudePath', 'transcription', 'onboardingDone', 'useHarness', 'projectPath']) if (k in next) merged[k] = next[k];
  for (const k of SECRET_KEYS) {
    if (typeof next[k] === 'string' && !next[k].startsWith('••')) merged[k] = next[k].trim();
  }
  if (!['local', 'deepgram'].includes(merged.transcription)) throw new Error('Unknown transcription provider.');
  merged.useHarness = merged.useHarness !== false;
  if (typeof merged.projectPath !== 'string') throw new Error('Choose a valid project folder.');
  if (merged.projectPath) {
    merged.projectPath = fs.realpathSync(merged.projectPath);
    if (!fs.statSync(merged.projectPath).isDirectory()) throw new Error('Project must be a folder.');
  }
  stopListening();
  cfg = merged;
  saveConfig(cfg);
  // Prompt or model may have changed: start fresh processes.
  spare?.kill(); spare = null;
  resetConversation();
  return { ok: true };
});

// ---------- app ----------
function createTray() {
  let icon = nativeImage.createFromPath(path.join(__dirname, 'renderer', 'trayTemplate.png'));
  if (icon.isEmpty()) {
    // Embedded PNG keeps the menu bar available even without renderer assets.
    icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAAO0lEQVR4nGNgGGrgPxqmiiFkGza4DMKmkSzDBpdB+DSQZBiuQCY50KniImIUEmXY4DKIlICkOCPTHgAABOJVq0xaVB8AAAAASUVORK5CYII=');
  }
  icon = icon.resize({ width: 18, height: 18 });
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Aside');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / Hide   ⌘\\', click: toggleOverlay },
    { label: 'Settings', click: () => { showOverlay(); send('hotkey', 'settings'); } },
    { type: 'separator' },
    { label: 'Quit Aside', click: () => app.quit() },
  ]));
}

app.whenReady().then(() => {
  cfg = loadConfig();
  createWindow();
  createTray();
  globalShortcut.register('CommandOrControl+\\', toggleOverlay);
  const captureShortcuts = {
    'CommandOrControl+Alt+S': () => { void queueScreenshot(); },
    'CommandOrControl+Alt+P': () => { showOverlay(); send('hotkey', 'screenshots-preview'); },
    'CommandOrControl+Alt+Backspace': () => screenshotQueue.removeLast(),
    'CommandOrControl+Alt+Shift+Backspace': () => screenshotQueue.clear(),
  };
  for (const [accelerator, action] of Object.entries(captureShortcuts)) {
    if (!globalShortcut.register(accelerator, action)) send('status', { error: `Screenshot shortcut unavailable: ${accelerator}` });
  }
  setTimeout(warmSpare, 2000);
});

app.on('activate', () => {
  if (!app.isReady()) return;
  if (!win || win.isDestroyed()) createWindow();
  else showOverlay();
});
app.on('second-instance', () => {
  if (win && !win.isDestroyed()) showOverlay();
});
app.on('will-quit', () => {
  cancelAnswer();
  globalShortcut.unregisterAll();
  stopListening();
  session?.kill();
  spare?.kill();
});
app.on('window-all-closed', (e) => e.preventDefault());
