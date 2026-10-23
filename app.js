// App shell: character menu, settings, hotkeys, updates, navigation.

const $ = (id) => document.getElementById(id);
const api = window.conchilla;
let settings = null;

function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  document.body.dataset.view = name;
}
const currentView = () => document.body.dataset.view;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function modal(title, text) {
  $('modal-title').textContent = title;
  $('modal-text').textContent = text;
  $('modal').hidden = false;
  $('modal-ok').focus();
}

async function save(patch) {
  settings = await api.saveSettings(patch);
  return settings;
}

// ---------- hotkeys: KeyboardEvent ↔ Electron accelerator ("Ctrl+Shift+F7", "Capslock") ----------

const CODE_NAMES = {
  CapsLock: 'Capslock', Space: 'Space', Tab: 'Tab', Backquote: '`', Minus: '-', Equal: '=',
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ScrollLock: 'Scrolllock', Pause: 'Pause', NumLock: 'Numlock', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Enter: 'Enter', Backspace: 'Backspace',
};

function keyFromEvent(e) {
  const c = e.code;
  let key = CODE_NAMES[c];
  if (!key && /^Key[A-Z]$/.test(c)) key = c.slice(3);
  if (!key && /^Digit\d$/.test(c)) key = c.slice(5);
  if (!key && /^F\d{1,2}$/.test(c)) key = c;
  if (!key && /^Numpad\d$/.test(c)) key = 'num' + c.slice(6);
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey && c !== 'ControlLeft' && c !== 'ControlRight') mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return [...mods, key].join('+');
}

const prettyKey = (acc) => (acc || 'none').replace('Capslock', 'Caps Lock').replace(/\+/g, ' + ');
const matchesKey = (e, acc) => !!acc && keyFromEvent(e) === acc;

function initHotkeys() {
  const render = () => document.querySelectorAll('[data-hotkey]').forEach((b) => {
    b.textContent = prettyKey(settings.hotkeys[b.dataset.hotkey]);
  });
  render();
  let recording = null;
  document.querySelectorAll('[data-hotkey]').forEach((b) => b.addEventListener('click', () => {
    if (recording) recording.classList.remove('recording');
    recording = b;
    b.classList.add('recording');
    b.textContent = 'press a key… (Esc = cancel)';
    api.pauseHotkeys(true);
  }));
  window.addEventListener('keydown', async (e) => {
    if (!recording) return;
    e.preventDefault(); e.stopPropagation();
    if (['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'].includes(e.code)) return;
    const b = recording; recording = null;
    b.classList.remove('recording');
    if (e.code !== 'Escape') {
      const acc = keyFromEvent(e);
      if (acc) await save({ hotkeys: { [b.dataset.hotkey]: acc } });
    }
    api.pauseHotkeys(false);
    render();
    refreshChatHints();
  }, true);
  const showErrors = (errs) => {
    $('hotkey-error').textContent = errs?.length
      ? `Couldn't grab ${errs.map(prettyKey).join(', ')} — another program is using it. Pick a different key.` : '';
  };
  api.hotkeyStatus().then(showErrors);
  api.onHotkeyStatus(showErrors);
}

function refreshChatHints() {
  const k = prettyKey(settings.hotkeys.chat);
  for (const id of ['host-chat-hint', 'lobby-chat-hint']) $(id).textContent = `· in games press ${k}`;
  $('tip-chat-key').textContent = k;
}

// ---------- character menu ----------

function renderProfile() {
  const name = settings.name || '';
  $('me-name').value = name;
  $('face-grid').innerHTML = Object.entries(FACES).map(([id, f]) =>
    `<button class="face-choice ${id === settings.face ? 'selected' : ''}" data-face="${id}" title="${escapeHtml(f.label)}">
       ${faceSvg(id, settings.color, 64)}<span>${escapeHtml(f.label)}</span></button>`).join('');
  $('color-grid').innerHTML = COLOR_ORDER.map((c) =>
    `<button class="color-choice ${c === settings.color ? 'selected' : ''}" data-color="${c}" title="${c}" style="--c:${COLORS[c]}"></button>`).join('');
  $('me-preview').innerHTML = faceSvg(settings.face, settings.color, 72);
  $('me-preview-name').textContent = name || 'NO NAME YET';
  $('me-preview-name').style.color = colorHex(settings.color);
}

