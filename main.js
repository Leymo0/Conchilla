// Conchilla — easy friend-group screen share + in-game neon chat.
//   Main window: profile ("character menu"), host lobby, joiner lobby, watch view.
//   Overlay window: transparent, click-through, pinned on top of games. CapsLock opens
//   its chat box; Enter/Esc gives the keyboard back to the game.

const { app, BrowserWindow, ipcMain, desktopCapturer, session, globalShortcut, screen, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const updater = require('./updater');
const win32 = require('./win32');
const { spawn } = require('child_process');

// Separate profile folder (testing several copies on one PC)
if (process.env.CONCHILLA_PROFILE) app.setPath('userData', process.env.CONCHILLA_PROFILE);

let win = null;       // main window
let overlay = null;   // chat overlay

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  name: '',
  face: 'cat',
  color: 'cyan',           // preferred colour; the host gives you another one if it's taken
  clientId: null,          // lets the host recognise you after a crash / reconnect
  hotkeys: { chat: 'Capslock', stats: 'F7', fullscreen: 'F11' },
  overlay: {
    pinned: true,          // stay on top of games / other programs
    corner: 'top-right',   // where the chat sits
    display: null,         // monitor id (null = the main one)
    offsetX: 24, offsetY: 24,
    fadeSeconds: 5,
    scale: 1,
  },
  host: {
    resolution: '1080',    // 'native' | '1440' | '1080' | '900' | '720' (by height: ultrawide keeps its shape)
    fps: 60,
    bitrate: 0,            // Mbps, 0 = auto
    codec: 'auto',         // 'auto' (H.264) | 'h264' | 'av1' | 'vp9' | 'vp8'
    content: 'game',       // 'game' (smooth motion) | 'movie' | 'text' (sharp detail)
    audio: true,
    audioKbps: 256,
    maxViewers: 8,
    sourceId: null,
  },
  viewer: { bufferMs: 150, zoom: 0, panX: 50, panY: 50, volume: 0.9, showStats: true },
};

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
      ? merge(base[k], v) : v;
  }
  return out;
}

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { /* first run */ }
  const s = merge(DEFAULT_SETTINGS, saved);
  if (!s.clientId) {
    s.clientId = require('crypto').randomUUID();
    try { fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2)); } catch { /* fine */ }
  }
  return s;
}

function saveSettings(patch) {
  const next = merge(loadSettings(), patch);
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:save', (_e, patch) => {
  const s = saveSettings(patch);
  if (patch.hotkeys) registerHotkeys();
  if (patch.overlay) placeOverlay();
  overlay?.webContents.send('overlay:settings', s);
  return s;
});

// ---------------------------------------------------------------------------
// Screen capture: the host page asks for the screen, we hand it the source picked in the app
// ---------------------------------------------------------------------------

// (CONCHILLA_SCREENS_ONLY: test machines without a window manager can't list windows)
const SOURCE_TYPES = process.env.CONCHILLA_SCREENS_ONLY ? ['screen'] : ['screen', 'window'];

ipcMain.handle('capture:sources', async () => {
  const sources = await desktopCapturer.getSources({ types: SOURCE_TYPES, thumbnailSize: { width: 320, height: 180 } });
  const own = new Set([win, overlay].filter(Boolean).map((w) => w.getMediaSourceId?.()));
  return sources
    .filter((s) => !own.has(s.id) && !/^Conchilla( Chat)?$/.test(s.name))
    .map((s) => {
      const size = s.thumbnail.getSize();
      return { id: s.id, name: s.name, screen: s.id.startsWith('screen:'), aspect: size.height ? size.width / size.height : 16 / 9, thumbnail: s.thumbnail.toDataURL() };
    });
});

let captureRequest = { sourceId: null, audio: true };
ipcMain.handle('capture:select', (_e, req) => { captureRequest = req; return true; });

// ---------------------------------------------------------------------------
// Overlay chat window
// ---------------------------------------------------------------------------

const OVERLAY_W = 460, OVERLAY_H = 640;

function overlayBounds(s) {
  const o = s.overlay;
  const display = screen.getAllDisplays().find((d) => String(d.id) === String(o.display)) || screen.getPrimaryDisplay();
  const a = display.workArea;
  const w = Math.round(OVERLAY_W * (o.scale || 1)), h = Math.round(OVERLAY_H * (o.scale || 1));
  const right = o.corner.endsWith('right'), bottom = o.corner.startsWith('bottom');
  return {
    x: Math.round(right ? a.x + a.width - w - o.offsetX : a.x + o.offsetX),
    y: Math.round(bottom ? a.y + a.height - h - o.offsetY : a.y + o.offsetY),
    width: w, height: h,
  };
}

