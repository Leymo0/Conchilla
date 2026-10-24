// Watching the host's stream: crop / zoom, delay buffer (Auto or manual) with a diagnosis, stats (F7).

const Watch = (() => {
  const video = $('watch-video');
  const stage = $('stage');
  let call = null, cfg = {}, statsTimer = null, meterTimer = null, lastStats = null, closeTimer = null;
  let meter = new PlaybackMeter(video);
  let auto = new AutoBuffer(), liveBuffer = 0, analysis = null;
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
      routeAudio(s);
      video.play().catch(() => {});
      meter.stop(); meter = new PlaybackMeter(video); meter.start();
      auto = new AutoBuffer(); analysis = null;
      liveBuffer = v().autoBuffer !== false ? 0 : v().bufferMs;
      applyBuffer();
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
    meterTimer = setInterval(updateMeter, 3000);
    renderStats();
    showControls();
  }

  function detach() {
    clearTimeout(closeTimer);
    clearInterval(statsTimer); clearInterval(meterTimer);
    const c = call; call = null;
    try { c?.close(); } catch { /* closed */ }
    meter.stop();
    try { actx?.close(); } catch { /* closed */ }
    actx = null; gain = null;
    video.srcObject = null;
    if (fullscreen) setFullscreen(false);
    $('watch-stats').textContent = '';
  }

  // ---------------------------------------------------------------- volume (up to 200%)
  // A <video> stops at 100%, so the sound goes through Web Audio: gain → limiter → speakers.
  // (The video element stays attached but muted: Chrome only delivers remote audio that way.)
  let actx = null, gain = null;
  function routeAudio(s) {
    video.muted = true;
    try { actx?.close(); } catch { /* closed */ }
    actx = null; gain = null;
    if (!s.getAudioTracks().length) return;
    actx = new AudioContext({ latencyHint: 'interactive' });
    const src = actx.createMediaStreamSource(s);
    gain = actx.createGain();
    const limiter = actx.createDynamicsCompressor();   // keeps 200% from crackling on loud bits
    limiter.threshold.value = -2; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.003; limiter.release.value = 0.15;
    src.connect(gain).connect(limiter).connect(actx.destination);
    setVolume(v().volume);
    actx.resume().catch(() => {});
  }
  function setVolume(vol) {
    vol = Math.max(0, Math.min(2, vol));
    if (gain) gain.gain.setTargetAtTime(vol, actx.currentTime, 0.02);
    $('w-volume').value = vol;
    $('w-volume-val').textContent = `${Math.round(vol * 100)}%`;
    $('w-volume-val').classList.toggle('boost', vol > 1);
  }

  // ---------------------------------------------------------------- delay buffer
  // Auto (default): keeps adjusting to the connection. Manual: the slider.

  const isAuto = () => v().autoBuffer !== false;

  function applyBuffer() {
    const ms = isAuto() ? liveBuffer : v().bufferMs;
    for (const r of call?.peerConnection?.getReceivers() || []) {
      try { r.jitterBufferTarget = ms; } catch { /* older engine */ }
    }
    for (const id of ['w-buffer', 'lobby-buffer']) { $(id).value = ms; $(id).disabled = isAuto(); }
    const label = isAuto() ? `Auto · ${ms} ms` : `${ms} ms`;
    $('w-buffer-val').textContent = label; $('lobby-buffer-val').textContent = label;
    $('w-auto').classList.toggle('on', isAuto());
    $('w-auto').setAttribute('aria-pressed', String(isAuto()));
    $('lobby-auto').checked = isAuto();
  }

  async function setBuffer(ms, persist = true) {
    settings.viewer.bufferMs = ms;
    applyBuffer();
    if (persist) await save({ viewer: { bufferMs: ms } });
  }

  async function setAuto(on) {
    settings.viewer.autoBuffer = on;
    if (on) { auto = new AutoBuffer(); liveBuffer = analysis?.suggestion ?? v().bufferMs; }
    applyBuffer();
    renderMeter();
    await save({ viewer: { autoBuffer: on } });
  }

  // Every 3 s: what's causing hiccups (if anything), and let Auto adjust
  function updateMeter() {
    if (!call) return;
    const current = isAuto() ? liveBuffer : v().bufferMs;
    analysis = meter.analyze(current);
    if (isAuto() && analysis) {
      const next = auto.step(analysis, liveBuffer);
      if (next !== liveBuffer) { liveBuffer = next; applyBuffer(); }
    }
    renderMeter();
  }

  // One short line, only visible with the controls (they hide while you watch)
  function diagnosis() {
    const a = analysis;
    if (!a) return { cls: 'muted', text: 'checking…', tip: 'Needs a few seconds of video' };
    const buf = isAuto() ? liveBuffer : v().bufferMs;
    if (a.hostStutters >= 10) {
      return { cls: 'bad', text: "host's PC is stuttering",
        tip: `About ${Math.round(a.hostStutters)} stutters a minute are coming from the host's side (their PC or game skipped frames). ` +
             "A buffer can't fix that — the host can lower the frame rate or resolution, or cap the game's FPS a little below their monitor's refresh rate." };
    }
    if (a.hiccupsOff >= 3) {
      const left = Math.round(a.hiccupsWith);
      return left < 1
        ? { cls: 'good', text: `shaky connection · smoothed`, tip: `Your connection has about ${Math.round(a.hiccupsOff)} hiccups a minute; the ${buf} ms buffer hides them.` }
        : { cls: 'ok', text: `shaky connection · ${left}/min left`, tip: `About ${Math.round(a.hiccupsOff)} hiccups a minute without a buffer, ${left} with ${buf} ms.${isAuto() ? ' Auto is raising it.' : ' Turn on Auto or raise the buffer.'}` };
    }
    return { cls: 'good', text: 'smooth', tip: 'No hiccups from the connection or the host right now.' };
  }

  function renderMeter() {
    const d = diagnosis();
    const el = $('w-buffer-meter');
    el.innerHTML = `<b class="${d.cls}"></b>`;
    el.firstChild.textContent = d.text;
    el.title = d.tip;
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
    const a = analysis;
    if (a) {
      const buf = isAuto() ? liveBuffer : v().bufferMs;
      rows.push(`connection: ${Math.round(a.hiccupsOff)} hiccups/min → ${Math.round(a.hiccupsWith)} with ${buf} ms${isAuto() ? ' (Auto)' : ''}`);
      rows.push(`host's side: ${Math.round(a.hostStutters)} stutters/min${a.hostStutters >= 10 ? ' ⚠ their PC/game is skipping frames' : ''}`);
    }
    el.innerHTML = rows.map((r) => `<div>${r}</div>`).join('') + `<div class="muted">${escapeHtml(prettyKey(settings.hotkeys.stats))} hides this</div>`;
  }

  // ---------------------------------------------------------------- crop / zoom

  // zoom 0 = whole picture (black bars), 100 = bars gone (fills the window), 200 = 2× closer still.
  // If the shapes already match, 100 = 2× closer.
  function layout() {
    const W = stage.clientWidth, H = stage.clientHeight;
    const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
    const fit = Math.min(W / vw, H / vh), cover = Math.max(W / vw, H / vh);
    const full = cover / fit > 1.03 ? cover : fit * 2;
    // 0–100%: whole picture → fills the window; 100–200%: up to 2× closer than that
    const z = v().zoom;
    const scale = z <= 100 ? fit + (full - fit) * (z / 100) : full * (1 + (z - 100) / 100);
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
    settings.viewer.zoom = Math.max(0, Math.min(200, settings.viewer.zoom));
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
  // scroll wheel: zoom only (the position / Vertical slider stays where you put it)
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    setView({ zoom: v().zoom - Math.sign(e.deltaY) * 5 });
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
    $('w-center').onclick = () => setView({ panX: 50, panY: 50 });
    const onBuffer = (e) => setBuffer(Number(e.target.value), false);
    const saveBuffer = (e) => setBuffer(Number(e.target.value), true);
    for (const id of ['w-buffer', 'lobby-buffer']) { $(id).oninput = onBuffer; $(id).onchange = saveBuffer; }
    $('w-auto').onclick = () => setAuto(!isAuto());
    $('lobby-auto').onchange = (e) => setAuto(e.target.checked);
    setVolume(vs().volume);
    $('w-volume').oninput = (e) => { settings.viewer.volume = Number(e.target.value); setVolume(settings.viewer.volume); };
    $('w-volume').onchange = () => save({ viewer: { volume: settings.viewer.volume } });
    $('w-volume-val').ondblclick = () => { settings.viewer.volume = 1; setVolume(1); save({ viewer: { volume: 1 } }); };
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

  // test helper: current output level after the volume stage
  function level() {
    if (!gain) return null;
    if (!level.an || level.ctx !== actx) { level.an = actx.createAnalyser(); gain.connect(level.an); level.ctx = actx; }
    const buf = new Float32Array(level.an.fftSize); level.an.getFloatTimeDomainData(buf);
    let peak = 0; for (const x of buf) peak = Math.max(peak, Math.abs(x));
    return { state: actx.state, gain: gain.gain.value, peak: Number(peak.toFixed(3)) };
  }

  return { init, showControls, attach, detach, _level: level, get meter() { return meter; }, layout };
})();
