// Engine: the ONLY writer of domain aggregates. Every command is one transaction.
// Identity-first intake: a re-delivered event returns its recorded disposition
// without consulting any gate, so idempotency is immune to policy drift.
import type { EngineDb } from './engine-db.js';
import type { ExternalEvent } from './types.js';
import { eventIdOf } from './schema.js';

export type IntakeResult = 'stored' | 'duplicate' | 'filtered';

export interface IntakeOutcome {
  result: IntakeResult;
  note?: string;
}

export function intake(db: EngineDb, e: ExternalEvent, passThrough: boolean): IntakeOutcome {
  const eventId = eventIdOf(e);
  return db.tx(() => {
    const prior = db.eventDisposition(eventId);
    if (prior) return { result: 'duplicate', note: `eventId=${eventId} already ${prior}` };

    if (e.type === 'message') {
      db.insertTask({
        taskId: e.taskId,
        threadId: e.threadId,
        stepsTotal: e.task!.steps,
        stepsDone: 0,
        state: 'queued',
        spill: e.task!.spill ? 1 : 0,
        stepMs: e.task!.stepMs,
      });
      db.enqueueEffect('launch', `launch:${e.taskId}`, JSON.stringify({ taskId: e.taskId }));
      db.insertEvent(eventId, e.threadId, e.type, e.taskId, e.body, 'stored');
      return { result: 'stored', note: `task ${e.taskId} queued` };
    }

    if (e.type === 'followup') {
      if (!passThrough) {
        db.insertInput({ inputId: `in:${eventId}`, taskId: e.taskId, body: e.body, state: 'filtered' });
        db.insertEvent(eventId, e.threadId, e.type, e.taskId, e.body, 'filtered');
        return { result: 'filtered', note: 'pass-through disabled (stage<3)' };
      }
      const task = db.getTask(e.taskId);
      if (task && (task.state === 'queued' || task.state === 'running')) {
        db.insertInput({ inputId: `in:${eventId}`, taskId: e.taskId, body: e.body, state: 'queued' });
        db.insertEvent(eventId, e.threadId, e.type, e.taskId, e.body, 'stored');
        return { result: 'stored', note: `appended to ${e.taskId} state=${task.state}` };
      }
      db.insertInput({ inputId: `in:${eventId}`, taskId: e.taskId, body: e.body, state: 'filtered' });
      db.insertEvent(eventId, e.threadId, e.type, e.taskId, e.body, 'filtered');
      const why = task ? `task ${task.state}, already terminating` : `no active task ${e.taskId}`;
      return { result: 'filtered', note: `append filtered: ${why}` };
    }

    // cancel
    const task = db.getTask(e.taskId);
    if (task && task.state === 'queued') {
      // never started: cancel wins immediately, no assignment, no dangling inputs.
      // Any assignment row already queued for this task must die with it.
      db.setTaskState(e.taskId, 'cancelled');
      db.finishQueuedAssignments(e.taskId);
      db.filterQueuedInputs(e.taskId);
      enqueueReply(db, e.taskId, task.threadId, `[cancelled] ${e.taskId} (never started)`);
      db.insertEvent(eventId, e.threadId, e.type, e.taskId, e.body, 'stored');
      return { result: 'stored', note: `cancel on queued ${e.taskId} -> cancelled immediately` };
    }
    if (task && task.state === 'running') {
      db.setTaskState(e.taskId, 'cancelling');
      db.insertEvent(eventId, e.threadId, e.type, e.taskId, e.body, 'stored');
      return { result: 'stored', note: `cancel intent on ${e.taskId} state=running` };
    }
    db.insertEvent(eventId, e.threadId, e.type, e.taskId, e.body, 'filtered');
    return { result: 'filtered', note: `nothing to cancel for ${e.taskId}` };
  });
}

// Outbox: receipt row + reply effect row in the SAME transaction. Shared by the
// intake-time immediate cancel path and the runner's terminal boundaries.
export function enqueueReply(db: EngineDb, taskId: string, conversationId: string, body: string): void {
  const receiptId = `r-end-${taskId}`;
  db.insertReceipt({
    receiptId,
    taskId,
    conversationId,
    messageId: `m-end-${taskId}`,
    body,
    state: 'written',
    attempts: 0,
  });
  db.enqueueEffect(
    'reply',
    `reply:end:${taskId}`,
    JSON.stringify({ receiptId, conversationId, messageId: `m-end-${taskId}`, body }),
  );
}

// Boot recovery. Contract: crashed running task -> interrupted (terminal) + new queued
// assignment; crashed cancelling task -> cancelled outright, never restarted.
// Caller runs this AFTER opening the db and BEFORE starting workers/effects.
export function recoverAtBoot(db: EngineDb): { crashed: boolean; recovered: string[] } {
  const crashed = db.getMeta('lastShutdown') === 'running';
  db.setMeta('lastShutdown', 'running');
  if (!crashed) return { crashed: false, recovered: [] };

  const notes: string[] = [];
  const running = db.tasksByState('running');
  for (const t of running) {
    db.tx(() => {
      db.finishRunningAssignments();
      db.setTaskState(t.taskId, 'queued'); // resumable: stepsDone/checkpoints are the context
      db.insertAssignment(t.taskId, t.stepsDone); // direct requeue; old launch effect row is done and key-stable
    });
    notes.push(`${t.taskId}: assignment interrupted, task re-queued from step ${t.stepsDone}`);
  }
  const cancelling = db.tasksByState('cancelling');
  for (const t of cancelling) {
    db.tx(() => db.setTaskState(t.taskId, 'cancelled'));
    notes.push(`${t.taskId}: cancelling->cancelled (no restart)`);
  }
  const reset = db.tx(() => db.resetRunningEffects());
  if (reset > 0) notes.push(`${reset} orphaned effect(s) reset to due`);
  return { crashed: true, recovered: notes };
}

export function gracefulShutdown(db: EngineDb): void {
  db.setMeta('lastShutdown', 'clean');
}
