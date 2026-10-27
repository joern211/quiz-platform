import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '@prisma/client';

export interface CommandExecution {
  roomId: string;
  commandId: string;
  executionToken: string;
  expectedRevision?: number;
  recoverySnapshot?: { roomRevision: number; stateRevision: number | null };
  closed: boolean;
  actorId?: string;
  action?: string;
}

const executions = new AsyncLocalStorage<CommandExecution>();
export function currentCommandMetadata(): { commandId: string | null; actorId: string | null; action: string | null } {
  const execution = executions.getStore();
  return { commandId: execution?.commandId ?? null, actorId: execution?.actorId ?? null, action: execution?.action ?? null };
}

export class CommandExecutionError extends Error {
  constructor(readonly code: 'COMMAND_OWNERSHIP_LOST' | 'REVISION_CONFLICT' | 'COMMAND_STATE_ADVANCED') {
    super(code);
    this.name = 'CommandExecutionError';
  }
}

export function withCommandExecution<T>(execution: CommandExecution, run: () => Promise<T>): Promise<T> {
  return executions.run(execution, run);
}

/** Timers are independent server actions, not continuations of a client intent. */
export function withoutCommandExecution<T>(run: () => T): T {
  return executions.exit(run);
}

/**
 * Called INSIDE the engine's writing transaction. The receipt row is a write
 * fence: takeover and mutation cannot both win. The first committed engine
 * write also pins the client's Room revision and marks the intent as applied.
 * Later transactions of the SAME intent may observe its own advanced revision.
 */
export async function assertCommandMutation(tx: Prisma.TransactionClient, roomId: string): Promise<void> {
  const execution = executions.getStore();
  if (!execution) return; // Legacy actions / explicitly detached timers.
  if (execution.closed || execution.roomId !== roomId) throw new CommandExecutionError('COMMAND_OWNERSHIP_LOST');
  const receipt = await tx.commandReceipt.findUnique({
    where: { roomId_commandId: { roomId, commandId: execution.commandId } },
  });
  if (!receipt || receipt.status !== 'PENDING' || receipt.executionToken !== execution.executionToken) {
    throw new CommandExecutionError('COMMAND_OWNERSHIP_LOST');
  }
  const expectedRoomRevision = execution.expectedRevision ?? execution.recoverySnapshot?.roomRevision;
  if (!receipt.mutationStartedAt && expectedRoomRevision !== undefined) {
    // Conditional write locks the Room revision until this transaction commits;
    // a read-then-compare alone would race on databases using READ COMMITTED.
    const room = await tx.room.updateMany({
      where: { id: roomId, revision: expectedRoomRevision }, data: { revision: { increment: 0 } },
    });
    if (room.count !== 1) throw new CommandExecutionError(execution.expectedRevision !== undefined ? 'REVISION_CONFLICT' : 'COMMAND_STATE_ADVANCED');
  }
  if (!receipt.mutationStartedAt && execution.recoverySnapshot) {
    const state = await tx.roomGameState.findUnique({ where: { roomId }, select: { revision: true } });
    if ((state?.revision ?? null) !== execution.recoverySnapshot.stateRevision) {
      throw new CommandExecutionError('COMMAND_STATE_ADVANCED');
    }
  }
  // Always write, including subsequent engine transactions: this locks the
  // owner/status check against a concurrent takeover or timeout finalization.
  const owned = await tx.commandReceipt.updateMany({
    where: { roomId, commandId: execution.commandId, executionToken: execution.executionToken, status: 'PENDING' },
    data: { mutationStartedAt: receipt.mutationStartedAt ?? new Date() },
  });
  if (owned.count !== 1) throw new CommandExecutionError('COMMAND_OWNERSHIP_LOST');
}
