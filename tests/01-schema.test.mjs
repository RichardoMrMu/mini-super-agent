// 01-schema.test.mjs — 黑盒契约：loadEvents 严格 schema。
// 错误实现对照：宽松解析（忽略未知 key / 缺 task / 错 schema）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEvents, eventIdOf } from '../dist/schema.js';

function writeDoc(doc) {
  const dir = mkdtempSync(join(tmpdir(), 'msa-schema-'));
  const p = join(dir, 'events.json');
  writeFileSync(p, JSON.stringify(doc));
  return p;
}

const base = {
  at: 0, type: 'message', threadId: 't1', taskId: 'A', body: 'b',
  task: { steps: 1, stepMs: 1, spill: false },
};

test('SORT: 事件按 at 升序返回（错误实现：保持文件顺序）', () => {
  const p = writeDoc({
    schema: 'v1',
    events: [
      { ...base, at: 5 },
      { ...base, at: 0, taskId: 'Z' },
      { ...base, at: 2, taskId: 'Y' },
    ],
  });
  const doc = loadEvents(p);
  assert.deepEqual(doc.events.map((e) => e.taskId), ['Z', 'Y', 'A']);
});

test('ROOT-KEY: 未知根 key 拒绝（错误实现：容忍额外字段）', () => {
  const p = writeDoc({ schema: 'v1', events: [], hacked: true });
  assert.throws(() => loadEvents(p), /unknown root keys/);
});

test('EVENT-KEY: 未知事件 key 拒绝（错误实现：逐字段容忍）', () => {
  const p = writeDoc({ schema: 'v1', events: [{ ...base, bogus: 1 }] });
  assert.throws(() => loadEvents(p), /unknown key "bogus"/);
});

test('SCHEMA: 非 v1 即拒绝（错误实现：默认接受旧 schema）', () => {
  const p = writeDoc({ schema: 'v0', events: [] });
  assert.throws(() => loadEvents(p), /unsupported schema/);
});

test('TASK-COUPLE: message 必须带 task（错误实现：message 可无 task）', () => {
  const { task, ...noTask } = base;
  const p = writeDoc({ schema: 'v1', events: [noTask] });
  assert.throws(() => loadEvents(p), /message requires task/);
});

test('TASK-COUPLE: followup/cancel 不得带 task（错误实现：不校验耦合）', () => {
  const p = writeDoc({
    schema: 'v1',
    events: [{ ...base, type: 'followup', taskId: 'A', task: { steps: 1, stepMs: 1, spill: false } }],
  });
  assert.throws(() => loadEvents(p), /only message may carry task/);
});

test('EVENT-ID: eventIdOf 形状固定（错误实现：换格式导致重投撞 id）', () => {
  const e = { at: 7, type: 'message', threadId: 't9', taskId: 'Q', body: 'x' };
  assert.equal(eventIdOf(e), 't9:7:message:Q');
});
