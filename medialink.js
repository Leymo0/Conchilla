// Direct-link media: the WebRTC handshake for the video/audio (offer, answer, network
// candidates) travels over the data connection people already have with each other, instead
// of through the lobby server. So once someone is connected, the lobby server isn't needed
// anymore — which is what lets a room be sealed.
//
// A link looks like a PeerJS media call: .on('stream' | 'close' | 'error'), .peerConnection,
// .metadata, .close(), and on the receiving side .answer({ sdpTransform }).

const MediaLink = (() => {
  const links = new Map();   // id → link

  class Link {
    constructor(conn, id, config) {
      this.conn = conn;
      this.id = id;
      this.open = true;
      this.metadata = null;
      this.handlers = {};
      this.pendingIce = [];
      this.remoteSet = false;
      this.peerConnection = new RTCPeerConnection(config);
      this.peerConnection.onicecandidate = (e) => { if (e.candidate) this.send({ kind: 'ice', cand: e.candidate.toJSON() }); };
      this.peerConnection.onconnectionstatechange = () => {
        if (['failed', 'closed'].includes(this.peerConnection.connectionState)) this.close(false);
      };
      links.set(id, this);
    }

    on(event, fn) { (this.handlers[event] ||= []).push(fn); return this; }
    emit(event, ...args) {
      for (const fn of this.handlers[event] || []) { try { fn(...args); } catch (err) { console.error(err); } }
    }
    send(msg) {
      if (!this.conn?.open) return;
      try { this.conn.send({ t: 'sig', id: this.id, ...msg }); } catch { /* closing */ }
    }

    async addRemote(desc) {
      await this.peerConnection.setRemoteDescription(desc);
      this.remoteSet = true;
      for (const c of this.pendingIce.splice(0)) await this.peerConnection.addIceCandidate(c).catch(() => {});
    }

    // receiving side
    async answer({ sdpTransform } = {}) {
      try {
        await this.addRemote({ type: 'offer', sdp: this.offerSdp });
        const answer = await this.peerConnection.createAnswer();
        if (sdpTransform) answer.sdp = sdpTransform(answer.sdp);
        await this.peerConnection.setLocalDescription(answer);
        this.send({ kind: 'answer', sdp: answer.sdp });
        // every incoming track is known now: hand them over as one stream
        const tracks = this.peerConnection.getReceivers().map((r) => r.track).filter(Boolean);
        this.emit('stream', new MediaStream(tracks));
      } catch (err) {
        this.emit('error', err);
        this.close();
      }
    }

    close(notify = true) {
      if (!this.open) return;
      this.open = false;
      links.delete(this.id);
      if (notify) this.send({ kind: 'bye' });
      try { this.peerConnection.close(); } catch { /* closed */ }
      this.emit('close');
    }
  }

  const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

  // Sending side: start a call to whoever is on the other end of `conn`
  function call(conn, stream, { metadata, sdpTransform, config } = {}) {
    const link = new Link(conn, newId(), config);
    for (const track of stream.getTracks()) link.peerConnection.addTrack(track, stream);
    (async () => {
      try {
        const offer = await link.peerConnection.createOffer();
        if (sdpTransform) offer.sdp = sdpTransform(offer.sdp);
        await link.peerConnection.setLocalDescription(offer);
        link.send({ kind: 'offer', sdp: offer.sdp, metadata });
      } catch (err) {
        link.emit('error', err);
        link.close();
      }
    })();
    return link;
  }

  // Feed every { t: 'sig' } message from a data connection in here.
  // onCall(link) is called for a new incoming call (only if allowIncoming).
  async function handle(conn, msg, { config, onCall, allowIncoming = false } = {}) {
    if (!msg || typeof msg.id !== 'string' || msg.id.length > 64) return;
    let link = links.get(msg.id);
    if (link && link.conn !== conn) return;                  // not yours
    switch (msg.kind) {
      case 'offer':
        if (link || !allowIncoming || typeof msg.sdp !== 'string') return;
        link = new Link(conn, msg.id, config);
        link.offerSdp = msg.sdp;
        link.metadata = msg.metadata && typeof msg.metadata === 'object' ? msg.metadata : {};
        onCall?.(link);
        break;
      case 'answer':
        if (link && !link.remoteSet && typeof msg.sdp === 'string') await link.addRemote({ type: 'answer', sdp: msg.sdp }).catch((err) => link.emit('error', err));
        break;
      case 'ice':
        if (!link || !msg.cand) return;
        if (link.remoteSet) await link.peerConnection.addIceCandidate(msg.cand).catch(() => {});
        else link.pendingIce.push(msg.cand);
        break;
      case 'bye':
        link?.close(false);
        break;
      default: break;
    }
  }

  // The data connection went away: end its media too
  function dropConnection(conn) {
    for (const link of [...links.values()]) if (link.conn === conn) link.close(false);
  }

  return { call, handle, dropConnection };
})();

if (typeof module !== 'undefined') module.exports = { MediaLink };
