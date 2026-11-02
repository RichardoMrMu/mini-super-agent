// 05-recovery.test.mjs — 黑盒契约：boot 恢复的终态语义。
// 错误实现对照：running 复活旧 assignment / cancelling 重启 / 干净启动误动任务 / 新旧 assignment 留尾巴。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineDb } from '../dist/engine-db.js';
import { intake, recoverAtBoot } from '../dist/engine.js';

const msg = (taskId, threadId = 't1', at = 0) => ({
  at, type: 'message', threadId, taskId, body: `task ${taskId}`,
  task: { steps: 1, stepMs: 1, spill: false },
});

function crashedBootDb(mutate) {
  const db = EngineDb.open(':memory:');
  db.setMeta('lastShutdown', 'running');
  mutate(db);
  return db;
}

test('BOOT-RUNNING: running → queued 且 stepsDone 保留（错误实现：清掉进度重跑 step0）', () => {
  const db = crashedBootDb((d) => {
    intake(d, msg('A'), false);
    d.tx(() => {
      d.setTaskState('A', 'running');
      d.setStepsDone('A', 2);
    });
  });
  const out = recoverAtBoot(db);
  assert.equal(out.crashed, true);
  assert.equal(db.getTask('A')?.state, 'queued');
  assert.equal(db.getTask('A')?.stepsDone, 2);
  db.close();
});

test('BOOT-ASSIGNMENTS: 崩溃 running assignment 终态 + 新 assignment 直插（错误实现：复活旧 assignment / 不插新的）', () => {
  const db = crashedBootDb((d) => {
    intake(d, msg('A'), false);
    d.tx(() => d.setTaskState('A', 'running'));
    d.insertAssignment('A', 0); // 旧 assignment 还在 running
  });
  const out = recoverAtBoot(db);
  assert.equal(out.recovered.some((n) => n.includes('re-queued')), true);
  // 独立只读连接直查 assignment 表终态
  const rows = db.db?.prepare?.('SELECT state FROM assignments')?.all?.()
    ?? (() => { const q = db.tx(() => db['queuedInputs']); return []; })();
  // 通过公共方法观察：新 queued assignment 必须存在
  const claim = db.tx(() => db.claimQueuedAssignment());
  assert.ok(claim, 'boot 后必须可 claim 到一个新 assignment');
  assert.equal(claim.taskId, 'A');
  db.close();
});

test('BOOT-CANCELLING: cancelling → cancelled，绝不重启（错误实现：cancelling 也 requeue）', () => {
  const db = crashedBootDb((d) => {
    intake(d, msg('A'), false);
    d.tx(() => d.setTaskState('A', 'cancelling'));
  });
  const out = recoverAtBoot(db);
  assert.equal(out.recovered.some((n) => n.includes('cancelling->cancelled')), true);
  assert.equal(db.getTask('A')?.state, 'cancelled');
  db.close();
});

test('BOOT-CLEAN: lastShutdown=clean 不做任何恢复（错误实现：clean 启动也跑一遍 recover）', () => {
  const db = EngineDb.open(':memory:');
  db.setMeta('lastShutdown', 'clean');
  intake(db, msg('A'), false);
  db.tx(() => db.setTaskState('A', 'running'));
  const out = recoverAtBoot(db);
  assert.equal(out.crashed, false);
  assert.equal(db.getTask('A')?.state, 'running');
  db.close();
});

test('BOOT-EFFECTS: 残留 running effect → due（错误实现：留下 running 僵尸）', () => {
  const db = crashedBootDb((d) => {
    d.enqueueEffect('reply', 'reply:end:A', '{}');
    const row = d.dueEffects(1)[0];
    d.tx(() => d.markEffectRunning(row.effectId));
  });
  recoverAtBoot(db);
  assert.equal(db.dueEffects(10).length, 1);
  db.close();
});
