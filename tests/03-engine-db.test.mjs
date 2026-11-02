// 03-engine-db.test.mjs — 黑盒契约：每命令一个原子事务；effects 稳定 key。
// 错误实现对照：事务部分提交 / 重复 key 两行 / running effect 恢复时卡死。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineDb } from '../dist/engine-db.js';

test('TX-ROLLBACK: 事务内抛错，已写行全部回滚（错误实现：部分提交）', () => {
  const db = EngineDb.open(':memory:');
  assert.throws(() =>
    db.tx(() => {
      db.enqueueEffect('launch', 'launch:X', '{}');
      throw new Error('boom');
    }),
  );
  assert.equal(db.dueEffects(10).length, 0);
  db.close();
});

test('EFFECT-KEY: 同稳定 key 重复入队只一行（错误实现：无 UNIQUE/INSERT OR IGNORE）', () => {
  const db = EngineDb.open(':memory:');
  db.enqueueEffect('reply', 'reply:end:A', '{}');
  db.enqueueEffect('reply', 'reply:end:A', '{}');
  assert.equal(db.dueEffects(10).length, 1);
  db.close();
});

test('RESET-RUNNING: 崩溃恢复把 running effect 重置回 due（错误实现：留下 running 僵尸）', () => {
  const db = EngineDb.open(':memory:');
  db.enqueueEffect('reply', 'reply:end:A', '{}');
  const row = db.dueEffects(1)[0];
  db.tx(() => db.markEffectRunning(row.effectId));
  const n = db.tx(() => db.resetRunningEffects());
  assert.equal(n, 1);
  assert.equal(db.dueEffects(10).length, 1);
  db.close();
});

test('INPUT-CONSUME: queuedInputs 只见未消费，markInputsConsumed 后清空（错误实现：消费不清/重复读）', () => {
  const db = EngineDb.open(':memory:');
  db.tx(() => {
    db.insertTask({ taskId: 'A', threadId: 't', stepsTotal: 1, stepsDone: 0, state: 'queued', spill: 0, stepMs: 1 });
    db.insertInput({ inputId: 'in:1', taskId: 'A', body: 'x', state: 'queued' });
  });
  assert.equal(db.queuedInputs('A').length, 1);
  db.tx(() => db.markInputsConsumed(['in:1']));
  assert.equal(db.queuedInputs('A').length, 0);
  db.close();
});
