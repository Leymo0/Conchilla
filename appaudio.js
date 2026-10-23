// "Only this app" / "everything except Discord" sound for the host, via native/conchilla-audio.exe
const AppAudio = (() => {
  let ctx = null, node = null, dest = null;

  api.onAppAudioPcm((chunk) => {
    if (!node) return;
    const copy = chunk.slice();               // own, aligned buffer we can hand over
    node.port.postMessage(copy.buffer, [copy.buffer]);
  });

  // mode: 'include' (only the shared app) or 'exclude' (all but Discord)
  async function start(mode, sourceId) {
    stop();
    const res = await api.appAudioStart({ mode, sourceId });
    if (!res.ok) return res;
    try {
      ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      await ctx.audioWorklet.addModule('pcm-worklet.js');
      node = new AudioWorkletNode(ctx, 'pcm-player', { numberOfInputs: 0, outputChannelCount: [2] });
      dest = ctx.createMediaStreamDestination();
      dest.channelCount = 2;
      node.connect(dest);
      const track = dest.stream.getAudioTracks()[0];
      track.contentHint = 'music';
      return { ok: true, track, app: res.app };
    } catch (err) {
      stop();
      return { ok: false, reason: err.message };
    }
  }

  function stop() {
    api.appAudioStop();
    try { node?.disconnect(); } catch { /* gone */ }
    try { ctx?.close(); } catch { /* gone */ }
    node = null; ctx = null; dest = null;
  }

  return { start, stop };
})();
