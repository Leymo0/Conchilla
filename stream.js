// Streaming helpers shared by host and viewers: quality presets, codec choice,
// connection hints, live stats and the delay-buffer "on time" meter.

const ROOM_PREFIX = 'conchilla-room-';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O or 1/I mix-ups

// 16 characters (80 bits): far too many combinations to ever guess, so nobody can stumble into a
// room (and see the host's IP) without being given the code. Shown as XXXX-XXXX-XXXX-XXXX.
const CODE_LENGTH = 16;
// Phone link: a phone types into the room through its owner's PC (short code, expires in a few minutes)
const LINK_PREFIX = 'conchilla-link-';
const LINK_CODE_LENGTH = 8;
const formatCode = (c) => (c || '').match(/.{1,4}/g)?.join('-') || '';
const cleanCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function randomCode(length = CODE_LENGTH) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function iceConfig() {
  return {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ],
  };
}

// Resolution is by HEIGHT, so ultrawide (21:9, 32:9) keeps its full width: "1080" on a
// 2560×1080 monitor sends 2560×1080, never a squashed or letterboxed 16:9 picture.
const RESOLUTIONS = {
  native: { h: 0,    label: 'Native (full screen size)' },
  1440:   { h: 1440, label: '1440p' },
  1080:   { h: 1080, label: '1080p' },
  900:    { h: 900,  label: '900p' },
  720:    { h: 720,  label: '720p' },
};

const CODECS = {
  auto: { mime: 'H264', label: 'Auto (H.264 — graphics card)' },
  h264: { mime: 'H264', label: 'H.264 — fastest, graphics card' },
  av1:  { mime: 'AV1',  label: 'AV1 — sharpest per Mbps (newer GPUs)' },
  vp9:  { mime: 'VP9',  label: 'VP9 — sharp, heavier on the CPU' },
  vp8:  { mime: 'VP8',  label: 'VP8 — old default (Discord-like)' },
};

const CONTENT = {
  game:  { hint: 'motion', degrade: 'maintain-framerate',  bpp: 0.07, label: 'Game — smooth motion first' },
  movie: { hint: 'motion', degrade: 'balanced',            bpp: 0.05, label: 'Movie — balanced' },
  text:  { hint: 'detail', degrade: 'maintain-resolution', bpp: 0.04, label: 'Desktop / text — sharp first' },
};

// Picture size we'll actually send for a given capture size + setting
function targetSize(srcW, srcH, resolution) {
  const want = RESOLUTIONS[resolution]?.h || 0;
  if (!want || !srcH || srcH <= want) return { w: srcW, h: srcH, scale: 1 };
  const scale = srcH / want;
  return { w: Math.round(srcW / scale), h: want, scale };
}

// Automatic bitrate (Mbps) from the picture size, frame rate, content and codec
function autoMbps(w, h, fps, content, codec) {
  const c = CONTENT[content] || CONTENT.game;
  const efficiency = codec === 'av1' ? 0.65 : codec === 'vp9' ? 0.75 : codec === 'vp8' ? 1.15 : 1;
  const mbps = (w * h * 60 * c.bpp * Math.pow(fps / 60, 0.75) * efficiency) / 1e6;
  return Math.min(50, Math.max(2, Math.round(mbps * 2) / 2));
}

