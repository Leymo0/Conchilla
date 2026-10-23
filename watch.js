// Watching the host's stream: crop / zoom, delay buffer with an on-time meter, stats (F7).

const Watch = (() => {
  const video = $('watch-video');
  const stage = $('stage');
  let call = null, cfg = {}, statsTimer = null, meterTimer = null, lastStats = null, closeTimer = null;
  let meter = new OnTimeMeter(video);
  let fullscreen = false, hideTimer = null;
  const v = () => settings.viewer;

  // ---------------------------------------------------------------- stream

  function attach(newCall, newCfg) {
    const old = call;
    call = newCall;
    cfg = newCfg || {};
    clearTimeout(closeTimer);
    if (old && old !== newCall) { try { old.close(); } catch { /* closed */ } }
    toast(old ? 'Stream settings changed — reconnecting…' : 'Connecting to the stream…');
    newCall.on('stream', (s) => {
      if (call !== newCall) return;
      video.srcObject = s;
      video.volume = v().volume;
      video.play().catch(() => {});
      applyBuffer();
      meter.stop(); meter = new OnTimeMeter(video); meter.start();
      toast('');
    });
    newCall.on('close', () => {
      if (call !== newCall) return;
      // The host may just be switching codec / sound (a new call follows within a second)
      toast('Stream paused…');
      closeTimer = setTimeout(() => {
        if (call !== newCall) return;
        detach();
        if (currentView() === 'watch') showView('lobby');
      }, 5000);
    });
    newCall.on('error', () => {});
    // receivers exist as soon as the call is answered
    setTimeout(applyBuffer, 200);
    clearInterval(statsTimer); clearInterval(meterTimer);
    lastStats = null;
    statsTimer = setInterval(updateStats, 1000);
    meterTimer = setInterval(updateMeter, 1000);
    renderStats();
    showControls();
  }

  function detach() {
    clearTimeout(closeTimer);
    clearInterval(statsTimer); clearInterval(meterTimer);
    const c = call; call = null;
    try { c?.close(); } catch { /* closed */ }
    meter.stop();
    video.srcObject = null;
    if (fullscreen) setFullscreen(false);
    $('watch-stats').textContent = '';
  }

  // ---------------------------------------------------------------- delay buffer

  function applyBuffer() {
    const ms = v().bufferMs;
    for (const r of call?.peerConnection?.getReceivers() || []) {
      try { r.jitterBufferTarget = ms; } catch { /* older engine */ }
    }
    $('w-buffer').value = ms; $('lobby-buffer').value = ms;
    $('w-buffer-val').textContent = `${ms} ms`; $('lobby-buffer-val').textContent = `${ms} ms`;
    updateMeter();
  }

  async function setBuffer(ms, persist = true) {
    settings.viewer.bufferMs = ms;
    applyBuffer();
    if (persist) await save({ viewer: { bufferMs: ms } });
  }

  // "97% on time · +18% smoother": measured from the real frame arrival times on this connection
  function updateMeter() {
    const el = $('w-buffer-meter');
    const late = meter.lateness();
    if (!late) { el.innerHTML = '<span class="muted">measuring…</span>'; el.title = 'Needs a few seconds of video'; return; }
    const ms = v().bufferMs;
    const withB = meter.onTime(ms, late), without = meter.onTime(0, late);
    const gain = withB - without;
    const cls = withB >= 98.5 ? 'good' : withB >= 93 ? 'ok' : 'bad';
    el.innerHTML = `<b class="${cls}">${withB.toFixed(1)}%</b> on time` +
      (ms > 0 ? ` <span class="gain">${gain >= 0.1 ? `+${gain.toFixed(1)}% smoother` : 'no gain now'}</span>` : '');
    el.title = `Over the last ~20 s: with ${ms} ms of buffer ${withB.toFixed(1)}% of frames arrive in time to play smoothly; with no buffer ${without.toFixed(1)}%. ` +
      `Buffer adds ${ms} ms of delay. Suggested: ${meter.suggest(late)} ms.`;
  }

  // ---------------------------------------------------------------- stats (F7)

  async function updateStats() {
    const s = await readStats(call?.peerConnection, 'inbound', lastStats).catch(() => null);
    if (s) lastStats = s;
    renderStats();
  }

  function renderStats() {
    const el = $('watch-stats');
    el.hidden = !v().showStats;
    const s = lastStats;
    if (!s || !s.w) { el.textContent = 'connecting…'; return; }
    const delay = (s.rtt != null ? s.rtt / 2 : 0) + (s.bufferMs || 0);
    const rows = [
      `${s.w}×${s.h} · ${Math.round(s.fps || 0)} fps · ${s.codec || '?'}`,
      `${s.mbps != null ? s.mbps.toFixed(1) : '–'} Mbps · ping ${s.rtt ?? '–'} ms`,
      `delay ≈ ${Math.round(delay)} ms (buffer ${s.bufferMs ?? '–'} ms)`,
      `loss ${s.lossPct != null ? s.lossPct.toFixed(1) : '0.0'}% · freezes ${s.freezes ?? 0} · dropped ${s.dropped ?? 0}`,
    ];
    el.innerHTML = rows.map((r) => `<div>${r}</div>`).join('') + `<div class="muted">${escapeHtml(prettyKey(settings.hotkeys.stats))} hides this</div>`;
  }

  // ---------------------------------------------------------------- crop / zoom

  // zoom 0 = whole picture (black bars), 100 = bars gone (fills the window).
  // If the shapes already match, 100 = 2× closer.
  function layout() {
    const W = stage.clientWidth, H = stage.clientHeight;
    const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
    const fit = Math.min(W / vw, H / vh), cover = Math.max(W / vw, H / vh);
    const full = cover / fit > 1.03 ? cover : fit * 2;
    const scale = fit + (full - fit) * (v().zoom / 100);
    const dw = vw * scale, dh = vh * scale;
    const left = dw > W ? (W - dw) * (v().panX / 100) : (W - dw) / 2;
    const top = dh > H ? (H - dh) * (v().panY / 100) : (H - dh) / 2;
    Object.assign(video.style, { width: `${dw}px`, height: `${dh}px`, left: `${left}px`, top: `${top}px` });
    stage.classList.toggle('pannable', dw > W + 1 || dh > H + 1);
    $('w-zoom').value = v().zoom; $('w-zoom-val').textContent = `${Math.round(v().zoom)}%`;
    $('w-pany').value = v().panY; $('w-pany-val').textContent = `${Math.round(v().panY)}%`;
    return { W, H, dw, dh };
  }

  let saveTimer = null;
  function setView(patch) {
    Object.assign(settings.viewer, patch);
    settings.viewer.zoom = Math.max(0, Math.min(100, settings.viewer.zoom));
    settings.viewer.panX = Math.max(0, Math.min(100, settings.viewer.panX));
    settings.viewer.panY = Math.max(0, Math.min(100, settings.viewer.panY));
    layout();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save({ viewer: { zoom: v().zoom, panX: v().panX, panY: v().panY } }), 400);
  }

  // drag to move the picture
  let drag = null;
  stage.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const { W, H, dw, dh } = layout();
    drag = { x: e.clientX, y: e.clientY, panX: v().panX, panY: v().panY, ox: dw - W, oy: dh - H };
    stage.classList.add('dragging');
  });
  window.addEventListener('mousemove', (e) => {
    showControls();
    if (!drag) return;
    const patch = {};
    if (drag.ox > 0) patch.panX = drag.panX - ((e.clientX - drag.x) / drag.ox) * 100;
    if (drag.oy > 0) patch.panY = drag.panY - ((e.clientY - drag.y) / drag.oy) * 100;
    setView(patch);
  });
  window.addEventListener('mouseup', () => { drag = null; stage.classList.remove('dragging'); });
  // scroll wheel to zoom, keeping the spot under the cursor roughly in place
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    const zoom = v().zoom - Math.sign(e.deltaY) * 5;
    setView({ zoom, panX: v().panX + (fx - 0.5) * 8 * Math.sign(-e.deltaY), panY: v().panY + (fy - 0.5) * 8 * Math.sign(-e.deltaY) });
  }, { passive: false });
  stage.addEventListener('dblclick', () => setFullscreen(!fullscreen));

  video.addEventListener('loadedmetadata', layout);
  video.addEventListener('resize', layout);
  window.addEventListener('resize', layout);

  // ---------------------------------------------------------------- controls

  function setFullscreen(on) {
    fullscreen = on;
    api.fullscreen(on);
    setTimeout(layout, 250);
  }

  function showControls() {
    if (currentView() !== 'watch') return;
    document.body.classList.remove('idle');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!$('watch-controls').matches(':hover') && !drag) document.body.classList.add('idle');
    }, 2500);
  }

  function toast(text) {
    const el = $('watch-toast');
    el.textContent = text;
    el.classList.toggle('show', !!text);
  }

  function init() {
    const vs = () => settings.viewer;
    $('w-zoom').oninput = (e) => setView({ zoom: Number(e.target.value) });
    $('w-pany').oninput = (e) => setView({ panY: Number(e.target.value) });
    $('w-fill').onclick = () => setView({ zoom: 100, panX: 50, panY: 50 });
    $('w-reset').onclick = () => setView({ zoom: 0, panX: 50, panY: 50 });
    const onBuffer = (e) => setBuffer(Number(e.target.value), false);
    const saveBuffer = (e) => setBuffer(Number(e.target.value), true);
    for (const id of ['w-buffer', 'lobby-buffer']) { $(id).oninput = onBuffer; $(id).onchange = saveBuffer; }
    $('w-suggest').onclick = () => {
      const s = meter.suggest();
      if (s == null) toast('Still measuring — give it a few seconds');
      else { setBuffer(s); toast(`Buffer set to ${s} ms`); setTimeout(() => toast(''), 1800); }
    };
    $('w-volume').value = vs().volume;
    $('w-volume').oninput = (e) => { video.volume = Number(e.target.value); settings.viewer.volume = video.volume; };
    $('w-volume').onchange = () => save({ viewer: { volume: video.volume } });
    $('w-full').onclick = () => setFullscreen(!fullscreen);
    $('w-chat').onclick = () => api.openChat();
    $('watch-back').onclick = () => Room.setWatching(false);
    applyBuffer();

    window.addEventListener('keydown', (e) => {
      if (currentView() !== 'watch' || e.target.closest?.('input, select, textarea')) return;
      if (matchesKey(e, settings.hotkeys.stats)) {
        e.preventDefault();
        save({ viewer: { showStats: !v().showStats } }).then(renderStats);
      } else if (matchesKey(e, settings.hotkeys.fullscreen)) {
        e.preventDefault(); setFullscreen(!fullscreen);
      } else if (e.key === 'Escape' && fullscreen) {
        setFullscreen(false);
      } else if (e.key === 'Enter') {
        e.preventDefault(); api.openChat();
      }
    });
  }

  return { init, attach, detach, get meter() { return meter; }, layout };
})();
