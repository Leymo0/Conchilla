// Conchilla on Android: stands in for the desktop app's Electron bridge (preload.js), so the
// same pages run on a phone. Joining and watching work like on PC; hosting stays on the PC app.
//   - settings live in the phone's app storage
//   - the "overlay" (holocall chat cards + chat box) is a see-through layer over the stream
//   - fullscreen, keep-screen-on, back button and updates go through the Android side
(function () {
  const DEFAULTS = window.CONCHILLA_DEFAULTS;
  const VERSION = window.CONCHILLA_VERSION;
  const KEY = 'conchilla.settings';
  const cap = window.Capacitor;
  const plugin = (name) => (cap && cap.registerPlugin ? cap.registerPlugin(name) : null);
  const Native = plugin('ConchillaNative');
  const CapApp = plugin('App');
  const call = (p, fn, arg) => { try { return p?.[fn]?.(arg)?.catch?.(() => {}); } catch { /* not on a phone (tests) */ } };

  // ---------------------------------------------------------------- settings
  function merge(base, extra) {
    const out = { ...base };
    for (const [k, v] of Object.entries(extra || {})) {
      out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
    }
    return out;
  }
  function read() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } }
  function write(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* full or blocked */ } }
  function load() {
    const s = merge(DEFAULTS, read());
    if (!s.clientId) { s.clientId = crypto.randomUUID(); write(s); }
    return s;
  }
  // phone-friendly first-run defaults: smaller chat cards
  if (!localStorage.getItem(KEY)) write(merge(DEFAULTS, { overlay: { scale: 0.85 } }));

  // ---------------------------------------------------------------- events
  const listeners = {};
  const on = (ch) => (fn) => { (listeners[ch] = listeners[ch] || []).push(fn); };
  const emit = (ch, data) => (listeners[ch] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } });

  // ---------------------------------------------------------------- chat layer over the stream
  let frame = null, frameReady = false;
  const queue = [];
  function overlayFrame() {
    if (frame) return frame;
    frame = document.createElement('iframe');
    frame.id = 'chat-overlay';
    frame.src = 'overlay.html';
    frame.setAttribute('allowtransparency', 'true');
    frame.addEventListener('load', () => { frameReady = true; queue.splice(0).forEach((f) => f()); });
    document.body.appendChild(frame);
    return frame;
  }
  function toFrame(ch, data) {
    const f = overlayFrame();
    const send = () => { try { f.contentWindow.__conchillaIn(ch, data); } catch (e) { console.error(e); } };
    if (frameReady) send(); else queue.push(send);
  }
  const chatOpen = () => document.body.classList.contains('chat-open');
  window.__conchillaFromOverlay = (ch, data) => {
    if (ch === 'from-overlay') emit('overlay:message', data);
    if (ch === 'closed') document.body.classList.remove('chat-open');
  };

  // ---------------------------------------------------------------- updates (APK on GitHub releases)
  const newer = (a, b) => {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
    return false;
  };
  async function latestApk() {
    const r = await fetch('https://api.github.com/repos/Leymo0/Conchilla/releases/latest', { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    const rel = await r.json();
    const apk = (rel.assets || []).find((a) => /\.apk$/i.test(a.name));
    return { version: String(rel.tag_name || '').replace(/^v/, ''), url: apk?.browser_download_url };
  }

  // ---------------------------------------------------------------- the bridge
  let fullscreen = false;
  window.conchilla = {
    getSettings: async () => load(),
    saveSettings: async (patch) => {
      const s = merge(load(), patch);
      write(s);
      if (frame) toFrame('overlay:settings', s);
      return s;
    },
    onSettingsChanged: on('settings:changed'),

    // hosting is PC-only
    captureSources: async () => [],
    selectCapture: async () => true,
    displays: async () => [{ id: 0, label: 'This phone' }],

    showOverlay: () => { overlayFrame(); },
    hideOverlay: () => {},
    toOverlay: (msg) => {
      // chat only (phone in a pocket / next to the laptop): a short buzz for other people's messages
      if (msg.type === 'chat' && !msg.msg?.system && document.body.classList.contains('chat-only')
          && msg.msg?.id !== (typeof Room !== 'undefined' ? Room.me?.id : null)) { try { navigator.vibrate?.(40); } catch { /* no vibration */ } }
      toFrame('overlay:event', msg);
    },
    onOverlayMessage: on('overlay:message'),
    openChat: () => {
      if (chatOpen()) { toFrame('overlay:close'); document.body.classList.remove('chat-open'); return; }
      document.body.classList.add('chat-open');
      toFrame('overlay:open', 'chat');
    },
    openQuick: () => {},
    onQuickHotkey: on('quick:hotkey'),
    overlayMoveMode: () => {},

    hotkeyStatus: async () => [],
    onHotkeyStatus: on('hotkeys:status'),
    pauseHotkeys: () => {},

    platform: 'android',
    appAudioStart: async () => ({ ok: false }),
    appAudioStop: () => {},
    onAppAudioPcm: on('appaudio:pcm'),

    runUpdate: async () => {
      try {
        const rel = await latestApk();
        if (!rel.url || !newer(rel.version, VERSION)) return { ok: true, version: VERSION };
        call(Native, 'openUrl', { url: rel.url });
        return { message: `Downloading ${rel.version}… tap the download when it finishes to install`, kind: 'busy' };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    pendingUpdate: async () => null,
    onUpdateProgress: on('update:progress'),
    appVersion: async () => VERSION,
    openUrl: (url) => { if (/^https:\/\/github\.com\/Leymo0\//.test(url)) call(Native, 'openUrl', { url }); },
    fullscreen: (want) => {
      fullscreen = want == null ? !fullscreen : !!want;
      document.body.classList.toggle('fullscreen', fullscreen);
      call(Native, 'setImmersive', { on: fullscreen });
      call(Native, 'setOrientation', { mode: fullscreen ? 'landscape' : 'any' });
    },
  };

  // ---------------------------------------------------------------- phone-only bits of the pages
  const $ = (id) => document.getElementById(id);
  function adaptPages() {
    // menu: no hosting from a phone, phone tips
    const host = $('go-host');
    if (host) {
      host.disabled = true;
      host.querySelector('.choice-desc').textContent = 'Hosting is on the PC app. On your phone you can join and watch.';
    }
    const tips = document.querySelector('.tips');
    if (tips) {
      tips.innerHTML = `
        <div><b>Watching:</b> tap the picture for the controls, double-tap for fullscreen.</div>
        <div><b>Black bars?</b> Pinch to zoom, drag to move the picture.</div>
        <div><b>Chat:</b> tap 💬 while watching; messages pop up over the stream.</div>
        <div><b>Watching on your laptop?</b> Tick <b>Chat only</b> to just chat here — or press <b>📱 Phone</b> in the laptop's lobby and join with that code to type as yourself.</div>
        <b id="tip-chat-key" hidden></b>`;
    }
    // no game hotkeys on a phone
    window.refreshChatHints = () => {
      for (const id of ['host-chat-hint', 'lobby-chat-hint']) { const el = $(id); if (el) el.textContent = ''; }
    };
    // settings: only the chat-card options make sense on a phone
    const panels = document.querySelectorAll('#view-settings .panel');
    if (panels[0]) panels[0].hidden = true;                       // hotkeys
    for (const id of ['ov-pinned', 'ov-display', 'ov-move', 'ov-test']) {
      const el = $(id); const row = el?.closest('label') || el;
      if (row) row.hidden = true;
    }
    const ovPanel = panels[1];
    if (ovPanel) {
      ovPanel.querySelector('h2').lastChild.textContent = ' Chat over the stream';
      const note = ovPanel.querySelector('p.muted');
      if (note) note.textContent = 'Messages pop up as holocall cards over the stream and fade away by themselves.';
    }
    $('w-full')?.setAttribute('title', 'Fullscreen (landscape)');
  }

  // lobby chat as a phone chat app: ⛶ full-screen chat, 👥 people, ▶ watch, the box stays above the keyboard
  function chatTools() {
    const panel = document.querySelector('#view-lobby .chat-panel');
    if (!panel) return;
    const log = $('lobby-chat');
    const tools = document.createElement('div');
    tools.id = 'chat-tools';
    tools.innerHTML = '<button id="ct-people" class="small" type="button">👥 <span id="ct-count">0</span></button>'
      + '<button id="ct-watch" class="small" type="button" hidden>▶ Watch</button>'
      + '<button id="ct-full" class="small" type="button" title="Full-screen chat">⛶</button>';
    panel.querySelector('h2').appendChild(tools);
    const toBottom = () => { log.scrollTop = log.scrollHeight; };
    $('ct-full').onclick = () => { document.body.classList.toggle('chat-full'); document.body.classList.remove('show-people'); setTimeout(toBottom, 50); };
    $('ct-people').onclick = () => document.body.classList.toggle('show-people');
    $('ct-watch').onclick = () => $('rewatch').click();
    const sync = () => {
      $('ct-count').textContent = $('lobby-count').textContent || '0';
      $('ct-watch').hidden = $('rewatch').hidden;
    };
    new MutationObserver(sync).observe($('lobby-roster'), { childList: true });
    new MutationObserver(sync).observe($('rewatch'), { attributes: true, attributeFilter: ['hidden'] });
    // chat only opens straight into the full-screen chat
    let wasChatOnly = false;
    new MutationObserver(() => {
      const now = document.body.classList.contains('chat-only');
      if (now && !wasChatOnly) document.body.classList.add('chat-full');
      if (!now && wasChatOnly) document.body.classList.remove('chat-full', 'show-people');
      wasChatOnly = now;
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    // typing: hide everything else so the keyboard doesn't squeeze the chat away
    const input = panel.querySelector('.chat-form input');
    input.addEventListener('focus', () => { document.body.classList.add('typing'); setTimeout(toBottom, 300); });
    input.addEventListener('blur', () => document.body.classList.remove('typing'));
    window.addEventListener('resize', () => { if (document.body.classList.contains('typing')) toBottom(); });
    // the send button mustn't close the keyboard
    panel.querySelector('.chat-send').addEventListener('pointerdown', (e) => e.preventDefault());
    panel.querySelector('.chat-form').addEventListener('submit', () => setTimeout(toBottom, 50));
  }

  // keep the screen on while in a room; back button walks back through the screens
  function watchViews() {
    let last = null;
    new MutationObserver(() => {
      const view = document.body.dataset.view;
      if (view === last) return;
      last = view;
      call(Native, 'keepAwake', { on: view === 'watch' || view === 'lobby' });
      if (view !== 'watch' && fullscreen) window.conchilla.fullscreen(false);
      if (view !== 'watch' && chatOpen()) window.conchilla.openChat();
    }).observe(document.body, { attributes: true, attributeFilter: ['data-view'] });
  }

  function backButton() {
    if (!CapApp) return;
    try {
      CapApp.addListener('backButton', () => {
        const view = document.body.dataset.view;
        if (!$('modal').hidden) { $('modal').hidden = true; return; }
        if (chatOpen()) { window.conchilla.openChat(); return; }
        if (view === 'watch') { if (fullscreen) window.conchilla.fullscreen(false); else Room.setWatching(false); return; }
        if (view === 'lobby') { $('lobby-leave').click(); return; }
        if (view === 'settings') { document.querySelector('#view-settings [data-go]').click(); return; }
        call(CapApp, 'minimizeApp');
      });
    } catch { /* not on a phone */ }
  }

  async function quietUpdateCheck() {
    try {
      const rel = await latestApk();
      if (rel.url && newer(rel.version, VERSION)) {
        const el = $('update-status');
        el.hidden = false;
        el.className = 'update-status busy';
        el.textContent = `Update ${rel.version} available — tap Check for updates`;
      }
    } catch { /* offline: fine */ }
  }

  document.addEventListener('DOMContentLoaded', () => {
    adaptPages();
    chatTools();
    watchViews();
    backButton();
    setTimeout(quietUpdateCheck, 3000);
  });
})();
