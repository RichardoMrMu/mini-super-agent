// 02-channel-db.test.mjs — 黑盒契约：channel.db 独立 messageId 去重。
// 错误实现对照：dedup 仍每次展示 / naive 也去重（破坏双发对照）/ 按 conversation 误去重。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelDb } from '../dist/channel-db.js';

test('DEDUP: 同一 messageId 第二次 send 不展示，displayCount=1（错误实现：去重失效）', () => {
  const ch = ChannelDb.open(':memory:', 'dedup');
  const r1 = ch.send('m1', 'c1', 'hello', 1, 1000);
  const r2 = ch.send('m1', 'c1', 'hello', 2, 2000);
  assert.equal(r1.displayed, true);
  assert.equal(r2.displayed, false);
  assert.equal(ch.displayCount('m1'), 1);
  ch.close();
});

test('NAIVE: 不去重对照，同 messageId 每次都展示（错误实现：naive 也偷偷去重）', () => {
  const ch = ChannelDb.open(':memory:', 'naive');
  ch.send('m1', 'c1', 'hello', 1, 1000);
  ch.send('m1', 'c1', 'hello', 2, 2000);
  assert.equal(ch.displayCount('m1'), 2);
  ch.close();
});

test('DEDUP-KEY: 不同 messageId 不受同一 conversation 去重影响（错误实现：按 conv 去重）', () => {
  const ch = ChannelDb.open(':memory:', 'dedup');
  ch.send('m1', 'c1', 'first', 1, 1000);
  const r2 = ch.send('m2', 'c1', 'second', 1, 2000);
  assert.equal(r2.displayed, true);
  assert.equal(ch.displayCount('m2'), 1);
  ch.close();
});
