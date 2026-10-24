// The in-game chat: holocall-style cards that fade after a few seconds, and a chat box
// that opens with the chat hotkey (Caps Lock by default).

const api = window.conchilla;
const $ = (id) => document.getElementById(id);
let settings = null, me = null, history = [];
const MAX_CARDS = 4;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function applySettings(s) {
  settings = s;
  const o = s.overlay;
  document.body.classList.toggle('right', o.corner.endsWith('right'));
  document.body.classList.toggle('bottom', o.corner.startsWith('bottom'));
  document.documentElement.style.setProperty('--scale', o.scale || 1);
}

// ---------- incoming message cards ----------

function showCard(msg) {
  const calls = $('calls');
  const color = colorHex(msg.color);
  // Same person talking again while their card is up: add the line to it
  let card = calls.querySelector(`.call[data-id="${CSS.escape(msg.id || '')}"]:not(.leaving)`);
  if (!card || msg.system) {
    card = document.createElement('div');
    card.className = msg.system ? 'call sys' : 'call';
    card.dataset.id = msg.id || '';
    card.style.setProperty('--c', color);
    card.innerHTML = msg.system ? `<div class="sys-line"></div>` : `
      <div class="call-head">
        <span class="dot"></span><span class="label">INCOMING</span>
        <b class="name">${esc(msg.name)}</b>
        <span class="eq"><i></i><i></i><i></i><i></i><i></i><i></i></span>
      </div>
      <div class="call-body">
        <div class="portrait">${faceSvg(msg.face, msg.color, 58)}<span class="scan"></span></div>
        <div class="lines"></div>
      </div>`;
    calls.appendChild(card);
    const cards = calls.querySelectorAll('.call:not(.leaving)');
    if (cards.length > MAX_CARDS) leave(cards[0]);
  }
  if (msg.system) card.querySelector('.sys-line').textContent = msg.text;
  else typeLine(card.querySelector('.lines'), msg.text);
  card.classList.remove('talking'); void card.offsetWidth; card.classList.add('talking');
  clearTimeout(card._t);
  const secs = settings?.overlay.fadeSeconds || 5;
  card._t = setTimeout(() => leave(card), secs * 1000 + Math.min(4000, msg.text.length * 25));
}

function typeLine(container, text) {
  const line = document.createElement('div');
  line.className = 'line';
  container.appendChild(line);
  while (container.children.length > 3) container.firstChild.remove();
  // quick typewriter, done within ~0.6 s however long the message is
  const step = Math.max(1, Math.ceil(text.length / 40));
  let i = 0;
  const tick = () => {
    i = Math.min(text.length, i + step);
    line.textContent = text.slice(0, i);
    if (i < text.length) setTimeout(tick, 15);
  };
  tick();
}

function leave(card) {
  if (card.classList.contains('leaving')) return;
  card.classList.add('leaving');
  setTimeout(() => card.remove(), 700);
}

// ---------- chat box ----------

function renderHistory() {
  $('history').innerHTML = history.slice(-10).map((m) => m.system
    ? `<li class="sys">${esc(m.text)}</li>`
    : `<li>${faceSvg(m.face, m.color, 22, { glow: false })}<b style="color:${colorHex(m.color)}">${esc(m.name)}</b><span>${esc(m.text)}</span></li>`).join('');
}

function renderMe() {
  if (!me) return;
  $('me-face').innerHTML = faceSvg(me.face, me.color, 40);
  $('me-name').textContent = me.name;
  $('me-name').style.color = colorHex(me.color);
  document.documentElement.style.setProperty('--me', colorHex(me.color));
}

function open() {
  renderHistory();
  $('composer').hidden = false;
  document.body.classList.add('open');
  const input = $('compose');
  setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 30);
}

function close(keepDraft) {
  if ($('composer').hidden) return;
  if (!keepDraft) $('compose').value = '';
  $('composer').hidden = true;
  document.body.classList.remove('open');
  $('compose').blur();
  api.overlayClosed();
}

$('compose-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('compose').value.trim();
  if (text) api.fromOverlay({ type: 'send', text });
  close(false);
});
$('compose').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); close(false); }
});
window.addEventListener('blur', () => { close(true); closeQuick(); });   // clicked back into the game

// ---------- F8 quick stream menu (host) ----------

let quickState = null;
function renderQuick() {
  const st = quickState;
  if (!st) return;
  document.querySelectorAll('[data-q]').forEach((el) => {
    const key = el.dataset.q;
    if (el.tagName === 'SELECT') {
      const sig = JSON.stringify(st.options[key]);
      if (el._sig !== sig) {
        el.innerHTML = st.options[key].map((o) => `<option value="${esc(o.v)}" ${o.d ? 'disabled' : ''}>${esc(o.l)}</option>`).join('');
        el._sig = sig;
      }
    }
    if (document.activeElement !== el) el.value = st.values[key];
  });
  const b = Number(document.querySelector('[data-q="bitrate"]').value);
  $('q-bitrate-label').textContent = b > 0 ? `${b} Mbps` : `Auto (${st.autoMbps} Mbps)`;
  $('q-status').innerHTML = st.streaming
    ? `<b class="live">● LIVE</b> ${esc(st.sending)} · ${st.watchers} watching${st.source ? ` · ${esc(st.source)}` : ''}`
    : `Not streaming${st.source ? ` · ready to share ${esc(st.source)}` : ''}`;
  $('q-warn').hidden = !st.warn;
  $('q-warn').textContent = st.warn || '';
  $('q-stream').textContent = st.streaming ? '■ Stop streaming' : '▶ Start streaming';
  $('q-stream').classList.toggle('stop', st.streaming);
}

document.querySelectorAll('[data-q]').forEach((el) => {
  el.addEventListener('change', () => api.fromOverlay({ type: 'quick-set', key: el.dataset.q, value: el.value }));
  if (el.type === 'range') el.addEventListener('input', () => {
    const v = Number(el.value);
    $('q-bitrate-label').textContent = v > 0 ? `${v} Mbps` : `Auto (${quickState?.autoMbps} Mbps)`;
  });
});
$('q-stream').addEventListener('click', () => api.fromOverlay({ type: 'quick-set', key: 'stream' }));
$('quick').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeQuick(); } });

function openQuick() {
  renderQuick();
  $('quick').hidden = false;
  document.body.classList.add('open');
  setTimeout(() => document.querySelector('[data-q="resolution"]').focus(), 30);
}
function closeQuick() {
  if ($('quick').hidden) return;
  $('quick').hidden = true;
  document.body.classList.remove('open');
  api.overlayClosed();
}

api.onOverlayOpen((kind) => (kind === 'quick' ? openQuick() : open()));
api.onOverlayClose(() => { close(true); closeQuick(); });
api.onOverlaySettings(applySettings);
api.onMoveMode((on) => { $('move-frame').hidden = !on; document.body.classList.toggle('moving', on); });

api.overlayEvents((ev) => {
  if (ev.type === 'me') { me = ev.me; renderMe(); }
  if (ev.type === 'history') { history = ev.list || []; renderHistory(); }
  if (ev.type === 'quick-state') { quickState = ev.state; if (!$('quick').hidden) renderQuick(); }
  if (ev.type === 'chat') {
    history.push(ev.msg);
    if (history.length > 50) history.shift();
    if (!$('composer').hidden) renderHistory();
    showCard(ev.msg);
  }
});

api.getSettings().then((s) => {
  applySettings(s);
  api.fromOverlay({ type: 'hello' });
});
