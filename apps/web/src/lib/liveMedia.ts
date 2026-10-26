import type { LiveMediaRoute, LiveMediaSignal, LiveMediaSnapshot } from '@quiz/shared';
type Entry = { pc: RTCPeerConnection; route: LiveMediaRoute; candidates: RTCIceCandidateInit[]; queue: Promise<void>; closed: boolean };
/** One unidirectional connection per authorized route. Camera and team voice never share a connection. */
export class LiveMediaTransport {
  private peers = new Map<string, Entry>();
  private tracks: Partial<Record<'audio' | 'video', MediaStream>> = {};
  
  constructor(private send: (signal: LiveMediaSignal) => void, private remote: (id: string, stream: MediaStream | null, route: LiveMediaRoute) => void, private failure: (message: string) => void) {}
  setStream(kind: 'audio' | 'video', stream?: MediaStream) { this.tracks[kind] = stream; for (const entry of this.peers.values()) if (entry.route.kind === kind) for (const sender of entry.pc.getSenders()) if (sender.track?.kind === kind) void sender.replaceTrack(stream?.getTracks()[0] ?? null).catch(() => this.failure('Gerätewechsel fehlgeschlagen. Bitte Medien neu verbinden.')); }
  private closeRoute(id: string) { const entry = this.peers.get(id); if (!entry) return; entry.closed = true; entry.pc.close(); this.peers.delete(id); this.remote(id, null, entry.route); }
  update(snapshot: LiveMediaSnapshot) {
    const ids = new Set(snapshot.routes.map(route => route.id));
    for (const id of this.peers.keys()) if (!ids.has(id)) this.closeRoute(id);
    for (const route of snapshot.routes) {
      if (this.peers.has(route.id) || typeof RTCPeerConnection === 'undefined') continue;
      const outgoing = route.from === snapshot.selfId, stream = this.tracks[route.kind];
      if (outgoing && !stream?.getTracks().some(track => track.readyState === 'live')) continue;
      const pc = new RTCPeerConnection({ iceServers: snapshot.iceServers });
      const entry: Entry = { pc, route, candidates: [], queue: Promise.resolve(), closed: false }; this.peers.set(route.id, entry);
      pc.onicecandidate = event => { if (!entry.closed && event.candidate) this.send({ routeId: route.id, candidate: { ...event.candidate.toJSON(), candidate: event.candidate.candidate } }); };
      pc.ontrack = event => { if (!entry.closed) this.remote(route.id, event.streams[0] ?? new MediaStream([event.track]), route); };
      pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') this.failure('Medienverbindung fehlgeschlagen. Bitte Medien neu verbinden.'); };
      if (outgoing && stream) {
        pc.addTransceiver(stream.getTracks()[0], { direction: 'sendonly', streams: [stream] });
        this.enqueue(entry, async () => { await pc.setLocalDescription(await pc.createOffer()); if (!entry.closed && pc.localDescription) this.send({ routeId: route.id, description: { type: 'offer', sdp: pc.localDescription.sdp } }); });
      }
    }
  }
  private enqueue(entry: Entry, run: () => Promise<void>) { entry.queue = entry.queue.then(async () => { if (!entry.closed) await run(); }).catch(() => { if (!entry.closed) this.failure('Medienverbindung unterbrochen. Bitte Medien neu verbinden.'); }); }
  signal(signal: LiveMediaSignal) {
    const entry = this.peers.get(signal.routeId); if (!entry) return;
    this.enqueue(entry, async () => {
      const pc = entry.pc;
      if (signal.description) {
        await pc.setRemoteDescription(signal.description);
        if (signal.description.type === 'offer') {
          for (const transceiver of pc.getTransceivers()) transceiver.direction = 'recvonly';
          await pc.setLocalDescription(await pc.createAnswer());
          if (!entry.closed && pc.localDescription) this.send({ routeId: signal.routeId, description: { type: 'answer', sdp: pc.localDescription.sdp } });
        }
        for (const candidate of entry.candidates.splice(0)) await pc.addIceCandidate(candidate);
      } else if (signal.candidate) { if (pc.remoteDescription) await pc.addIceCandidate(signal.candidate); else if (entry.candidates.length < 64) entry.candidates.push(signal.candidate); }
    });
  }
  async quality(mode: 'AUTO' | 'DATA_SAVER' | 'HIGH_QUALITY', hidden: boolean) {
    for (const entry of this.peers.values()) for (const sender of entry.pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      try { const parameters = sender.getParameters(); if (!parameters.encodings?.length) continue;
        for (const encoding of parameters.encodings) { encoding.active = !hidden; encoding.maxBitrate = mode === 'DATA_SAVER' ? 120000 : mode === 'HIGH_QUALITY' ? 1500000 : 500000; encoding.scaleResolutionDownBy = mode === 'DATA_SAVER' ? 3 : 1; }
        await sender.setParameters(parameters);
      } catch { /* Unsupported bitrate controls do not prevent voice. */ }
    }
  }
  close() { for (const id of [...this.peers.keys()]) this.closeRoute(id); }
}
