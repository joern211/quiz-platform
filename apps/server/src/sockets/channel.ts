/** Shared Socket.IO room name for subscriptions and authorization. */
export function roomChannel(roomId: string): string {
  return `room_${roomId}`;
}
