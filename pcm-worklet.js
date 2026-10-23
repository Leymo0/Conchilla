// Plays raw 16-bit stereo PCM (from the app-sound recorder) into a MediaStream.
// Keeps a small, steady buffer: catches up if it grows, waits a moment after running dry.
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 48000 * 2;                 // 2 s ring buffer
    this.left = new Float32Array(this.size);
    this.right = new Float32Array(this.size);
    this.read = 0; this.write = 0; this.count = 0;
    this.primed = false;
    this.port.onmessage = (e) => this.push(new Int16Array(e.data));
  }

  push(pcm) {
    const frames = pcm.length >> 1;
    for (let i = 0; i < frames; i++) {
      this.left[this.write] = pcm[2 * i] / 32768;
      this.right[this.write] = pcm[2 * i + 1] / 32768;
      this.write = (this.write + 1) % this.size;
    }
    this.count = Math.min(this.size, this.count + frames);
    if (this.count >= this.size) this.read = this.write;
    // more than 200 ms queued (clock drift / hiccup): jump to ~60 ms behind live
    if (this.count > 9600) {
      const drop = this.count - 2880;
      this.read = (this.read + drop) % this.size;
      this.count -= drop;
    }
  }

  process(_inputs, outputs) {
    const [l, r] = outputs[0];
    const n = l.length;
    if (!this.primed && this.count >= 1920) this.primed = true;   // 40 ms before (re)starting
    if (!this.primed || this.count < n) {
      this.primed = false;
      l.fill(0); if (r) r.fill(0);
      return true;
    }
    for (let i = 0; i < n; i++) {
      l[i] = this.left[this.read];
      if (r) r[i] = this.right[this.read];
      this.read = (this.read + 1) % this.size;
    }
    this.count -= n;
    return true;
  }
}
registerProcessor('pcm-player', PcmPlayer);