function createOverlay() {
  if (overlay && !overlay.isDestroyed()) return overlay;
  const s = loadSettings();
  overlay = new BrowserWindow({
    ...overlayBounds(s),
    title: 'Conchilla Chat',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: false,        // never steals the keyboard unless the chat box is open
    hasShadow: false,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  overlay.setIgnoreMouseEvents(true);
  applyPin(s.overlay.pinned);
  overlay.loadFile(path.join(__dirname, 'overlay.html'));
  overlay.once('ready-to-show', () => overlay.showInactive());
  overlay.on('closed', () => { overlay = null; });
  return overlay;
}

function applyPin(pinned) {
  if (!overlay) return;
  // 'screen-saver' is the highest level: stays above borderless-fullscreen games
  overlay.setAlwaysOnTop(!!pinned, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces?.(!!pinned, { visibleOnFullScreen: true });
}

function placeOverlay() {
  if (!overlay) return;
  const s = loadSettings();
  overlay.setBounds(overlayBounds(s));
  applyPin(s.overlay.pinned);
}

let chatOpen = false;

function openChat() {
  const o = createOverlay();
  if (chatOpen) { closeChat(false); return; }   // second press closes it again (draft is kept)
  chatOpen = true;
  win32.remember();                             // the game (or whatever had the keyboard)
  o.setIgnoreMouseEvents(false);
  o.setFocusable(true);
  o.showInactive();
  o.focus();
  o.webContents.focus();
  o.webContents.send('overlay:open');
}

function closeChat(fromOverlay = true) {
  if (!overlay || !chatOpen) return;
  chatOpen = false;
  if (!fromOverlay) overlay.webContents.send('overlay:close');
  overlay.setIgnoreMouseEvents(true);
  overlay.setFocusable(false);
  // Give the keyboard back to the game
  if (!win32.restore()) overlay.blur();
}

ipcMain.on('overlay:closed', () => closeChat(true));
ipcMain.on('chat:open', () => openChat());
ipcMain.on('overlay:show', () => createOverlay());
ipcMain.on('overlay:hide', () => { if (overlay) overlay.destroy(); overlay = null; chatOpen = false; });

// Positioning mode: the overlay becomes a draggable box until "Done"
ipcMain.on('overlay:move-mode', (_e, on) => {
  const o = createOverlay();
  o.setIgnoreMouseEvents(!on);
  o.setFocusable(!!on);
  o.setMovable(!!on);
  o.webContents.send('overlay:move-mode', !!on);
  if (on) o.focus();
  else {
    // Save where it was dropped, as an offset from the nearest corner
    const b = o.getBounds();
    const d = screen.getDisplayMatching(b), a = d.workArea;
    const right = b.x + b.width / 2 > a.x + a.width / 2, bottom = b.y + b.height / 2 > a.y + a.height / 2;
    const ov = {
      display: d.id,
      corner: `${bottom ? 'bottom' : 'top'}-${right ? 'right' : 'left'}`,
      offsetX: Math.max(0, right ? a.x + a.width - b.x - b.width : b.x - a.x),
      offsetY: Math.max(0, bottom ? a.y + a.height - b.y - b.height : b.y - a.y),
    };
    const s = saveSettings({ overlay: ov });
    win?.webContents.send('settings:changed', s);
  }
});

// Main window ↔ overlay messages (chat lines, roster, what I type)
ipcMain.on('to-overlay', (_e, msg) => overlay?.webContents.send('overlay:event', msg));
ipcMain.on('from-overlay', (_e, msg) => win?.webContents.send('overlay:message', msg));

ipcMain.handle('displays', () => screen.getAllDisplays().map((d, i) => ({
  id: d.id, label: `Screen ${i + 1} · ${d.size.width}×${d.size.height}${d.id === screen.getPrimaryDisplay().id ? ' (main)' : ''}`,
})));

// ---------------------------------------------------------------------------
// Hotkeys (global: work while a game has the keyboard)
// ---------------------------------------------------------------------------

let hotkeyErrors = [];
function registerHotkeys() {
  globalShortcut.unregisterAll();
  hotkeyErrors = [];
  const { hotkeys } = loadSettings();
  if (hotkeys.chat) {
    try {
      if (!globalShortcut.register(hotkeys.chat, openChat)) hotkeyErrors.push(hotkeys.chat);
    } catch { hotkeyErrors.push(hotkeys.chat); }
  }
  win?.webContents.send('hotkeys:status', hotkeyErrors);
}
ipcMain.handle('hotkeys:status', () => hotkeyErrors);
// While recording a new key in Settings, the old one must not fire
ipcMain.on('hotkeys:pause', (_e, paused) => (paused ? globalShortcut.unregisterAll() : registerHotkeys()));

// ---------------------------------------------------------------------------
// Updates (GitHub releases of Leymo0/Conchilla)
// ---------------------------------------------------------------------------

let updateRunning = null;
ipcMain.handle('update:run', () => {
  if (updateRunning) return updateRunning;
  updateRunning = (async () => {
    const progress = (t) => win?.webContents.send('update:progress', t);
    try {
      progress('Checking for a new version…');
      const check = await updater.checkAppUpdate();
      if (!check.available) return { ok: true, latest: true, version: app.getVersion(), dev: check.dev };
      await updater.downloadAppUpdate(progress);
      saveSettings({ justUpdatedFrom: app.getVersion() });
      progress(`Installing Conchilla ${check.version}… it will reopen by itself`);
      setTimeout(() => {
        for (const w of BrowserWindow.getAllWindows()) w.destroy();
        updater.installAppUpdateAndRestart();
      }, 1200);
      return { ok: true, restarting: true, version: check.version };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  })().finally(() => { updateRunning = null; });
  return updateRunning;
});
ipcMain.handle('update:pending', () => {
  const { justUpdatedFrom } = loadSettings();
  if (!justUpdatedFrom) return null;
  saveSettings({ justUpdatedFrom: null });
  return { from: justUpdatedFrom, to: app.getVersion() };
});
ipcMain.handle('app:version', () => app.getVersion());
// ---------------------------------------------------------------------------
// App-only sound: native/conchilla-audio.exe records one program's audio (include) or
// everything except one program (exclude) and streams raw PCM to the host page.
// ---------------------------------------------------------------------------

const AUDIO_HELPER = app.isPackaged
  ? path.join(process.resourcesPath, 'bin', 'conchilla-audio.exe')
  : path.join(__dirname, 'native', 'bin', 'conchilla-audio.exe');
let audioProc = null;

function stopAppAudio() {
  const p = audioProc;
  audioProc = null;
  if (!p) return;
  try { p.stdin.end(); } catch { /* gone */ }
  setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 500);
}

ipcMain.handle('appaudio:start', async (e, { mode, sourceId }) => {
  stopAppAudio();
  if (process.platform !== 'win32') return { ok: false, reason: 'windows-only' };
  if (!fs.existsSync(AUDIO_HELPER)) return { ok: false, reason: 'helper missing' };
  const pid = mode === 'include' ? win32.pidOfWindow(sourceId) : win32.discordPid();
  if (!pid) return { ok: false, reason: mode === 'include' ? 'no-app' : 'no-discord' };

  const p = spawn(AUDIO_HELPER, [mode, String(pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  audioProc = p;
  const sender = e.sender;
  let leftover = Buffer.alloc(0);
  p.stdout.on('data', (chunk) => {
    if (audioProc !== p || sender.isDestroyed()) return;
    // whole stereo frames only (4 bytes each)
    let buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
    const usable = buf.length - (buf.length % 4);
    leftover = buf.subarray(usable);
    if (usable) sender.send('appaudio:pcm', buf.subarray(0, usable));
  });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (res) => { if (!settled) { settled = true; resolve(res); } };
    let errText = '';
    p.stderr.on('data', (d) => {
      const text = d.toString();
      errText += text;
      if (/READY/.test(text)) finish({ ok: true, pid });
      const m = /ERR (\S+) (\S+)/.exec(text);
      if (m) finish({ ok: false, reason: `${m[1]} ${m[2]}` });
    });
    p.on('error', (err) => finish({ ok: false, reason: err.message }));
    p.on('exit', (code) => {
      if (audioProc === p) audioProc = null;
      finish({ ok: false, reason: `stopped (${code}) ${errText.trim()}` });
    });
    setTimeout(() => finish({ ok: false, reason: 'timeout' }), 8000);
  }).then((res) => { if (!res.ok) { updater.updateLog('app audio failed', res.reason); if (audioProc === p) stopAppAudio(); } return res; });
});
ipcMain.on('appaudio:stop', () => stopAppAudio());
app.on('will-quit', stopAppAudio);

ipcMain.on('open:url', (_e, url) => { if (/^https:\/\/github\.com\/Leymo0\//.test(url)) shell.openExternal(url); });
ipcMain.on('window:fullscreen', (_e, on) => win?.setFullScreen(on == null ? !win.isFullScreen() : !!on));

// ---------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 820, minWidth: 980, minHeight: 620,
    backgroundColor: '#020a0d',
    title: 'Conchilla',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('closed', () => {
    win = null;
    if (overlay) overlay.destroy();
    app.quit();
  });
}

const testMode = !!process.env.CONCHILLA_TEST;
const gotLock = testMode || app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => {
    if (!win) { createWindow(); return; }
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
  });
}

// Smooth 60 fps playback even when the window is behind a game
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

app.whenReady().then(() => {
  if (!gotLock) return;
  updater.updateLog(`start ${app.getVersion()}`);

  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    const sources = await desktopCapturer.getSources({ types: SOURCE_TYPES });
    const source = sources.find((s) => s.id === captureRequest.sourceId)
                || sources.find((s) => s.id.startsWith('screen:'));
    if (!source) { callback({}); return; }
    // 'loopback' = the PC's sound (Windows). Movie / game audio goes to everyone.
    callback({ video: source, audio: captureRequest.audio && process.platform === 'win32' ? 'loopback' : undefined });
  });

  createWindow();
  registerHotkeys();
  screen.on('display-metrics-changed', placeOverlay);
  screen.on('display-removed', placeOverlay);
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
