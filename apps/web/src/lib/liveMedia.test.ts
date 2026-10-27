import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LiveMediaSnapshot } from '@quiz/shared';
import { LiveMediaTransport } from './liveMedia';
const peers: FakePeer[] = [];
class FakePeer {
  onicecandidate: ((e: unknown) => void) | null = null; ontrack: ((e: unknown) => void) | null = null; onconnectionstatechange = null;
  localDescription: RTCSessionDescriptionInit | null = null; remoteDescription: RTCSessionDescriptionInit | null = null;
  close = vi.fn(); addIceCandidate = vi.fn(); replaceTrack = vi.fn().mockResolvedValue(undefined); sender: { track: MediaStreamTrack | null; replaceTrack: (track: MediaStreamTrack | null) => Promise<void> } | null = null;
  constructor() { peers.push(this); }
  addTransceiver(track: MediaStreamTrack) { this.sender = { track, replaceTrack: this.replaceTrack }; }
  getSenders() { return this.sender ? [this.sender] : []; }
  getTransceivers() { return [{ direction: 'recvonly' }]; }
  async createOffer() { return { type: 'offer', sdp: 'offer' }; }
  async createAnswer() { return { type: 'answer', sdp: 'answer' }; }
  async setLocalDescription(value: RTCSessionDescriptionInit) { this.localDescription = value; }
  async setRemoteDescription(value: RTCSessionDescriptionInit) { this.remoteDescription = value; }
}
const route = { id: 'route-1', from: 'source', to: 'receiver', kind: 'audio' as const, name: 'Alice' };
const snapshot = (selfId: string, routes = [route]) => ({ selfId, routes, iceServers: [] } as unknown as LiveMediaSnapshot);
const stream = (id: string) => ({ getTracks: () => [{ id, kind: 'audio', readyState: 'live' }] } as unknown as MediaStream);
beforeEach(() => { peers.length = 0; vi.stubGlobal('RTCPeerConnection', FakePeer); });
afterEach(() => { vi.unstubAllGlobals(); });
it('creates only the authorized route, replaces a live device and closes revoked connections without recursion', async () => {
  const send = vi.fn(), remote = vi.fn(), transport = new LiveMediaTransport(send, remote, vi.fn());
  transport.setStream('audio', stream('first')); transport.update(snapshot('source')); await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send.mock.calls[0][0]).toMatchObject({ routeId: route.id, description: { type: 'offer' } });
  transport.setStream('audio', stream('second')); expect(peers[0].replaceTrack).toHaveBeenCalledWith(expect.objectContaining({ id: 'second' }));
  transport.update(snapshot('source', [])); expect(peers[0].close).toHaveBeenCalledOnce(); expect(remote).toHaveBeenLastCalledWith(route.id, null, route);
  transport.close(); expect(peers[0].close).toHaveBeenCalledOnce();
});
it('queues ICE until remote description and produces a receive-only answer without local capture', async () => {
  const send = vi.fn(), transport = new LiveMediaTransport(send, vi.fn(), vi.fn()); transport.update(snapshot('receiver'));
  transport.signal({ routeId: route.id, candidate: { candidate: 'ice' } });
  await Promise.resolve(); await Promise.resolve(); expect(peers[0].addIceCandidate).not.toHaveBeenCalled();
  transport.signal({ routeId: route.id, description: { type: 'offer', sdp: 'offer' } });
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ routeId: route.id, description: { type: 'answer', sdp: 'answer' } }));
  expect(peers[0].addIceCandidate).toHaveBeenCalledWith({ candidate: 'ice' }); expect(peers[0].getSenders()).toEqual([]);
  transport.close();
});
it('ignores a stale signal after revocation and cannot create an outgoing connection without a live local track', async () => {
  const send = vi.fn(), transport = new LiveMediaTransport(send, vi.fn(), vi.fn()); transport.update(snapshot('source')); expect(peers).toHaveLength(0);
  transport.update(snapshot('receiver')); transport.update(snapshot('receiver', [])); transport.signal({ routeId: route.id, description: { type: 'offer', sdp: 'late' } });
  await Promise.resolve(); expect(send).not.toHaveBeenCalled(); expect(peers[0].remoteDescription).toBeNull(); transport.close();
});

it('replaces both peers for rotated route IDs and negotiates a new receive-only stream', async () => {
  const send = vi.fn(), receive = vi.fn(), remote = vi.fn();
  const source = new LiveMediaTransport(send, vi.fn(), vi.fn()), receiver = new LiveMediaTransport(receive, remote, vi.fn());
  source.setStream('audio', stream('same-device')); source.update(snapshot('source')); receiver.update(snapshot('receiver'));
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  receiver.signal(send.mock.calls[0][0]); await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce());
  const oldPeers = [...peers], replacement = { ...route, id: 'route-restarted' };
  source.update(snapshot('source', [replacement])); receiver.update(snapshot('receiver', [replacement]));
  for (const peer of oldPeers) expect(peer.close).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(send.mock.calls[1][0]).toMatchObject({ routeId: replacement.id, description: { type: 'offer' } });
  receiver.signal({ routeId: route.id, description: { type: 'offer', sdp: 'stale' } });
  receiver.signal(send.mock.calls[1][0]); await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(2));
  expect(receive.mock.calls[1][0]).toMatchObject({ routeId: replacement.id, description: { type: 'answer' } });
  expect(peers[3].getSenders()).toEqual([]);
  const incoming = stream('restored-remote'); peers[3].ontrack?.({ streams: [incoming] });
  expect(remote).toHaveBeenLastCalledWith(replacement.id, incoming, replacement);
  source.close(); receiver.close();
});
