// engine.db: the single writer of all domain state. One command = one transaction.
// External calls (model, channel) NEVER happen inside a transaction.
import { DatabaseSync } from 'node:sqlite';

export interface TaskRow {
  taskId: string;
  threadId: string;
  stepsTotal: number;
  stepsDone: number;
  state: string;
  spill: number;
  stepMs: number;
}

export interface InputRow {
  inputId: string;
  taskId: string;
  body: string;
  state: string;
}

export interface EffectRow {
  effectId: number;
  kind: string;
  key: string;
  payload: string;
  state: string;
  attempts: number;
}

export interface ReceiptRow {
  receiptId: string;
  taskId: string | null;
  conversationId: string;
  messageId: string;
  body: string;
  state: string;
  attempts: number;
}

export class EngineDb {
  private db: DatabaseSync;

  private constructor(path: string | ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events(
        eventId TEXT PRIMARY KEY,
        threadId TEXT NOT NULL,
        type TEXT NOT NULL,
        taskId TEXT NOT NULL,
        body TEXT NOT NULL,
        disposition TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks(
        taskId TEXT PRIMARY KEY,
        threadId TEXT NOT NULL,
        stepsTotal INTEGER NOT NULL,
        stepsDone INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL,
        spill INTEGER NOT NULL,
        stepMs INTEGER NOT NULL DEFAULT 5
      );
      CREATE TABLE IF NOT EXISTS inputs(
        inputId TEXT PRIMARY KEY,
        taskId TEXT NOT NULL,
        body TEXT NOT NULL,
        state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assignments(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        taskId TEXT NOT NULL,
        seq INTEGER NOT NULL,
        state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS steps(
        taskId TEXT NOT NULL,
        stepN INTEGER NOT NULL,
        result TEXT NOT NULL,
        PRIMARY KEY(taskId, stepN)
      );
      CREATE TABLE IF NOT EXISTS effects(
        effectId INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        key TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS receipts(
        receiptId TEXT PRIMARY KEY,
        taskId TEXT,
        conversationId TEXT NOT NULL,
        messageId TEXT NOT NULL,
        body TEXT NOT NULL,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
  }

  static open(path: string | ':memory:'): EngineDb {
    return new EngineDb(path);
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- meta (graceful vs crashed boot) ----
  getMeta(k: string): string | undefined {
    const row = this.db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined;
    return row?.v;
  }
  setMeta(k: string, v: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)').run(k, v);
  }

  // ---- events (identity-first dedup: disposition recorded at first intake) ----
  eventDisposition(eventId: string): string | undefined {
    const row = this.db.prepare('SELECT disposition FROM events WHERE eventId = ?').get(eventId) as
      | { disposition: string }
      | undefined;
    return row?.disposition;
  }
  insertEvent(eventId: string, threadId: string, type: string, taskId: string, body: string, disposition: string): void {
    this.db
      .prepare('INSERT INTO events(eventId, threadId, type, taskId, body, disposition) VALUES (?, ?, ?, ?, ?, ?)')
      .run(eventId, threadId, type, taskId, body, disposition);
  }

  // ---- tasks ----
  getTask(taskId: string): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE taskId = ?').get(taskId) as TaskRow | undefined;
  }
  insertTask(task: TaskRow): void {
    this.db
      .prepare('INSERT INTO tasks(taskId, threadId, stepsTotal, stepsDone, state, spill, stepMs) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(task.taskId, task.threadId, task.stepsTotal, task.stepsDone, task.state, task.spill, task.stepMs);
  }
  setStepsDone(taskId: string, stepsDone: number): void {
    this.db.prepare('UPDATE tasks SET stepsDone = ? WHERE taskId = ?').run(stepsDone, taskId);
  }
  setTaskState(taskId: string, state: string): void {
    this.db.prepare('UPDATE tasks SET state = ? WHERE taskId = ?').run(state, taskId);
  }
  activeTasks(): TaskRow[] {
    return this.db
      .prepare("SELECT * FROM tasks WHERE state IN ('queued','running','cancelling')")
      .all() as unknown as TaskRow[];
  }
  tasksByState(state: string): TaskRow[] {
    return this.db.prepare('SELECT * FROM tasks WHERE state = ?').all(state) as unknown as TaskRow[];
  }

  // ---- inputs ----
  insertInput(input: InputRow): void {
    this.db.prepare('INSERT INTO inputs(inputId, taskId, body, state) VALUES (?, ?, ?, ?)').run(
      input.inputId,
      input.taskId,
      input.body,
      input.state,
    );
  }
  queuedInputs(taskId: string): InputRow[] {
    return this.db.prepare("SELECT * FROM inputs WHERE taskId = ? AND state = 'queued'").all(taskId) as unknown as InputRow[];
  }
  markInputsConsumed(inputIds: string[]): void {
    const stmt = this.db.prepare("UPDATE inputs SET state = 'consumed' WHERE inputId = ?");
    for (const id of inputIds) stmt.run(id);
  }
  filterQueuedInputs(taskId: string): number {
    const r = this.db.prepare("UPDATE inputs SET state = 'filtered' WHERE taskId = ? AND state = 'queued'").run(taskId);
    return Number(r.changes);
  }

  // ---- assignments ----
  insertAssignment(taskId: string, seq: number): number {
    const r = this.db
      .prepare("INSERT INTO assignments(taskId, seq, state) VALUES (?, ?, 'queued')")
      .run(taskId, seq);
    return Number(r.lastInsertRowid);
  }
  claimQueuedAssignment(): { id: number; taskId: string; seq: number } | undefined {
    const row = this.db
      .prepare("SELECT id, taskId, seq FROM assignments WHERE state = 'queued' ORDER BY id LIMIT 1")
      .get() as { id: number; taskId: string; seq: number } | undefined;
    if (!row) return undefined;
    this.db.prepare("UPDATE assignments SET state = 'running' WHERE id = ?").run(row.id);
    return row;
  }
  finishAssignment(id: number): void {
    this.db.prepare("UPDATE assignments SET state = 'reported' WHERE id = ?").run(id);
  }
  finishRunningAssignments(): number {
    const r = this.db.prepare("UPDATE assignments SET state = 'reported' WHERE state = 'running'").run();
    return Number(r.changes);
  }
  finishQueuedAssignments(taskId: string): number {
    const r = this.db.prepare("UPDATE assignments SET state = 'reported' WHERE taskId = ? AND state = 'queued'").run(taskId);
    return Number(r.changes);
  }

  // ---- steps (checkpoint, durable context) ----
  insertStep(taskId: string, stepN: number, result: string): void {
    this.db.prepare('INSERT OR REPLACE INTO steps(taskId, stepN, result) VALUES (?, ?, ?)').run(taskId, stepN, result);
  }
  stepCount(taskId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM steps WHERE taskId = ?').get(taskId) as { c: number };
    return row.c;
  }

  // ---- effects (enqueued in-domain txn, executed at-least-once after commit) ----
  enqueueEffect(kind: string, key: string, payload: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO effects(kind, key, payload, state) VALUES (?, ?, ?, 'due')")
      .run(kind, key, payload);
  }
  dueEffects(limit: number): EffectRow[] {
    return this.db
      .prepare("SELECT * FROM effects WHERE state = 'due' ORDER BY effectId LIMIT ?")
      .all(limit) as unknown as EffectRow[];
  }
  markEffectRunning(effectId: number): void {
    this.db.prepare("UPDATE effects SET state = 'running' WHERE effectId = ?").run(effectId);
  }
  markEffectDone(effectId: number): void {
    this.db.prepare("UPDATE effects SET state = 'done' WHERE effectId = ?").run(effectId);
  }
  markEffectDue(effectId: number): void {
    this.db.prepare("UPDATE effects SET state = 'due' WHERE effectId = ?").run(effectId);
  }
  bumpEffectAttempt(effectId: number): number {
    this.db.prepare('UPDATE effects SET attempts = attempts + 1 WHERE effectId = ?').run(effectId);
    const row = this.db.prepare('SELECT attempts FROM effects WHERE effectId = ?').get(effectId) as {
      attempts: number;
    };
    return row.attempts;
  }
  resetRunningEffects(): number {
    const r = this.db.prepare("UPDATE effects SET state = 'due' WHERE state = 'running'").run();
    return Number(r.changes);
  }

  // ---- receipts (outbox: written in-domain txn; ack after channel send) ----
  insertReceipt(r: ReceiptRow): void {
    this.db
      .prepare('INSERT INTO receipts(receiptId, taskId, conversationId, messageId, body, state, attempts) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(r.receiptId, r.taskId, r.conversationId, r.messageId, r.body, r.state, r.attempts);
  }
  getReceipt(receiptId: string): ReceiptRow | undefined {
    return this.db.prepare('SELECT * FROM receipts WHERE receiptId = ?').get(receiptId) as ReceiptRow | undefined;
  }
  writtenReceipts(conversationId: string): ReceiptRow[] {
    return this.db
      .prepare("SELECT * FROM receipts WHERE conversationId = ? AND state = 'written' ORDER BY receiptId")
      .all(conversationId) as unknown as ReceiptRow[];
  }
  allWrittenReceipts(): ReceiptRow[] {
    return this.db.prepare("SELECT * FROM receipts WHERE state = 'written' ORDER BY receiptId").all() as unknown as ReceiptRow[];
  }
  setReceiptState(receiptId: string, state: string): void {
    this.db.prepare('UPDATE receipts SET state = ? WHERE receiptId = ?').run(state, receiptId);
  }
  bumpReceiptAttempt(receiptId: string): number {
    this.db.prepare('UPDATE receipts SET attempts = attempts + 1 WHERE receiptId = ?').run(receiptId);
    const row = this.db.prepare('SELECT attempts FROM receipts WHERE receiptId = ?').get(receiptId) as {
      attempts: number;
    };
    return row.attempts;
  }
}
