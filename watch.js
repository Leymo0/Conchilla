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
      routeAudio(s);
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
    if (crop.t || crop.b || crop.l || crop.r) rows.push(`cutting black bars: ${[['top', crop.t], ['bottom', crop.b], ['left', crop.l], ['right', crop.r]].filter(([, x]) => x).map(([n, x]) => `${n} ${Math.round(x * 100)}%`).join(', ')}`);
    el.innerHTML = rows.map((r) => `<div>${r}</div>`).join('') + `<div class="muted">${escapeHtml(prettyKey(settings.hotkeys.stats))} hides this</div>`;
  }

  // ---------------------------------------------------------------- crop / zoom

  // ---------------------------------------------------------------- black bars inside the picture
  // Some pictures arrive with bars baked in (a 2.39:1 movie, a game running 16:9 on an ultrawide,
  // a letterboxed capture). We spot the black edges and treat them as cropped, so Fit/Fill/Zoom
  // work on the real picture.
  let crop = { t: 0, b: 0, l: 0, r: 0 };
  let candidate = null, candidateHits = 0;
  const probe = document.createElement('canvas');

  function detectBars() {
    if (!video.videoWidth || video.readyState < 2) return;
    if (v().autoCrop === false) { if (crop.t || crop.b || crop.l || crop.r) { crop = { t: 0, b: 0, l: 0, r: 0 }; layout(); } return; }
    const w = 192, h = Math.max(8, Math.round((192 * video.videoHeight) / video.videoWidth));
    probe.width = w; probe.height = h;
    const g = probe.getContext('2d', { willReadFrequently: true });
    g.drawImage(video, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    const lum = (x, y) => { const i = (y * w + x) * 4; return d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; };
    const dark = (vals) => { let max = 0, sum = 0; for (const l of vals) { sum += l; if (l > max) max = l; } return max < 40 && sum / vals.length < 14; };
    const row = (y) => dark(Array.from({ length: w }, (_, x) => lum(x, y)));
    let t = 0; while (t < h * 0.4 && row(t)) t++;
    let b = 0; while (b < h * 0.4 && row(h - 1 - b)) b++;
    if (t + b >= h * 0.75) return;                       // fade to black / loading screen: keep what we had
    const col = (x) => dark(Array.from({ length: h - t - b }, (_, k) => lum(x, t + k)));
    let l = 0; while (l < w * 0.4 && col(l)) l++;
    let r = 0; while (r < w * 0.4 && col(w - 1 - r)) r++;
    const snap = (px, total) => (px / total < 0.015 ? 0 : px / total);   // ignore hairlines
    const next = { t: snap(t, h), b: snap(b, h), l: snap(l, w), r: snap(r, w) };
    const same = (a, c) => !!a && !!c && ['t', 'b', 'l', 'r'].every((k) => Math.abs(a[k] - c[k]) < 0.015);
    if (same(next, crop)) { candidate = null; return; }
    // Bars getting SMALLER (picture appeared there): follow right away, never hide picture.
    // Bars getting BIGGER: only after it's stayed that way for ~4 s (dark scenes aren't bars).
    const shrinking = ['t', 'b', 'l', 'r'].every((k) => next[k] <= crop[k] + 0.005);
    if (same(next, candidate)) candidateHits++; else { candidate = next; candidateHits = 1; }
    if (shrinking || candidateHits >= 3) { crop = next; candidate = null; layout(); }
  }
  setInterval(detectBars, 1500);

  // zoom 0 = whole picture (black bars), 100 = bars gone (fills the window).
  // If the shapes already match, 100 = 2× closer.
  function layout() {
    const W = stage.clientWidth, H = stage.clientHeight;
    const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
    const c = v().autoCrop === false ? { t: 0, b: 0, l: 0, r: 0 } : crop;
    const cw = vw * (1 - c.l - c.r), ch = vh * (1 - c.t - c.b);      // the real picture
    const fit = Math.min(W / cw, H / ch), cover = Math.max(W / cw, H / ch);
    const full = cover / fit > 1.03 ? cover : fit * 2;
    const scale = fit + (full - fit) * (v().zoom / 100);
    const dw = cw * scale, dh = ch * scale;
    const left = dw > W ? (W - dw) * (v().panX / 100) : (W - dw) / 2;
    const top = dh > H ? (H - dh) * (v().panY / 100) : (H - dh) / 2;
    Object.assign(video.style, {
      width: `${vw * scale}px`, height: `${vh * scale}px`,
      left: `${left - vw * c.l * scale}px`, top: `${top - vh * c.t * scale}px`,
      clipPath: `inset(${c.t * 100}% ${c.r * 100}% ${c.b * 100}% ${c.l * 100}%)`,
    });
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
    $('w-autocrop').checked = vs().autoCrop !== false;
    $('w-autocrop').onchange = (e) => { settings.viewer.autoCrop = e.target.checked; save({ viewer: { autoCrop: e.target.checked } }); detectBars(); layout(); };
    const onBuffer = (e) => setBuffer(Number(e.target.value), false);
    const saveBuffer = (e) => setBuffer(Number(e.target.value), true);
    for (const id of ['w-buffer', 'lobby-buffer']) { $(id).oninput = onBuffer; $(id).onchange = saveBuffer; }
    $('w-suggest').onclick = () => {
      const s = meter.suggest();
      if (s == null) toast('Still measuring — give it a few seconds');
      else { setBuffer(s); toast(`Buffer set to ${s} ms`); setTimeout(() => toast(''), 1800); }
    };
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
