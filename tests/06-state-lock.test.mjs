// 06-state-lock.test.mjs — 黑盒契约：stateDir/LOCK 单实例语义。
// 错误实现对照：活 pid 被覆盖 / 死 pid 不敢接管 / release 留僵尸文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { StateLock } from '../dist/lock.js';

function dir() {
  return mkdtempSync(join(tmpdir(), 'msa-lock-'));
}

test('LOCK-FRESH: 空目录 acquire → acquired，LOCK 写本进程 pid', () => {
  const d = dir();
  const l = new StateLock(d);
  assert.equal(l.acquire(), 'acquired');
  const held = JSON.parse(readFileSync(join(d, 'LOCK'), 'utf8'));
  assert.equal(held.pid, process.pid);
  l.release();
});

test('LOCK-LIVE-PID: LOCK 指向活进程 → refused-live-pid，不覆盖（错误实现：强接管活实例）', () => {
  const d = dir();
  writeFileSync(join(d, 'LOCK'), JSON.stringify({ pid: process.pid, startedAt: 0 }));
  const l = new StateLock(d);
  assert.equal(l.acquire(), 'refused-live-pid');
  // 原文件未被改写成本进程 pid
  assert.equal(JSON.parse(readFileSync(join(d, 'LOCK'), 'utf8')).pid, process.pid);
  l.release();
});

test('LOCK-DEAD-PID: LOCK 指向已退出进程 → stale，单一启动器接管并覆盖（错误实现：死 pid 拒绝启动）', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)']);
  const deadPid = child.pid;
  child.kill();
  await new Promise((res) => child.on('exit', res));
  const d = dir();
  writeFileSync(join(d, 'LOCK'), JSON.stringify({ pid: deadPid, startedAt: 0 }));
  const l = new StateLock(d);
  assert.equal(l.acquire(), 'acquired');
  assert.equal(JSON.parse(readFileSync(join(d, 'LOCK'), 'utf8')).pid, process.pid);
  l.release();
});

test('LOCK-MALFORMED: 损坏/截断 LOCK → refused-malformed-lock，fail-closed 不覆盖（错误实现：把坏锁当 stale 强接管）', () => {
  const d = dir();
  writeFileSync(join(d, 'LOCK'), '{{{ not json, truncated');
  const l = new StateLock(d);
  assert.equal(l.acquire(), 'refused-malformed-lock');
  // 原损坏内容未被改写
  assert.equal(readFileSync(join(d, 'LOCK'), 'utf8'), '{{{ not json, truncated');
  l.release();
});

test('LOCK-RELEASE: release 删除 LOCK，可重新 acquire（错误实现：release 留僵尸文件）', () => {
  const d = dir();
  const l = new StateLock(d);
  l.acquire();
  l.release();
  assert.equal(existsSync(join(d, 'LOCK')), false);
  assert.equal(l.acquire(), 'acquired');
  l.release();
});
