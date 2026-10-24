// Rooms. The host is the hub: every joiner connects straight to the host's PC (no server
// in the middle). Chat goes through the host to everyone; the stream is sent to each viewer.
//
// Messages (JSON over the data link):
//   joiner → host: chat {text} · watch {on} · hb
//   host → joiner: welcome · roster · chat {msg} · system {text} · stream {on, reason}
//                  kicked {blocked} · denied {reason} · closing · hb

const Room = (() => {
  const MAX_TEXT = 300;
  let peer = null, role = null, code = null;
  let me = null;                     // { id, name, face, color, host }
  let history = [];                  // last chat lines
  let hbTimer = null, statsTimer = null, sourceTimer = null;

  // host state
  const members = new Map();         // id → { id, name, face, color, conn, peerId, call, watching, lastSeen, stats, rate }
  const blocked = new Map();         // id → name
  let locked = false;
  let sealed = false, resealTimer = null, opened = false;
  let hostWarn = '', warnStreak = 0;
  let stream = null, streaming = false, cfg = null;
  let sources = [], sourceTab = 'screen';

  // joiner state
  let conn = null, roster = [], roomState = {}, watching = true;
  let leaving = false, lastHostBeat = 0, retryTimer = null, retries = 0, connectTimer = null;

  const peerOptions = () => ({ config: iceConfig(), debug: 0, ...(settings.peerServer || {}) });
  const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 20) || 'Someone';
  const cleanText = (s) => String(s || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, MAX_TEXT);
  const validFace = (f) => (FACES[f] ? f : 'smile');

  // ======================================================================
  // shared UI: chat + roster
  // ======================================================================

  function chatList() { return role === 'host' ? $('host-chat') : $('lobby-chat'); }

  function renderLine(msg) {
    const li = document.createElement('li');
    if (msg.system) {
      li.className = 'sys';
      li.textContent = msg.text;
    } else {
      li.innerHTML = `${faceSvg(msg.face, msg.color, 30, { glow: false })}
        <div><b style="color:${colorHex(msg.color)}">${escapeHtml(msg.name)}</b>
        <span class="time">${new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        <div class="text"></div></div>`;
      li.querySelector('.text').textContent = msg.text;
    }
    const list = chatList();
    const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 30;
    list.appendChild(li);
    while (list.children.length > 200) list.firstChild.remove();
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  function addChat(msg) {
    history.push(msg);
    if (history.length > 100) history.shift();
    renderLine(msg);
    api.toOverlay({ type: 'chat', msg });
  }

  function system(text) { addChat({ system: true, text, ts: Date.now() }); }

  function syncOverlay() {
    api.toOverlay({ type: 'me', me });
    api.toOverlay({ type: 'history', list: history.slice(-12) });
  }

  // Overlay talks back: it (re)loaded, or I typed something there
  api.onOverlayMessage((m) => {
    if (m.type === 'hello' && me) syncOverlay();
    if (m.type === 'send') sendChat(m.text);
  });

  function sendChat(text) {
    text = cleanText(text);
    if (!text || !me) return;
    if (role === 'host') postChat(me, text);
    else if (conn?.open) conn.send({ t: 'chat', text });
  }

  document.querySelectorAll('[data-chat-form]').forEach((f) => f.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = f.querySelector('input');
    sendChat(input.value);
    input.value = '';
  }));

  function rosterRow(p, opts = {}) {
    const tags = [];
    if (p.host) tags.push('<span class="tag host">HOST</span>');
    if (p.id === me?.id) tags.push('<span class="tag">YOU</span>');
    if (!p.host && (role === 'host' ? streaming : roomState.streaming)) {
      tags.push(p.watching ? '<span class="tag on">WATCHING</span>' : '<span class="tag">LOBBY</span>');
    }
    return `<li data-id="${escapeHtml(p.id)}" style="--c:${colorHex(p.color)}">
      ${faceSvg(p.face, p.color, 40)}
      <div class="who"><b style="color:${colorHex(p.color)}">${escapeHtml(p.name)}</b> ${tags.join(' ')}
        <div class="row-stats">${opts.stats || ''}</div></div>
      ${opts.actions || ''}
    </li>`;
  }

  // ======================================================================
  // HOST
  // ======================================================================

  function host(name) {
    reset();
    role = 'host';
    me = { id: 'host', name, face: settings.face, color: settings.color, host: true };
    locked = false; sealed = false; blocked.clear(); members.clear();
    clearTimeout(resealTimer);
    $('lock-joins').checked = false;
    $('host-chat').innerHTML = '';
    showView('host');
    setHostStatus('Opening room…', 'busy');
    initHostControls();
    openRoom();
    refreshSources();
    sourceTimer = setInterval(() => { if (currentView() === 'host') refreshSources(); }, 5000);
    hbTimer = setInterval(hostBeat, 2000);
    statsTimer = setInterval(hostStats, 2000);
    api.showOverlay();
    setTimeout(syncOverlay, 400);
    renderHost();
  }

  function openRoom() {
    code = randomCode();
    showCode(false);
    peer = new Peer(ROOM_PREFIX + code, peerOptions());
    opened = false;
    peer.on('open', () => {
      if (sealed) { peer.disconnect(); return; }
      setHostStatus('Room open', 'ok');
      if (!opened) system('Room open — press Copy and send the code to your friends');
      else system('🔓 Room unsealed — the code works again');
      opened = true;
    });
    peer.on('connection', onJoin);
    peer.on('disconnected', () => {
      if (sealed) { renderSealState(); return; }   // on purpose: nobody can reach the room
      // Only the "phone book" server dropped; people already in stay connected
      setHostStatus('Reconnecting to the lobby server…', 'busy');
      setTimeout(() => { if (peer && !peer.destroyed && peer.disconnected) peer.reconnect(); }, 1500);
    });
    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') {
        // Our code got taken while sealed (practically never). Before anyone joined: just pick a new one.
        if (!members.size && !streaming) { peer.destroy(); openRoom(); return; }
        sealed = true; renderSealState();
        modal("Couldn't reopen the room", 'Someone else is using this code right now. Close the room and open a new one if a friend needs to get back in.');
        return;
      }
      if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        setHostStatus('Lobby server unreachable — retrying…', 'warn');
        return;
      }
      if (err.type !== 'peer-unavailable') setHostStatus(`Problem: ${err.type}`, 'warn');
    });
  }

  // The code is the room's key: hidden on screen (so it doesn't leak on stream), Copy still works
  function showCode(visible) {
    const el = $('host-code');
    el.textContent = visible ? formatCode(code) : '••••-••••-••••-••••';
    el.classList.toggle('hidden-code', !visible);
  }

  function setHostStatus(text, kind) {
    const el = $('host-status');
    el.textContent = text;
    el.className = `status ${kind || ''}`;
  }

  function takenColors(exceptId) {
    const taken = new Set([me.color]);
    for (const m of members.values()) if (m.id !== exceptId) taken.add(m.color);
    return taken;
  }

  function onJoin(c) {
    const meta = c.metadata || {};
    const id = String(meta.clientId || c.peer).slice(0, 64);
    c.on('open', () => {
      const deny = (reason) => { c.send({ t: 'denied', reason }); setTimeout(() => c.close(), 400); };
      if (blocked.has(id)) return deny('blocked');
      const existing = members.get(id);
      if (!existing && locked) return deny('locked');
      if (!existing && members.size >= (settings.host.maxViewers || 8)) return deny('full');

      const name = cleanName(meta.name);
      const color = existing?.color || pickColor(meta.color, takenColors(id));
      if (!color) return deny('full');
      if (existing) {                         // same person reconnecting (crash, Wi-Fi blip)
        existing.conn.removeAllListeners?.('close');
        try { existing.conn.close(); } catch { /* already gone */ }
        hangUp(existing);
      }
      const m = {
        // id = their private device id (never sent to anyone); pub = what others see
        id, pub: existing?.pub || publicId(), name, face: validFace(meta.face), color, conn: c, peerId: c.peer,
        watching: true, lastSeen: Date.now(), call: null, stats: null, rate: [],
      };
      members.set(id, m);
      c.send({ t: 'welcome', you: { id: m.pub, color }, code, history: history.slice(-40) });
      if (!existing) system(`${name} joined`);
      broadcastRoster();
      if (streaming && m.watching) callMember(m);
      if (streaming && !sealed && settings.host.autoSeal !== false) setTimeout(() => { if (streaming && !sealed) seal('auto'); }, 1500);

      c.on('data', (d) => onGuestData(m, d));
      c.on('close', () => {
        MediaLink.dropConnection(c);
        if (members.get(id)?.conn !== c) return;
        hangUp(m);
        members.delete(id);
        system(`${m.name} left`);
        broadcastRoster();
      });
    });
    c.on('error', () => {});
  }

  function onGuestData(m, d) {
    if (members.get(m.id) !== m || !d || typeof d !== 'object') return;
    m.lastSeen = Date.now();
    if (d.t === 'sig') { MediaLink.handle(m.conn, d, { config: iceConfig() }); return; }
    if (d.t === 'chat') {
      // flood guard: 8 messages per 5 s
      const now = Date.now();
      m.rate = m.rate.filter((t) => now - t < 5000);
      if (m.rate.length >= 8) return;
      m.rate.push(now);
      const text = cleanText(d.text);
      if (text) postChat(m, text);
    } else if (d.t === 'watch') {
      m.watching = !!d.on;
      if (m.watching && streaming) callMember(m);
      if (!m.watching) hangUp(m);
      broadcastRoster();
    }
  }

  function postChat(p, text) {
    const msg = { id: p.pub || p.id, name: p.name, face: p.face, color: p.color, text, ts: Date.now() };
    broadcast({ t: 'chat', msg });
    addChat(msg);
  }

  function broadcast(obj) {
    for (const m of members.values()) if (m.conn.open) { try { m.conn.send(obj); } catch { /* closing */ } }
  }

  function publicRoster() {
    return [
      { id: me.id, name: me.name, face: me.face, color: me.color, host: true },
      ...[...members.values()].map((m) => ({ id: m.pub, name: m.name, face: m.face, color: m.color, watching: m.watching })),
    ];
  }

  function broadcastRoster() {
    const list = publicRoster();
    broadcast({ t: 'roster', members: list, locked, sealed, streaming, stream: streaming ? { w: cfg.w, h: cfg.h, fps: cfg.fps } : null });
    api.toOverlay({ type: 'roster', members: list });
    renderHost();
  }

  function hostBeat() {
    const now = Date.now();
    broadcast({ t: 'hb' });
    for (const m of [...members.values()]) {
      if (now - m.lastSeen > 15000) {          // vanished without saying bye
        try { m.conn.close(); } catch { /* gone */ }
        hangUp(m);
        members.delete(m.id);
        system(`${m.name} lost connection`);
        broadcastRoster();
      }
    }
  }

  // ---------- sealing ----------
  // Sealed = the host drops off the lobby server. Everyone inside stays connected (it's all
  // direct now), but the room no longer exists for anyone else: the code just says "no room".
  function seal(why) {
    if (sealed || !peer) return;
    sealed = true;
    clearTimeout(resealTimer);
    try { peer.disconnect(); } catch { /* already off */ }
    system(why === 'auto' ? '🔒 Room sealed — nobody else can find or reach it now' : '🔒 Room sealed');
    renderSealState();
    broadcastRoster();
  }

  // Let someone back in (same code). Seals again by itself once they're in, or after 3 minutes.
  function unseal() {
    if (!sealed || !peer) return;
    sealed = false;
    if (peer.disconnected) peer.reconnect();
    renderSealState();
    broadcastRoster();
    clearTimeout(resealTimer);
    resealTimer = setTimeout(() => { if (!sealed && streaming && settings.host.autoSeal !== false) seal('auto'); }, 3 * 60 * 1000);
  }

  function renderSealState() {
    if (role !== 'host') return;
    $('seal-btn').textContent = sealed ? '🔓 Unseal' : '🔒 Seal';
    $('seal-btn').title = sealed ? 'Reopen the room with the same code (e.g. someone dropped). Seals again once they are back.'
                                 : 'Drop off the lobby server: nobody else can find or reach the room';
    $('host-code').parentElement.classList.toggle('sealed', sealed);
    if (sealed) setHostStatus('🔒 Sealed', 'ok');
    else if (peer && !peer.disconnected) setHostStatus('Room open', 'ok');
  }

  const byPub = (pub) => [...members.values()].find((m) => m.pub === pub);
  const publicId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');

  function kick(pub, block) {
    const m = byPub(pub);
    if (!m) return;
    const id = m.id;
    try { m.conn.send({ t: 'kicked', blocked: block }); } catch { /* gone */ }
    if (block) blocked.set(id, m.name);
    hangUp(m);
    members.delete(id);
    setTimeout(() => { try { m.conn.close(); } catch { /* gone */ } }, 400);
    system(block ? `${m.name} was kicked and blocked` : `${m.name} was kicked`);
    broadcastRoster();
  }

  function renderHost() {
    if (role !== 'host') return;
    const list = publicRoster();
    $('host-count').textContent = `${list.length}/${(settings.host.maxViewers || 8) + 1}`;
    $('host-roster').innerHTML = list.map((p) => {
      const m = byPub(p.id);
      return rosterRow(p, {
        stats: m ? describeOut(m) : '',
        actions: p.host ? '' : `<div class="row-actions">
          <button class="small" data-kick="${escapeHtml(p.id)}" title="Remove (they can rejoin with the code)">Kick</button>
          <button class="small danger" data-block="${escapeHtml(p.id)}" title="Remove and don't let them back in">Block</button></div>`,
      });
    }).join('');
    $('banned-wrap').hidden = blocked.size === 0;
    $('banned-list').innerHTML = [...blocked.entries()].map(([id, name]) =>
      `<li><div class="who">${escapeHtml(name)}</div><button class="small" data-unblock="${escapeHtml(id)}">Unblock</button></li>`).join('');
    renderSummary();
  }

  function describeOut(m) {
    if (!streaming || !m.watching) return '';
    const s = m.stats;
    if (!m.call || !s || !s.w) return 'connecting…';
    const parts = [`${s.w}×${s.h}`, `${Math.round(s.fps || 0)} fps`];
    if (s.mbps != null) parts.push(`${s.mbps.toFixed(1)} Mbps`);
    if (s.rtt != null) parts.push(`${s.rtt} ms`);
    if (s.limit === 'cpu') parts.push('<span class="warn">⚠ your PC is maxed — lower resolution/fps</span>');
    else if (s.limit === 'bandwidth') parts.push('<span class="warn">⚠ internet limited</span>');
    return parts.join(' · ');
  }

  async function hostStats() {
    if (!streaming) { hostWarn = ''; return; }
    for (const m of members.values()) {
      if (!m.call) continue;
      const s = await readStats(m.call.peerConnection, 'outbound', m.stats).catch(() => null);
      if (s) m.stats = s;
    }
    // Is the host's PC or upload holding the stream back? (needs ~6 s in a row, so blips don't nag)
    const live = [...members.values()].filter((m) => m.call && m.stats?.w);
    const cpu = live.filter((m) => m.stats.limit === 'cpu').length;
    const bw = live.filter((m) => m.stats.limit === 'bandwidth').length;
    const fps = live.length ? Math.round(live.reduce((a, m) => a + (m.stats.fps || 0), 0) / live.length) : 0;
    let warn = '';
    if (live.length && cpu * 2 >= live.length) warn = `⚠ Your PC can't keep up — sending ~${fps} of ${cfg.fps} fps. Lower the frame rate or resolution, or cap your game's FPS.`;
    else if (live.length && bw * 2 >= live.length) warn = '⚠ Your upload can\'t keep up for everyone — lower the bitrate or resolution.';
    warnStreak = warn ? warnStreak + 1 : 0;
    hostWarn = warnStreak >= 3 ? warn : '';
    renderHost();
  }

  // ---------- sources + quality controls ----------

  async function refreshSources() {
    try { sources = await api.captureSources(); } catch { sources = []; }
    renderSources();
  }

  function renderSources() {
    const list = sources.filter((s) => (sourceTab === 'screen' ? s.screen : !s.screen));
    const sel = settings.host.sourceId;
    $('sources').innerHTML = list.length ? list.map((s) => `
      <button class="source ${s.id === sel ? 'selected' : ''}" data-source="${escapeHtml(s.id)}" title="${escapeHtml(s.name)}">
        <img src="${s.thumbnail}" alt=""><span>${escapeHtml(s.name)}</span>
      </button>`).join('') : `<div class="muted small">Nothing here yet — open the game / player and hit Refresh.</div>`;
  }

  let controlsReady = false;
  function initHostControls() {
    const h = settings.host;
    if (!controlsReady) {
      controlsReady = true;
      $('q-resolution').innerHTML = Object.entries(RESOLUTIONS).sort((a, b) => (b[1].h || 9999) - (a[1].h || 9999))
        .map(([k, r]) => `<option value="${k}">${r.label}</option>`).join('');
      $('q-content').innerHTML = Object.entries(CONTENT).map(([k, c]) => `<option value="${k}">${c.label}</option>`).join('');
      const caps = (RTCRtpSender.getCapabilities?.('video')?.codecs || []).map((c) => c.mimeType.replace('video/', '').toUpperCase());
      $('q-codec').innerHTML = Object.entries(CODECS).map(([k, c]) =>
        `<option value="${k}" ${caps.length && !caps.includes(c.mime) ? 'disabled' : ''}>${c.label}${caps.length && !caps.includes(c.mime) ? ' (not on this PC)' : ''}</option>`).join('');

      document.querySelectorAll('.source-tabs .tab').forEach((t) => t.addEventListener('click', () => {
        document.querySelectorAll('.source-tabs .tab').forEach((x) => x.classList.toggle('active', x === t));
        sourceTab = t.dataset.tab;
        renderSources();
      }));
      $('refresh-sources').onclick = refreshSources;
      $('sources').addEventListener('click', async (e) => {
        const b = e.target.closest('[data-source]');
        if (!b) return;
        await save({ host: { sourceId: b.dataset.source } });
        renderSources();
        if (streaming) switchSource();
      });
      const live = async (patch, how) => {
        await save({ host: patch });
        renderSummary();
        if (streaming) how === 'restart' ? restartCalls() : how === 'recapture' ? switchSource() : applyLive();
      };
      $('q-resolution').onchange = (e) => live({ resolution: e.target.value });
      $('q-fps').onchange = (e) => live({ fps: Number(e.target.value) });
      $('q-content').onchange = (e) => live({ content: e.target.value });
      $('q-codec').onchange = (e) => live({ codec: e.target.value }, 'restart');
      $('q-bitrate').oninput = (e) => { settings.host.bitrate = Number(e.target.value); renderSummary(); };
      $('q-bitrate').onchange = (e) => live({ bitrate: Number(e.target.value) });
      $('q-audio').onchange = (e) => {
        const before = settings.host.audio;
        const kbps = Number(e.target.value);
        live({ audio: kbps > 0, audioKbps: kbps || settings.host.audioKbps }, before !== kbps > 0 ? 'recapture' : 'restart');
      };
      $('q-soundfrom').onchange = (e) => live({ soundFrom: e.target.value }, 'recapture');
      $('q-max').onchange = (e) => { const v = Math.min(11, Math.max(1, Number(e.target.value) || 8)); e.target.value = v; live({ maxViewers: v }); };
      $('lock-joins').onchange = (e) => {
        locked = e.target.checked;
        system(locked ? '🔒 Joins locked — nobody new can come in' : '🔓 Joins unlocked');
        broadcastRoster();
      };
      $('host-roster').addEventListener('click', (e) => {
        const k = e.target.closest('[data-kick]'), b = e.target.closest('[data-block]');
        if (k) kick(k.dataset.kick, false);
        if (b) kick(b.dataset.block, true);
      });
      $('banned-list').addEventListener('click', (e) => {
        const u = e.target.closest('[data-unblock]');
        if (u) { blocked.delete(u.dataset.unblock); renderHost(); }
      });
      $('stream-toggle').onclick = () => (streaming ? stopStream('The host stopped streaming') : startStream());
      $('seal-btn').onclick = () => (sealed ? unseal() : seal('manual'));
      $('auto-seal').onchange = (e) => save({ host: { autoSeal: e.target.checked } });
      $('show-code').onclick = () => showCode($('host-code').classList.contains('hidden-code'));
      $('copy-code').onclick = () => { navigator.clipboard.writeText(formatCode(code)); $('copy-code').textContent = 'Copied'; setTimeout(() => { $('copy-code').textContent = 'Copy'; }, 1200); };
      $('host-close').onclick = () => leave();
      $('host-chat-pop').onclick = () => { api.showOverlay(); setTimeout(syncOverlay, 300); api.openChat(); };
    }
    $('q-resolution').value = h.resolution;
    $('q-fps').value = String(h.fps);
    $('q-content').value = h.content;
    $('q-codec').value = h.codec;
    $('q-bitrate').value = h.bitrate;
    $('q-audio').value = h.audio ? String(h.audioKbps) : '0';
    $('q-soundfrom').value = h.soundFrom || 'auto';
    $('q-max').value = h.maxViewers;
    $('auto-seal').checked = h.autoSeal !== false;
    updateStreamButton();
  }

  // What we'd send: real capture size while streaming, otherwise a guess from the picked source
  function plannedConfig() {
    const h = settings.host;
    let srcW = 1920, srcH = 1080;
    const v = stream?.getVideoTracks()[0]?.getSettings();
    if (v?.width) { srcW = v.width; srcH = v.height; } else {
      const src = sources.find((s) => s.id === h.sourceId);
      if (src?.aspect) { srcH = RESOLUTIONS[h.resolution]?.h || 1440; srcW = Math.round(srcH * src.aspect); }
    }
    if (v?.width && cfg?.srcW) { srcW = cfg.srcW; srcH = cfg.srcH; }
    const t = targetSize(srcW, srcH, h.resolution);
    const mbps = h.bitrate > 0 ? h.bitrate : autoMbps(t.w, t.h, h.fps, h.content, h.codec);
    return { srcW, srcH, w: t.w, h: t.h, scale: t.scale, fps: h.fps, mbps, codec: h.codec, content: h.content, audioKbps: h.audio ? h.audioKbps : 0 };
  }

  function renderSummary() {
    const p = plannedConfig();
    const watchers = [...members.values()].filter((m) => m.watching).length;
    $('q-bitrate-val').textContent = settings.host.bitrate > 0 ? `${settings.host.bitrate} Mbps` : `Auto (${p.mbps} Mbps)`;
    const total = p.mbps * Math.max(1, watchers) + (p.audioKbps / 1000) * Math.max(1, watchers);
    $('q-summary').innerHTML = `Sends <b>${p.w}×${p.h}${stream ? '' : ' (≈)'}</b> · ${p.fps} fps · ${CODECS[p.codec].mime} · ~${p.mbps} Mbps per person.
      ${watchers ? `${watchers} watching → you need <b>~${Math.ceil(total)} Mbps upload</b>.` : 'Each extra viewer adds the same again to your upload.'}
      ${total > 40 ? '<span class="warn">That\'s a lot of upload — lower the bitrate or resolution if anyone stutters.</span>' : ''}
      ${hostWarn ? `<div class="host-warn">${escapeHtml(hostWarn)}</div>` : ''}`;
  }

  function updateStreamButton() {
    $('stream-toggle').textContent = streaming ? '■ Stop streaming' : '▶ Start streaming';
    $('stream-toggle').classList.toggle('danger', streaming);
    $('host-preview').hidden = !streaming;
  }

  // ---------- streaming ----------

  const LOOPBACK_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 };

  // Which sound to send: 'app' (only the shared program), 'nodiscord' (everything but
  // Discord, so nobody hears their own voice back) or 'pc' (everything).
  function soundMode() {
    const h = settings.host;
    if (!h.audio) return 'off';
    const isWindow = String(h.sourceId || '').startsWith('window:');
    let m = h.soundFrom || 'auto';
    if (m === 'auto') m = isWindow ? 'app' : 'nodiscord';
    if (m === 'app' && !isWindow) m = 'nodiscord';
    if (api.platform !== 'win32') m = 'pc';
    return m;
  }

  let soundNote = '';
  async function capture() {
    const h = settings.host;
    const mode = soundMode();
    const native = mode === 'app' || mode === 'nodiscord';
    if (!native) AppAudio.stop();
    await api.selectCapture({ sourceId: h.sourceId, audio: mode === 'pc' });
    const s = await navigator.mediaDevices.getDisplayMedia({
      // Generous size limits = always the screen's real size and shape. (Smaller limits can make
      // the capture letterbox an ultrawide screen into a 16:9 frame with black bars baked in.)
      video: { width: { max: 7680 }, height: { max: 4320 }, frameRate: { ideal: h.fps, max: h.fps } },
      audio: mode === 'pc' ? LOOPBACK_AUDIO : false,
    });
    const video = s.getVideoTracks()[0];
    const size = video.getSettings();
    const t = targetSize(size.width, size.height, h.resolution);
    video.contentHint = CONTENT[h.content]?.hint || 'motion';
    // Shrinking to the chosen resolution happens in the encoder (scaleResolutionDownBy in tune()),
    // which always keeps the exact shape — no black bars.
    void t;
    video.onended = () => { if (stream === s) stopStream('The shared window or screen was closed'); };

    soundNote = mode === 'off' ? 'no sound' : mode === 'pc' ? 'sound: whole PC' : '';
    if (native) {
      const r = await AppAudio.start(mode === 'app' ? 'include' : 'exclude', h.sourceId);
      if (r.ok) {
        s.addTrack(r.track);
        soundNote = mode === 'app' ? 'sound: only the shared app' : 'sound: everything except Discord';
      } else if (mode === 'nodiscord' && r.reason === 'no-discord') {
        // Discord isn't running, so there's nothing to leave out: plain PC sound is the same thing
        await addLoopback(s, h.sourceId);
        soundNote = 'sound: whole PC (Discord isn\'t running)';
      } else {
        await addLoopback(s, h.sourceId);
        soundNote = `sound: whole PC — app-only sound didn't work here (${r.reason})`;
      }
    }
    return { s, srcW: size.width, srcH: size.height };
  }

  // Fallback: the whole PC's sound, through a second (audio-only) capture
  async function addLoopback(s, sourceId) {
    try {
      await api.selectCapture({ sourceId, audio: true });
      const extra = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: LOOPBACK_AUDIO });
      extra.getVideoTracks().forEach((t) => t.stop());
      const a = extra.getAudioTracks()[0];
      if (a) { a.contentHint = 'music'; s.addTrack(a); }
    } catch { /* no sound then */ }
  }

  async function startStream() {
    if (!settings.host.sourceId || !sources.some((s) => s.id === settings.host.sourceId)) {
      await refreshSources();
      if (!sources.some((s) => s.id === settings.host.sourceId)) { modal('Pick something to share', 'Click a screen or a window in the Share panel first.'); return; }
    }
    $('stream-toggle').disabled = true;
    try {
      const c = await capture();
      stream = c.s;
      cfg = { srcW: c.srcW, srcH: c.srcH };
      cfg = { ...cfg, ...plannedConfig() };
      streaming = true;
      $('host-preview').srcObject = stream;
      broadcast({ t: 'stream', on: true });
      for (const m of members.values()) if (m.watching) callMember(m);
      system(`▶ Streaming ${cfg.w}×${cfg.h} at ${cfg.fps} fps · ${soundNote}`);
      if (settings.host.autoSeal !== false) seal('auto');
    } catch (err) {
      modal("Couldn't start sharing", err.message || String(err));
    } finally {
      $('stream-toggle').disabled = false;
      updateStreamButton();
      broadcastRoster();
    }
  }

  function stopStream(reason) {
    if (!streaming) return;
    streaming = false;
    for (const m of members.values()) hangUp(m);
    const s = stream; stream = null;
    s?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    AppAudio.stop();
    $('host-preview').srcObject = null;
    broadcast({ t: 'stream', on: false, reason });
    system(`■ ${reason}`);
    updateStreamButton();
    broadcastRoster();
  }

  function callMember(m) {
    hangUp(m);
    if (!stream) return;
    if (!m.conn.open) return;
    const call = MediaLink.call(m.conn, stream, { metadata: { cfg: publicCfg() }, sdpTransform: makeSdpTransform(cfg), config: iceConfig() });
    if (!call) return;
    m.call = call; m.stats = null;
    call.on('close', () => { if (m.call === call) m.call = null; });
    call.on('error', () => {});
    tune(call);
  }

  const publicCfg = () => ({ codec: cfg.codec, audioKbps: cfg.audioKbps, mbps: cfg.mbps, fps: cfg.fps, w: cfg.w, h: cfg.h });

  function hangUp(m) {
    const c = m.call;
    m.call = null;
    try { c?.close(); } catch { /* already closed */ }
  }

  async function tune(call) {
    for (let i = 0; i < 40; i++) {
      const pc = call.peerConnection;
      const sender = pc?.getSenders().find((s) => s.track?.kind === 'video');
      if (sender && pc.connectionState !== 'new') {
        try {
          const v = sender.track.getSettings();
          const p = sender.getParameters();
          if (!p.encodings?.length) p.encodings = [{}];
          p.encodings[0].maxBitrate = Math.round(cfg.mbps * 1e6);
          p.encodings[0].maxFramerate = cfg.fps;
          p.encodings[0].scaleResolutionDownBy = Math.max(1, (v.height || cfg.h) / cfg.h);
          p.encodings[0].networkPriority = 'high';
          p.encodings[0].priority = 'high';
          p.degradationPreference = CONTENT[cfg.content]?.degrade || 'maintain-framerate';
          await sender.setParameters(p);
          const as = pc.getSenders().find((s) => s.track?.kind === 'audio');
          if (as) {
            const ap = as.getParameters();
            if (!ap.encodings?.length) ap.encodings = [{}];
            ap.encodings[0].maxBitrate = (cfg.audioKbps || 256) * 1000;
            ap.encodings[0].priority = 'high';
            await as.setParameters(ap).catch(() => {});
          }
          return;
        } catch { /* not ready yet */ }
      }
      await sleep(400);
    }
  }

  // fps / resolution / bitrate / content: changed on the fly, no reconnect
  async function applyLive() {
    const video = stream?.getVideoTracks()[0];
    if (!video) return;
    const p = plannedConfig();
    cfg = { ...cfg, ...p };
    video.contentHint = CONTENT[cfg.content]?.hint || 'motion';
    await video.applyConstraints({ width: { max: 7680 }, height: { max: 4320 }, frameRate: { max: cfg.fps } }).catch(() => {});
    for (const m of members.values()) if (m.call) tune(m.call);
    broadcastRoster();
  }

  // codec / sound quality: part of the handshake, so everyone gets a fresh call (a short blip)
  function restartCalls() {
    cfg = { ...cfg, ...plannedConfig() };
    for (const m of members.values()) if (m.watching) callMember(m);
  }

  // New window/screen (or sound on/off) while live
  async function switchSource() {
    const old = stream;
    let c;
    try { c = await capture(); } catch (err) { modal("Couldn't switch", err.message); return; }
    stream = c.s;
    cfg = { ...cfg, srcW: c.srcW, srcH: c.srcH };
    cfg = { ...cfg, ...plannedConfig() };
    $('host-preview').srcObject = stream;
    const sameShape = !!old?.getAudioTracks().length === !!stream.getAudioTracks().length;
    for (const m of members.values()) {
      if (!m.call) continue;
      if (!sameShape) { callMember(m); continue; }
      for (const sender of m.call.peerConnection?.getSenders() || []) {
        const next = stream.getTracks().find((t) => t.kind === sender.track?.kind);
        if (next) sender.replaceTrack(next).catch(() => callMember(m));
      }
      tune(m.call);
    }
    old?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    system(`Now sharing ${sources.find((x) => x.id === settings.host.sourceId)?.name || 'a new source'} · ${soundNote}`);
    broadcastRoster();
  }

  // ======================================================================
  // JOINER
  // ======================================================================

  function join(name, roomCode) {
    reset();
    role = 'guest';
    code = roomCode;
    me = { id: settings.clientId, name, face: settings.face, color: settings.color };
    leaving = false; retries = 0; watching = true; roster = []; roomState = {};
    $('join-btn').disabled = true;
    $('join-error').textContent = 'Connecting…';
    peer = new Peer(undefined, peerOptions());
    peer.on('open', () => { if (!conn) connect(); });
    // Off the lobby server is fine while we're connected to a sealed room; otherwise get back on
    peer.on('disconnected', () => { setTimeout(() => { if (!leaving && peer && !peer.destroyed && peer.disconnected && !(roomState.sealed && conn?.open)) peer.reconnect(); }, 1500); });
    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        if (conn?.open || retries > 0) return;           // handled by the retry loop
        fail('No room with that code. Check you pasted all of it — or the host closed the room.');
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        if (!conn?.open && retries === 0) fail("Can't reach the lobby server. Check your internet and try again.");
      }
    });
  }

  function connect() {
    if (leaving || !peer || peer.destroyed) return;
    clearTimeout(connectTimer);
    conn = peer.connect(ROOM_PREFIX + code, {
      reliable: true,
      metadata: { clientId: settings.clientId, name: me.name, face: me.face, color: settings.color },
    });
    const c = conn;
    connectTimer = setTimeout(() => {
      if (c.open || leaving) return;
      if (retries > 0) { scheduleRetry(); return; }
      fail("Couldn't reach that room. Check the code, or ask the host if the room is still open.");
    }, 12000);
    c.on('open', () => {
      clearTimeout(connectTimer);
      retries = 0;
      lastHostBeat = Date.now();
      c.send({ t: 'watch', on: watching });
    });
    c.on('data', (d) => { if (conn === c) onHostData(d); });
    c.on('close', () => { if (conn === c) lost(); });
    c.on('error', () => {});
  }

  function onHostData(d) {
    if (!d || typeof d !== 'object') return;
    lastHostBeat = Date.now();
    switch (d.t) {
      case 'sig':
        MediaLink.handle(conn, d, { config: iceConfig(), allowIncoming: true, onCall });
        break;
      case 'welcome': {
        const first = currentView() !== 'lobby' && currentView() !== 'watch';
        me.color = d.you.color;
        me.id = d.you.id;
        if (first) {
          $('join-btn').disabled = false;
          $('join-error').textContent = '';
          $('lobby-chat').innerHTML = '';
          history = [];
          (d.history || []).forEach(addChat);
          showView('lobby');
          $('lobby-code').textContent = `${code.slice(0, 4)}-••••-••••-••••`;
          api.showOverlay();
          setTimeout(syncOverlay, 400);
          if (me.color !== settings.color) system(`${colorName(settings.color)} was taken, so you're ${colorName(me.color)} in this room`);
          clearInterval(hbTimer);
          hbTimer = setInterval(guestBeat, 2000);
        } else {
          system('Reconnected');
        }
        setLobbyStatus('Connected', 'ok');
        syncOverlay();
        break;
      }
      case 'roster':
        roster = d.members || [];
        roomState = { locked: d.locked, sealed: !!d.sealed, streaming: d.streaming, stream: d.stream };
        // Sealed: we don't need the lobby server either
        if (roomState.sealed && conn?.open && peer && !peer.disconnected) peer.disconnect();
        renderLobby();
        api.toOverlay({ type: 'roster', members: roster });
        break;
      case 'chat': addChat(d.msg); break;
      case 'stream':
        if (!d.on) {
          Watch.detach();
          if (currentView() === 'watch') showView('lobby');
          roomState.streaming = false;
          renderLobby();
          if (d.reason) toastLobby(d.reason);
        }
        break;
      case 'kicked':
        endSession(d.blocked ? 'The host removed you and blocked this room for you.' : 'The host removed you from the room.');
        break;
      case 'denied':
        endSession({
          locked: 'The host has locked the room — nobody new can join right now.',
          full: 'The room is full.',
          blocked: "You can't join this room.",
        }[d.reason] || "The host didn't let you in.", true);
        break;
      case 'closing': endSession('The host closed the room.'); break;
      default: break;
    }
  }

  const colorName = (c) => c.charAt(0).toUpperCase() + c.slice(1);

  function onCall(call) {
    if (role !== 'guest') { call.close(); return; }
    const c = call.metadata?.cfg || {};
    call.answer(undefined, { sdpTransform: makeSdpTransform(c) });
    Watch.attach(call, c);
    if (watching) showView('watch');
  }

  function setWatching(on) {
    watching = on;
    if (conn?.open) conn.send({ t: 'watch', on });
    if (!on) { Watch.detach(); showView('lobby'); }
    renderLobby();
  }

  function renderLobby() {
    $('lobby-count').textContent = `${roster.length}`;
    $('lobby-roster').innerHTML = roster.map((p) => rosterRow(p)).join('');
    const hostName = roster.find((p) => p.host)?.name || 'the host';
    const live = !!roomState.streaming;
    $('waiting-title').textContent = live ? (watching ? 'OPENING THE STREAM…' : `${hostName.toUpperCase()} IS LIVE`)
                                          : `WAITING FOR ${hostName.toUpperCase()} TO SHARE`;
    $('waiting-sub').textContent = live
      ? (roomState.stream ? `${roomState.stream.w}×${roomState.stream.h} · ${roomState.stream.fps} fps` : '')
      : 'You can chat while you wait. The stream opens by itself.';
    $('rewatch').hidden = !(live && !watching);
    $('lobby-status').textContent = roomState.sealed ? 'Connected · 🔒 sealed (if you leave, ask the host to Unseal)'
      : roomState.locked ? 'Connected · 🔒 joins locked' : 'Connected';
  }

  function toastLobby(text) { $('waiting-sub').textContent = text; }

  function setLobbyStatus(text, kind) {
    const el = $('lobby-status');
    el.textContent = text;
    el.className = `status ${kind || ''}`;
  }

  function guestBeat() {
    if (conn?.open) conn.send({ t: 'hb' });
    if (conn?.open && Date.now() - lastHostBeat > 12000) {      // host silent: treat as lost
      const c = conn;
      conn = null;
      try { c.close(); } catch { /* gone */ }
      lost();
    }
  }

  // Host gone for a moment (Wi-Fi, crash, restart): keep trying for ~1 minute
  function lost() {
    if (leaving || role !== 'guest') return;
    if (conn) MediaLink.dropConnection(conn);
    Watch.detach();
    if (currentView() === 'watch') showView('lobby');
    setLobbyStatus(roomState.sealed ? 'Lost the host — the room is sealed: ask the host to press Unseal…' : 'Lost the host — reconnecting…', 'warn');
    scheduleRetry();
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    if (leaving) return;
    retries++;
    if (retries > 20) {
      endSession(roomState.sealed ? 'Lost connection. The room is sealed: ask the host to press Unseal, then join again with the same code.' : 'Lost connection to the host.');
      return;
    }
    retryTimer = setTimeout(() => {
      if (!peer || peer.destroyed || leaving) return;
      if (peer.disconnected) { peer.once('open', connect); peer.reconnect(); }   // back on the lobby server first
      else connect();
    }, 3000);
  }

  function fail(text) {
    $('join-btn').disabled = false;
    $('join-error').textContent = text;
    reset();
  }

  function endSession(text, beforeLobby) {
    leaving = true;
    const inLobby = !beforeLobby && (currentView() === 'lobby' || currentView() === 'watch');
    reset();
    showView('menu');
    $('join-btn').disabled = false;
    $('join-error').textContent = inLobby ? '' : text;
    if (inLobby) modal('Disconnected', text);
  }

  // ======================================================================

  function leave() {
    leaving = true;
    if (role === 'host') {
      broadcast({ t: 'closing' });
      if (streaming) stopStream('The host closed the room');
    }
    setTimeout(() => { reset(); showView('menu'); }, role === 'host' ? 250 : 0);
  }

  function reset() {
    clearInterval(hbTimer); clearInterval(statsTimer); clearInterval(sourceTimer);
    clearTimeout(retryTimer); clearTimeout(connectTimer);
    Watch.detach();
    if (streaming) { streaming = false; stream?.getTracks().forEach((t) => { t.onended = null; t.stop(); }); stream = null; AppAudio.stop(); }
    for (const m of members.values()) { hangUp(m); try { m.conn.close(); } catch { /* gone */ } }
    members.clear();
    try { conn?.close(); } catch { /* gone */ }
    conn = null;
    try { peer?.destroy(); } catch { /* gone */ }
    peer = null;
    if (role) api.hideOverlay();
    role = null; me = null; history = [];
    updateStreamButton();
  }

  // ---------- F8 quick menu (shown in the overlay, over the game) ----------
  function quickState() {
    const opts = (id) => [...$(id).options].map((o) => ({ v: o.value, l: o.textContent, d: o.disabled }));
    const p = plannedConfig();
    const ids = ['resolution', 'fps', 'content', 'codec', 'soundfrom', 'audio'];
    return {
      streaming,
      values: { ...Object.fromEntries(ids.map((k) => [k, $(`q-${k}`).value])), bitrate: settings.host.bitrate },
      options: Object.fromEntries(ids.map((k) => [k, opts(`q-${k}`)])),
      autoMbps: p.mbps,
      sending: streaming ? `${cfg.w}×${cfg.h} · ${cfg.fps} fps · ${cfg.mbps} Mbps` : 'not streaming',
      watchers: [...members.values()].filter((m) => m.watching).length,
      warn: hostWarn,
      source: sources.find((x) => x.id === settings.host.sourceId)?.name || '',
    };
  }
  function pushQuick() { if (role === 'host') api.toOverlay({ type: 'quick-state', state: quickState() }); }
  function quickSet(key, value) {
    if (role !== 'host') return;
    if (key === 'stream') $('stream-toggle').click();
    else {
      const el = $(`q-${key}`);
      if (!el) return;
      el.value = value;
      if (key === 'bitrate') el.dispatchEvent(new Event('input'));
      el.dispatchEvent(new Event('change'));
    }
    setTimeout(pushQuick, 300);
    setTimeout(pushQuick, 1500);
  }
  api.onOverlayMessage((m) => { if (m.type === 'quick-set') quickSet(m.key, m.value); });
  setInterval(() => { if (role === 'host') pushQuick(); }, 2000);

  $('lobby-leave').onclick = () => leave();
  $('rewatch').onclick = () => setWatching(true);
  window.addEventListener('beforeunload', () => { if (role === 'host') broadcast({ t: 'closing' }); });

  return {
    host, join, leave, sendChat, setWatching, quickState, pushQuick,
    get role() { return role; }, get me() { return me; },
    _debug: () => ({ role, code, members: [...members.keys()], streaming, locked, sealed, roster, roomState, peerOff: !!peer?.disconnected, cfg }),
  };
})();
