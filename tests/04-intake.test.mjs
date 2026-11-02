// 04-intake.test.mjs — 黑盒契约：事件入口幂等 + pass-through 边界。
// 错误实现对照：重复事件重处理 / pass-through 关闭仍 append / 完结任务收消息。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineDb } from '../dist/engine-db.js';
import { intake } from '../dist/engine.js';

const msg = (taskId, threadId = 't1', at = 0) => ({
  at, type: 'message', threadId, taskId, body: `task ${taskId}`,
  task: { steps: 1, stepMs: 1, spill: false },
});
const fu = (taskId, at) => ({ at, type: 'followup', threadId: 't1', taskId, body: 'add' });
const canc = (taskId, at) => ({ at, type: 'cancel', threadId: 't1', taskId, body: 'stop' });

function fresh() {
  const db = EngineDb.open(':memory:');
  return db;
}

test('INTAKE-MSG: message 落 queued 任务并排 launch effect（错误实现：只建任务不发 launch）', () => {
  const db = fresh();
  const out = intake(db, msg('A'), true);
  assert.equal(out.result, 'stored');
  assert.equal(db.getTask('A')?.state, 'queued');
  assert.equal(db.dueEffects(10).some((e) => e.key === 'launch:A'), true);
  db.close();
});

test('INTAKE-DUP: 同一事件重投返回 duplicate，不建第二个任务（错误实现：按到达重处理）', () => {
  const db = fresh();
  intake(db, msg('A'), true);
  const again = intake(db, msg('A'), true);
  assert.equal(again.result, 'duplicate');
  assert.equal(db.tasksByState('queued').length, 1);
  assert.equal(db.dueEffects(10).filter((e) => e.key === 'launch:A').length, 1);
  db.close();
});

test('PASSTHROUGH-OFF: stage<3 时 followup 一律 filtered（错误实现：未开 pass-through 仍 append）', () => {
  const db = fresh();
  intake(db, msg('A'), false);
  const out = intake(db, fu('A', 1), false);
  assert.equal(out.result, 'filtered');
  assert.equal(db.queuedInputs('A').length, 0);
  db.close();
});

test('PASSTHROUGH-ON: 活跃任务收 followup → queued input（错误实现：活跃任务也 filtered）', () => {
  const db = fresh();
  intake(db, msg('A'), true);
  const out = intake(db, fu('A', 1), true);
  assert.equal(out.result, 'stored');
  assert.equal(db.queuedInputs('A').length, 1);
  db.close();
});

test('CANCEL-QUEUED: queued 任务收 cancel → 同 tx 立即 cancelled，清 queued assignment/input 并回 reply（错误实现：queued cancel 只标 cancelling 留尾巴）', () => {
  const db = fresh();
  intake(db, msg('A'), true);
  db.insertAssignment('A', 0);
  db.insertInput({ inputId: 'in:late', taskId: 'A', body: 'x', state: 'queued' });
  const out = intake(db, canc('A', 1), true);
  assert.equal(out.result, 'stored');
  assert.equal(db.getTask('A')?.state, 'cancelled');
  assert.equal(db.queuedInputs('A').length, 0);
  assert.equal(db.getReceipt('r-end-A')?.state, 'written');
  db.close();
});

test('CANCEL-RUNNING: running 任务收 cancel → cancelling 意图（错误实现：running cancel 立即终态）', () => {
  const db = fresh();
  intake(db, msg('A'), true);
  db.tx(() => db.setTaskState('A', 'running'));
  const out = intake(db, canc('A', 1), true);
  assert.equal(out.result, 'stored');
  assert.equal(db.getTask('A')?.state, 'cancelling');
  db.close();
});

test('LATE-FOLLOWUP: 已完结任务收 followup → filtered，不复活（错误实现：给完结任务 append）', () => {
  const db = fresh();
  intake(db, msg('A'), true);
  db.tx(() => db.setTaskState('A', 'completed'));
  const out = intake(db, fu('A', 99), true);
  assert.equal(out.result, 'filtered');
  assert.equal(db.queuedInputs('A').length, 0);
  db.close();
});