function initProfile() {
  renderProfile();
  $('me-name').addEventListener('input', (e) => {
    const name = e.target.value.replace(/[\r\n\t]/g, '').slice(0, 20);
    $('me-preview-name').textContent = name || 'NO NAME YET';
    clearTimeout(initProfile.t);
    initProfile.t = setTimeout(() => save({ name: name.trim() }), 250);
  });
  $('face-grid').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-face]');
    if (b) { await save({ face: b.dataset.face }); renderProfile(); }
  });
  $('color-grid').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-color]');
    if (b) { await save({ color: b.dataset.color }); renderProfile(); }
  });
  $('join-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });
  $('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('join-btn').click(); });
}

function needName() {
  const name = $('me-name').value.trim();
  if (name) return name;
  $('me-name').focus();
  $('me-name').classList.add('shake');
  setTimeout(() => $('me-name').classList.remove('shake'), 500);
  return null;
}

// ---------- settings screen ----------

async function initSettings() {
  const o = settings.overlay;
  $('ov-pinned').checked = !!o.pinned;
  $('ov-corner').value = o.corner;
  $('ov-fade').value = o.fadeSeconds; $('ov-fade-val').textContent = `${o.fadeSeconds} s`;
  $('ov-scale').value = o.scale; $('ov-scale-val').textContent = `${Math.round(o.scale * 100)}%`;
  const displays = await api.displays();
  $('ov-display').innerHTML = displays.map((d) => `<option value="${d.id}">${escapeHtml(d.label)}</option>`).join('');
  $('ov-display').value = o.display ?? displays.find((d) => /main/.test(d.label))?.id ?? displays[0]?.id;

  $('ov-pinned').onchange = (e) => save({ overlay: { pinned: e.target.checked } });
  $('ov-corner').onchange = (e) => save({ overlay: { corner: e.target.value, offsetX: 24, offsetY: 24 } });
  $('ov-display').onchange = (e) => save({ overlay: { display: Number(e.target.value) } });
  $('ov-fade').oninput = (e) => { $('ov-fade-val').textContent = `${e.target.value} s`; };
  $('ov-fade').onchange = (e) => save({ overlay: { fadeSeconds: Number(e.target.value) } });
  $('ov-scale').oninput = (e) => { $('ov-scale-val').textContent = `${Math.round(e.target.value * 100)}%`; };
  $('ov-scale').onchange = (e) => save({ overlay: { scale: Number(e.target.value) } });

  let moving = false;
  $('ov-move').onclick = () => {
    moving = !moving;
    api.overlayMoveMode(moving);
    $('ov-move').textContent = moving ? '✓ Done moving' : 'Drag to move…';
  };
  $('ov-test').onclick = () => {
    api.showOverlay();
    setTimeout(() => api.toOverlay({ type: 'chat', msg: {
      id: 'test', name: settings.name || 'You', face: settings.face, color: settings.color,
      text: 'Test message — this is how chat shows up over your game.', ts: Date.now() } }), 300);
  };
}

api.onSettingsChanged((s) => {
  settings = s;
  $('ov-corner').value = s.overlay.corner;
  $('ov-display').value = s.overlay.display;
});

// ---------- updates ----------

function updateStatus(text, kind) {
  const el = $('update-status');
  el.hidden = false;
  el.className = 'update-status ' + (kind || '');
  el.textContent = text;
}

async function checkUpdate() {
  $('check-update').disabled = true;
  const res = await api.runUpdate();
  $('check-update').disabled = false;
  if (res.restarting) updateStatus(`Updating to ${res.version}… Conchilla will reopen`, 'busy');
  else if (res.ok) updateStatus(res.dev ? 'Dev copy — updates come from git' : `✓ Up to date (${res.version})`, 'ok');
  else updateStatus(`Couldn't update: ${res.error}`, 'warn');
}

// ---------- boot ----------

document.addEventListener('DOMContentLoaded', async () => {
  settings = await api.getSettings();
  document.body.dataset.view = 'menu';
  api.appVersion().then((v) => { $('app-version').textContent = `Conchilla ${v}`; });
  api.onUpdateProgress((t) => updateStatus(t, 'busy'));
  api.pendingUpdate().then((p) => { if (p) updateStatus(`✓ Updated to ${p.to}`, 'ok'); });
  $('check-update').onclick = checkUpdate;

  initProfile();
  initHotkeys();
  Watch.init();
  refreshChatHints();
  $('open-settings').onclick = () => { initSettings(); showView('settings'); };
  document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => {
    // leaving Settings: stop "drag to move" and hide the test overlay if we're not in a room
    if ($('ov-move').textContent.startsWith('✓')) $('ov-move').click();
    if (!Room.role) api.hideOverlay();
    showView(b.dataset.go);
  }));
  $('modal-ok').onclick = () => { $('modal').hidden = true; };

  $('go-host').onclick = () => {
    const name = needName();
    if (name) Room.host(name);
  };
  $('join-btn').onclick = () => {
    const name = needName();
    if (!name) return;
    const code = $('join-code').value.trim().toUpperCase();
    if (code.length !== 6) { $('join-error').textContent = 'Room codes are 6 letters/numbers'; return; }
    $('join-error').textContent = '';
    Room.join(name, code);
  };
});