// Audio as music, not a phone call: full-quality stereo Opus (both sides apply this)
function hiFiAudioSdp(sdp, kbps = 256) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
  if (!m) return sdp;
  const pt = m[1];
  const wanted = { stereo: '1', 'sprop-stereo': '1', maxaveragebitrate: String(kbps * 1000), maxplaybackrate: '48000', useinbandfec: '1', usedtx: '0' };
  const fmtp = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  if (fmtp.test(sdp)) {
    return sdp.replace(fmtp, (_all, params) => {
      const map = {};
      params.split(';').forEach((kv) => { const [k, v] = kv.split('='); if (k) map[k.trim()] = (v || '').trim(); });
      Object.assign(map, wanted);
      return `a=fmtp:${pt} ` + Object.entries(map).map(([k, v]) => `${k}=${v}`).join(';');
    });
  }
  return sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ` + Object.entries(wanted).map(([k, v]) => `${k}=${v}`).join(';'));
}

// Move one video codec to the front of the list (each followed by its retransmission payload)
function preferCodec(sdp, mime) {
  const lines = sdp.split('\r\n');
  const mIndex = lines.findIndex((l) => l.startsWith('m=video '));
  if (mIndex < 0) return sdp;
  const parts = lines[mIndex].split(' ');
  const header = parts.slice(0, 3), pts = parts.slice(3);
  const rtpmap = {}, fmtp = {}, apt = {};
  for (const l of lines) {
    let m = l.match(/^a=rtpmap:(\d+) ([^/]+)\//);
    if (m) rtpmap[m[1]] = m[2].toUpperCase();
    m = l.match(/^a=fmtp:(\d+) (.*)$/);
    if (m) { fmtp[m[1]] = m[2]; const a = m[2].match(/apt=(\d+)/); if (a) apt[m[1]] = a[1]; }
  }
  let chosen = pts.filter((pt) => rtpmap[pt] === mime && (mime !== 'H264' || /packetization-mode=1/.test(fmtp[pt] || '')));
  if (!chosen.length) return sdp;
  if (mime === 'H264') chosen.sort((a, b) => (/profile-level-id=(4d|64)/.test(fmtp[b] || '') - /profile-level-id=(4d|64)/.test(fmtp[a] || '')));
  if (mime === 'VP9') chosen.sort((a, b) => (/profile-id=0/.test(fmtp[b] || '') - /profile-id=0/.test(fmtp[a] || '')));
  const first = [];
  for (const pt of chosen) {
    first.push(pt);
    for (const [rtx, of] of Object.entries(apt)) if (of === pt && pts.includes(rtx)) first.push(rtx);
  }
  lines[mIndex] = [...header, ...first, ...pts.filter((pt) => !first.includes(pt))].join(' ');
  return lines.join('\r\n');
}

// Start sharp instead of WebRTC's cautious 270p start, and never collapse to mush
function bitrateHints(sdp, maxKbps) {
  const lines = sdp.split('\r\n');
  const m = lines.findIndex((l) => l.startsWith('m=video '));
  if (m < 0) return sdp;
  const pts = lines[m].split(' ').slice(3);
  const start = Math.min(maxKbps, 6000), min = Math.min(1500, Math.round(maxKbps / 3));
  const hint = `x-google-start-bitrate=${start};x-google-min-bitrate=${min};x-google-max-bitrate=${maxKbps}`;
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].match(/^a=fmtp:(\d+) (.*)$/);
    if (f && pts.includes(f[1]) && !/apt=/.test(f[2]) && !/x-google-start-bitrate/.test(f[2])) lines[i] = `${lines[i]};${hint}`;
  }
  return lines.join('\r\n');
}

// The full handshake tweak. `cfg` travels with the call so the viewer applies the same one.
function makeSdpTransform(cfg) {
  return (sdp) => {
    let out = hiFiAudioSdp(sdp, cfg.audioKbps || 256);
    out = preferCodec(out, (CODECS[cfg.codec] || CODECS.auto).mime);
    if (cfg.codec !== 'vp8') out = bitrateHints(out, Math.round((cfg.mbps || 10) * 1000));
    return out;
  };
}

// Live numbers. kind: 'outbound' (host, per viewer) or 'inbound' (viewer)
async function readStats(pc, kind, prev) {
  if (!pc) return null;
  const report = await pc.getStats();
  const out = { t: performance.now() };
  let codecId = null;
  report.forEach((s) => {
    if (s.type === `${kind}-rtp` && s.kind === 'video') {
      out.w = s.frameWidth; out.h = s.frameHeight; out.fps = s.framesPerSecond;
      out.bytes = kind === 'outbound' ? s.bytesSent : s.bytesReceived;
      out.limit = s.qualityLimitationReason;
      out.lost = s.packetsLost; out.received = s.packetsReceived;
      out.freezes = s.freezeCount; out.dropped = s.framesDropped;
      out.encoder = s.encoderImplementation;
      if (s.jitterBufferEmittedCount) out.bufferMs = Math.round((s.jitterBufferDelay / s.jitterBufferEmittedCount) * 1000);
      out.jbd = s.jitterBufferDelay; out.jbe = s.jitterBufferEmittedCount;
      codecId = s.codecId;
    }
    if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded' && s.currentRoundTripTime != null) {
      out.rtt = Math.round(s.currentRoundTripTime * 1000);
    }
  });
  if (codecId && report.get(codecId)) out.codec = report.get(codecId).mimeType.replace('video/', '');
  if (prev && prev.bytes != null && out.bytes != null) out.mbps = ((out.bytes - prev.bytes) * 8) / ((out.t - prev.t) * 1000);
  // Recent (not lifetime) buffer delay
  if (prev && prev.jbe != null && out.jbe > prev.jbe) out.bufferMs = Math.round(((out.jbd - prev.jbd) / (out.jbe - prev.jbe)) * 1000);
  if (prev && prev.lost != null && out.received > prev.received) {
    const lost = out.lost - prev.lost, got = out.received - prev.received;
    out.lossPct = (100 * lost) / Math.max(1, lost + got);
  }
  return out;
}

// Viewer-side playback meter. For every frame that reaches the screen we know when the host
// captured it (rtpTimestamp) and when it arrived here (receiveTime). From that:
//  - network hiccups: frames arriving well after the usual delay → the delay buffer fixes these
//  - host stutters:   gaps in the capture times themselves → the host's PC/game skipped frames,
//                     which no buffer can fix
class PlaybackMeter {
  constructor(video) {
    this.video = video;
    this.samples = [];       // [arrivalMs, transitMs, captureMs]
    this.running = false;
  }

  start() {
    if (this.running || !this.video.requestVideoFrameCallback) return;
    this.running = true;
    const tick = (_now, meta) => {
      if (!this.running) return;
      if (meta.receiveTime && meta.rtpTimestamp != null) {
        const captured = meta.rtpTimestamp / 90;
        const transit = meta.receiveTime - captured;   // + an unknown clock offset that cancels out
        const last = this.samples[this.samples.length - 1];
        if (last && Math.abs(transit - last[1]) > 5000) this.samples = [];   // new stream / wrap-around
        this.samples.push([meta.receiveTime, transit, captured]);
        const cutoff = meta.receiveTime - 30000;
        while (this.samples.length && this.samples[0][0] < cutoff) this.samples.shift();
      }
      this.video.requestVideoFrameCallback(tick);
    };
    this.video.requestVideoFrameCallback(tick);
  }

  stop() { this.running = false; this.samples = []; }

  // Last ~30 s: hiccups per minute without / with `bufferMs`, host stutters per minute,
  // and the buffer that would remove nearly all network hiccups.
  analyze(bufferMs = 0) {
    const s = this.samples;
    if (s.length < 90) return null;
    const secs = (s[s.length - 1][0] - s[0][0]) / 1000;
    if (secs < 8) return null;
    const perMin = (n) => (n * 60) / secs;

    const transits = s.map((x) => x[1]).sort((a, b) => a - b);
    const typical = transits[Math.floor(transits.length / 2)];
    const late = s.map((x) => x[1] - typical);
    // a hiccup = a run of frames arriving > 50 ms later than the buffer can absorb
    const hiccups = (buf) => {
      let n = 0, prev = false;
      for (const l of late) { const bad = l > buf + 50; if (bad && !prev) n++; prev = bad; }
      return perMin(n);
    };
    const sortedLate = [...late].sort((a, b) => a - b);
    const p995 = sortedLate[Math.floor(sortedLate.length * 0.995)] || 0;
    const suggestion = Math.min(800, Math.max(0, Math.ceil((p995 - 30) / 10) * 10));

    // host side: gaps between capture times, ignoring "nothing changed on screen" pauses (> 1 s)
    // Only gaps between frames that both arrived on time count — when the network is late,
    // the viewer skips frames too, and that's not the host's fault.
    const deltas = [];
    for (let i = 1; i < s.length; i++) {
      const d = s[i][2] - s[i - 1][2];
      if (d > 0) deltas.push([d, late[i] <= bufferMs + 30 && late[i - 1] <= bufferMs + 30]);
    }
    const sortedD = deltas.map((x) => x[0]).sort((a, b) => a - b);
    const frameMs = sortedD[Math.floor(sortedD.length / 2)] || 0;
    let gaps = 0;
    if (frameMs && frameMs < 50) for (const [d, onTime] of deltas) if (onTime && d > Math.max(2.5 * frameMs, 50) && d < 1000) gaps++;

    return {
      secs,
      hiccupsOff: hiccups(0),
      hiccupsWith: hiccups(bufferMs),
      hostStutters: perMin(gaps),
      suggestion,
      fps: frameMs ? 1000 / frameMs : 0,
    };
  }
}

// Auto delay buffer: raise right away when the connection gets shaky, come back down slowly
// (only after ~20 s of calm, 50 ms at a time) so it doesn't flap.
class AutoBuffer {
  constructor() { this.lowSince = null; }
  step(analysis, current, now = performance.now()) {
    if (!analysis) return current;
    const target = analysis.suggestion;
    if (target > current) { this.lowSince = null; return target; }
    if (target < current - 30) {
      if (this.lowSince == null) this.lowSince = now;
      if (now - this.lowSince > 20000) { this.lowSince = now; return Math.max(target, current - 50); }
    } else this.lowSince = null;
    return current;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (typeof module !== 'undefined') {
  module.exports = { RESOLUTIONS, CODECS, CONTENT, targetSize, autoMbps, hiFiAudioSdp, preferCodec, bitrateHints, makeSdpTransform, PlaybackMeter, AutoBuffer };
}
