// Effects dispatcher: durable side effects, enqueued in-domain txn, executed
// at-least-once after commit. Stable key = kind+UNIQUE key.
// reply FIFO: per conversation, oldest written receipt goes first; head-of-line holds
// later ones. 3 attempts -> dropped (then later ones proceed). Crash between channel
// send and engine ack is injectable and deliberately NOT papered over.
import type { EngineDb, EffectRow } from './engine-db.js';
import type { ChannelDb } from './channel-db.js';
import type { RunnerHooks } from './runner.js';

export class Later extends Error {}

interface ReplyPayload {
  receiptId: string;
  conversationId: string;
  messageId: string;
  body: string;
}

export async function processOneDueEffect(
  db: EngineDb,
  channel: ChannelDb,
  hooks: RunnerHooks,
): Promise<boolean> {
  const row = db.tx(() => {
    const due = db.dueEffects(1);
    if (due.length === 0) return undefined;
    db.markEffectRunning(due[0].effectId);
    return due[0];
  });
  if (!row) return false;

  try {
    if (row.kind === 'launch') {
      const { taskId } = JSON.parse(row.payload) as { taskId: string };
      db.tx(() => {
        const t = db.getTask(taskId);
        if (t && t.state === 'queued') db.insertAssignment(taskId, t.stepsDone);
      });
    } else if (row.kind === 'reply') {
      await handleReply(db, channel, row, hooks);
    }
    db.tx(() => db.markEffectDone(row.effectId));
  } catch (e) {
    if (e instanceof Later) {
      // defer WITHOUT counting a terminal failure; back to due for the next sweep
      db.tx(() => {
        db.bumpEffectAttempt(row.effectId);
        db.markEffectDue(row.effectId);
      });
      hooks.trace('effect.later', { key: row.key });
      return true;
    }
    const attempts = db.tx(() => db.bumpEffectAttempt(row.effectId));
    hooks.trace('effect.failed', { key: row.key, attempt: attempts, error: (e as Error).message });
    if (attempts >= 3) {
      if (row.kind === 'launch') {
        const { taskId } = JSON.parse(row.payload) as { taskId: string };
        db.tx(() => {
          const t = db.getTask(taskId);
          if (t && (t.state === 'queued' || t.state === 'running')) db.setTaskState(taskId, 'failed');
        });
      } else {
        const p = JSON.parse(row.payload) as ReplyPayload;
        db.tx(() => db.setReceiptState(p.receiptId, 'dropped'));
      }
      db.tx(() => db.markEffectDone(row.effectId));
      hooks.trace('effect.gaveup', { key: row.key, attempts });
    } else {
      db.tx(() => db.markEffectDue(row.effectId));
    }
  }
  return true;
}

async function handleReply(db: EngineDb, channel: ChannelDb, row: EffectRow, hooks: RunnerHooks): Promise<void> {
  const p = JSON.parse(row.payload) as ReplyPayload;
  const gate = db.tx(() => {
    const r = db.getReceipt(p.receiptId);
    if (!r || r.state !== 'written') return 'skip';
    const oldest = db.writtenReceipts(r.conversationId)[0];
    if (!oldest || oldest.receiptId !== r.receiptId) return 'later';
    return 'go';
  });
  if (gate === 'skip') return;
  if (gate === 'later') throw new Later();

  const attempts = db.tx(() => db.bumpReceiptAttempt(p.receiptId));
  channel.send(p.messageId, p.conversationId, p.body, attempts, Date.now());
  if (process.env.MOCK_CRASH_AFTER_SEND) {
    console.error('[crash-inject] process.exit(13) after channel send, before engine ack');
    process.exit(13);
  }
  db.tx(() => db.setReceiptState(p.receiptId, attempts >= 3 ? 'dropped' : 'accepted'));
  hooks.trace('reply', {
    receiptId: p.receiptId,
    conversationId: p.conversationId,
    messageId: p.messageId,
    attempt: attempts,
    channelMode: channel.mode,
  });
}
