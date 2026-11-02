// 05-recovery.test.mjs — 黑盒契约：boot 恢复语义。
// 错误实现对照：running 任务恢复后原地继续 / cancelling 重启复活 / 干净关机被当崩溃。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EngineDb } from '../dist/engine-db.js';
import { recoverAtBoot, gracefulShutdown } from '../dist/engine.js';

function taskRow(taskId, state) {
  return { taskId, threadId: 't1', stepsTotal: 1, stepsDone: 0, state, spill: 0, stepMs: 1 };
}

test('BOOT-RUNNING: 崩溃后 running → queued 保持 stepsDone，直接插新 assignment（不重 enqueue launch）（错误实现：interrupted 终态/重发 launch 撞 UNIQUE）', () => {
  const db = EngineDb.open(':memory:');
  db.insertTask({ taskId: 'R', threadId: 't1', stepsTotal: 3, stepsDone: 1, state: 'running', spill: 0, stepMs: 1 });
  db.setMeta('lastShutdown', 'running');
  const rec = recoverAtBoot(db);
  assert.equal(rec.crashed, true);
  assert.equal(db.getTask('R')?.state, 'queued');
  assert.equal(db.getTask('R')?.stepsDone, 1);
  assert.equal(db.dueEffects(10).filter((e) => e.key === 'launch:R').length, 0);
  db.close();
});

test('BOOT-CANCELLING: 崩溃在 cancelling → 直接 cancelled，不复活（错误实现：cancelling 重启继续跑）', () => {
  const db = EngineDb.open(':memory:');
  db.insertTask(taskRow('C', 'cancelling'));
  db.setMeta('lastShutdown', 'running');
  const rec = recoverAtBoot(db);
  assert.equal(rec.crashed, true);
  assert.equal(db.getTask('C')?.state, 'cancelled');
  assert.equal(db.dueEffects(10).some((e) => e.key === 'launch:C'), false);
  db.close();
});

test('BOOT-ASSIGNMENTS: 旧 running assignment 行终态=reported，且恰一条新 queued assignment（错误实现：旧行被重置重复领 / 漏插新行）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'msa-rec-'));
  const dbPath = join(dir, 'engine.db');
  const db = EngineDb.open(dbPath);
  db.insertTask(taskRow('R', 'running'));
  const oldId = db.insertAssignment('R', 0);
  db.tx(() => db.claimQueuedAssignment()); // 旧 assignment 置 running
  db.setMeta('lastShutdown', 'running');
  recoverAtBoot(db);
  db.close();
  // 独立只读连接直接查 assignments 行终态，不穿透被测对象内部字段
  const probe = new DatabaseSync(dbPath);
  try {
    const rows = probe.prepare('SELECT id, state FROM assignments').all();
    const oldRow = rows.find((r) => r.id === oldId);
    assert.ok(oldRow && oldRow.state === 'reported', `旧 assignment 应归终态 reported，实得 ${oldRow?.state}`);
    const queuedRows = rows.filter((r) => r.state === 'queued');
    assert.equal(queuedRows.length, 1, `恢复后应恰一条 queued assignment，实得 ${queuedRows.length} 条`);
    assert.notEqual(queuedRows[0].id, oldId);
  } finally {
    probe.close();
  }
});

test('BOOT-CLEAN: 干净关机标记 → crashed=false，不动任务（错误实现：把 clean 当崩溃）', () => {
  const db = EngineDb.open(':memory:');
  db.insertTask(taskRow('K', 'completed'));
  gracefulShutdown(db);
  const rec = recoverAtBoot(db);
  assert.equal(rec.crashed, false);
  assert.equal(rec.recovered.length, 0);
  assert.equal(db.getTask('K')?.state, 'completed');
  db.close();
});

test('BOOT-EFFECTS: 恢复时 running effect 归位 due（错误实现：孤儿 effect 永久 running）', () => {
  const db = EngineDb.open(':memory:');
  db.enqueueEffect('reply', 'reply:end:A', '{}');
  const row = db.dueEffects(1)[0];
  db.tx(() => db.markEffectRunning(row.effectId));
  db.setMeta('lastShutdown', 'running');
  recoverAtBoot(db);
  assert.equal(db.dueEffects(10).length, 1);
  db.close();
});
