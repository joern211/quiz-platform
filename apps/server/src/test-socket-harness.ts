import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';

/** Real Socket.IO helpers for game integration tests. */
export async function connectGameClient(origin: string, cookie?: string): Promise<ClientSocket> {
  const socket = clientIo(origin, {
    transports: ['websocket'], forceNew: true,
    extraHeaders: cookie ? { Cookie: cookie } : undefined,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}

export function gameAck(socket: ClientSocket, event: string, data: object = {}): Promise<Record<string, unknown>> {
  return socket.timeout(6000).emitWithAck(event, data) as Promise<Record<string, unknown>>;
}
