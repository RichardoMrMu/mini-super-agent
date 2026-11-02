// 06-state-lock.test.mjs — 黑盒契约：单实例看门狗。
// 错误实现对照：活 pid 被当成 stale 覆盖 / 死 pid 不敢接管 / LOCK 损坏仍启动。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateLock } from '../dist/lock.js';

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'msa-lock-'));
}

test('WX-FRESH: 空目录获得 LOCK 且写本进程 pid（错误实现：不写 LOCK）', () => {
  const dir = freshDir();
  const l = new StateLock(dir);
  assert.equal(l.acquire(), 'acquired');
  assert.ok(readFileSync(join(dir, 'LOCK'), 'utf8').trim().length > 0);
  l.release();
});

test('WX-LIVEPID: LOCK 指向活 pid → refused-live-pid，拒绝启动（错误实现：活 pid 也覆盖接管）', () => {
  const dir = freshDir();
  writeFileSync(join(dir, 'LOCK'), `${process.pid}\n`); // 本进程自己就是活 pid
  const l = new StateLock(dir);
  assert.equal(l.acquire(), 'refused-live-pid');
});

test('WX-DEADPID: LOCK 指向死 pid → 视为 stale，由本实例接管（错误实现：死 pid 也拒绝，服务僵死）', () => {
  const dir = freshDir();
  writeFileSync(join(dir, 'LOCK'), '99999999\n'); // 不可能存活的 pid
  const l = new StateLock(dir);
  assert.equal(l.acquire(), 'acquired');
  assert.notEqual(readFileSync(join(dir, 'LOCK'), 'utf8').trim(), '99999999');
  l.release();
});

test('WX-MALFORMED: LOCK 不是整数 → fail-closed 拒绝（错误实现：损坏 LOCK 当 fresh 强上）', () => {
  const dir = freshDir();
  writeFileSync(join(dir, 'LOCK'), 'not-a-pid\n');
  const l = new StateLock(dir);
  assert.equal(l.acquire(), 'refused-malformed-lock');
});

test('WX-RELEASE: release 后同目录可再次 acquire（错误实现：release 不清理）', () => {
  const dir = freshDir();
  const l1 = new StateLock(dir);
  l1.acquire();
  l1.release();
  const l2 = new StateLock(dir);
  assert.equal(l2.acquire(), 'acquired');
  l2.release();
});
