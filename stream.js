// Streaming helpers shared by host and viewers: quality presets, codec choice,
// connection hints, live stats and the delay-buffer "on time" meter.

const ROOM_PREFIX = 'conchilla-room-';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O or 1/I mix-ups

function randomCode(length = 6) {
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

// Viewer-side meter: how many frames would play on time with a given buffer.
// Uses each frame's real network arrival time (requestVideoFrameCallback), so it measures
// the actual hiccups on this connection over the last ~20 s.
class OnTimeMeter {
  constructor(video) {
    this.video = video;
    this.samples = [];       // [arrivalMs, lateMs]
    this.running = false;
  }

  start() {
    if (this.running || !this.video.requestVideoFrameCallback) return;
    this.running = true;
    const tick = (_now, meta) => {
      if (!this.running) return;
      if (meta.receiveTime && meta.rtpTimestamp != null) {
        // transit = arrival - send time (+ unknown clock offset, which cancels out below)
        const transit = meta.receiveTime - meta.rtpTimestamp / 90;
        // timestamp wrap-around or a new stream: start over
        const last = this.samples[this.samples.length - 1];
        if (last && Math.abs(transit - last[1]) > 5000) this.samples = [];
        this.samples.push([meta.receiveTime, transit]);
        const cutoff = meta.receiveTime - 20000;
        while (this.samples.length && this.samples[0][0] < cutoff) this.samples.shift();
      }
      this.video.requestVideoFrameCallback(tick);
    };
    this.video.requestVideoFrameCallback(tick);
  }

  stop() { this.running = false; this.samples = []; }

  // How much later than usual each frame arrived. The connection's normal, steady delay
  // is already handled by WebRTC on its own; the buffer is for the spikes above it.
  lateness() {
    if (this.samples.length < 60) return null;
    const transits = this.samples.map(([, t]) => t).sort((a, b) => a - b);
    const typical = transits[Math.floor(transits.length / 2)];
    return this.samples.map(([, t]) => Math.max(0, t - typical));
  }

  // % of frames that arrive within `bufferMs` (+ one frame of slack)
  onTime(bufferMs, late = this.lateness()) {
    if (!late) return null;
    const limit = bufferMs + 17;
    let ok = 0;
    for (const l of late) if (l <= limit) ok++;
    return (100 * ok) / late.length;
  }

  // Smallest buffer that would make ~99% of frames on time
  suggest(late = this.lateness()) {
    if (!late) return null;
    const sorted = [...late].sort((a, b) => a - b);
    const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;
    return Math.min(1000, Math.max(0, Math.ceil((p99 - 17) / 10) * 10));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (typeof module !== 'undefined') {
  module.exports = { RESOLUTIONS, CODECS, CONTENT, targetSize, autoMbps, hiFiAudioSdp, preferCodec, bitrateHints, makeSdpTransform, OnTimeMeter };
}
