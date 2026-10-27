/** Shared Socket.IO room name for subscriptions and authorization. */
export function roomChannel(roomId: string): string {
  return `room_${roomId}`;
}

/** Admission notifications only. Never broadcast game state to this channel. */
export function roomWaitingChannel(roomId: string): string {
  return `room_waiting_${roomId}`;
}
