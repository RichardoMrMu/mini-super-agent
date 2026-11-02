// 07-cli.test.mjs — 黑盒 CLI 集成：子进程跑 dist/cli.js。
// 错误实现对照：崩溃后不恢复 / crash-send 窗口重发双份 / doctor 写状态 / stage 不产出 trace。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { EngineDb } from '../dist/engine-db.js';
import { ChannelDb } from '../dist/channel-db.js';
import { DatabaseSync } from 'node:sqlite';

function displayCounts(channelDbPath) {
  const probe = new DatabaseSync(channelDbPath);
  try {
    const ids = probe.prepare('SELECT DISTINCT messageId AS m FROM displays').all();
    return ids.map((r) => ({ messageId: r.m, count: probe.prepare('SELECT COUNT(*) AS c FROM displays WHERE messageId = ?').get(r.m).c }));
  } finally {
    probe.close();
  }
}

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'dist', 'cli.js');
const EVENTS = join(ROOT, 'fixtures', 'events.json');

function cli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'msa-cli-'));
}

test('CLI-STAGE1: run --stage 1 退出 0 且产出 boot/intake trace（错误实现：不写 trace）', () => {
  const dir = freshDir();
  const out = join(dir, 'trace.jsonl');
  const r = cli(['run', '--stage', '1', '--events', EVENTS, '--state-dir', dir, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const lines = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].kind, 'boot');
  assert.ok(lines.some((l) => l.kind === 'intake'));
});

test('CLI-RECOVERY-CRASH-STEP: recovery 子命令：first exit=13 崩溃 / second exit=0 恢复；A 取消保持，C 从 interrupted 重跑到 completed（错误实现：崩溃后不恢复/取消态复活）', () => {
  const dir = freshDir();
  const r = cli(['recovery', '--scenario', 'crash-step', '--state-dir', dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /first run \(crashed\) exit = 13/);
  assert.match(r.stdout, /second run \(recovered\) exit = 0/);
  assert.match(r.stdout, /"crashed":true/);
  const db = EngineDb.open(join(dir, 'engine.db'));
  assert.equal(db.getTask('A')?.state, 'cancelled');
  assert.equal(db.getTask('C')?.state, 'completed');
  db.close();
});

test('CLI-RECOVERY-CLAIM: crash 在 tx#1 snapshot/claim 提交后、tx#2 checkpoint 前 → 恢复后 step2 重读同一 claimed input 且只消耗一次（错误实现：claim 被误当 durable / 恢复后 input 丢失 / 纯 env gate 假装持久）', () => {
  const dir = freshDir();
  const r = cli(['recovery', '--scenario', 'crash-claim', '--state-dir', dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /first run \(crashed\) exit = 13/);
  assert.match(r.stdout, /second run \(recovered\) exit = 0/);
  const lines = r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l));
  const CLAIMED = 'in:t1:30:followup:A';
  // 恢复后 step2 重读同一 claimed input
  const step2 = lines.find((l) => l.kind === 'task.step' && l.taskId === 'A' && l.step === 2);
  assert.ok(step2, 'second run 应有 A step2 trace');
  assert.ok(
    Array.isArray(step2.consumedInputs) && step2.consumedInputs.includes(CLAIMED),
    `恢复后 step2 必须重读 ${CLAIMED}，实得 ${JSON.stringify(step2.consumedInputs)}`,
  );
  // 同一 input 全程只被消耗一次（不能因为崩溃重跑而消费两次）
  const consumedCount = lines.filter(
    (l) => l.kind === 'task.step' && Array.isArray(l.consumedInputs) && l.consumedInputs.includes(CLAIMED),
  ).length;
  assert.equal(consumedCount, 1, `${CLAIMED} 应只消耗一次，实被 ${consumedCount} 次 step trace 消费`);
  // 断点续跑：boot 从 step1 恢复，stepsDone 前进而非从头
  assert.ok(lines.some((l) => l.kind === 'task.boot' && l.taskId === 'A' && l.resumedFrom === 1));
  const db = EngineDb.open(join(dir, 'engine.db'));
  assert.equal(db.getTask('A')?.state, 'completed');
  assert.equal(db.getTask('A')?.stepsDone, 2);
  db.close();
});

test('CLI-CRASH-SEND-NAIVE: send 后 ack 前崩溃，naive 通道重发 = 同 messageId 双份（错误实现：窗口重发被压掉/不双发）', () => {
  const dir = freshDir();
  const first = cli(['run', '--stage', '4', '--events', EVENTS, '--state-dir', dir, '--channel', 'naive'], { MOCK_CRASH_AFTER_SEND: '1' });
  assert.equal(first.status, 13);
  const second = cli(['run', '--stage', '4', '--events', EVENTS, '--state-dir', dir, '--channel', 'naive']);
  assert.equal(second.status, 0, second.stderr);
  const ch = ChannelDb.open(join(dir, 'channel.db'), 'naive');
  const counts = displayCounts(join(dir, 'channel.db')).map((r) => r.count);
  assert.ok(counts.includes(2), `期望至少一个 messageId 双发，实际 counts=${JSON.stringify(counts)}`);
  ch.close();
});

test('CLI-CRASH-SEND-DEDUP: 同窗口，dedup 通道重发被压成 1 条（错误实现：dedup 仍双发）', () => {
  const dir = freshDir();
  const first = cli(['run', '--stage', '4', '--events', EVENTS, '--state-dir', dir, '--channel', 'dedup'], { MOCK_CRASH_AFTER_SEND: '1' });
  assert.equal(first.status, 13);
  const second = cli(['run', '--stage', '4', '--events', EVENTS, '--state-dir', dir, '--channel', 'dedup']);
  assert.equal(second.status, 0, second.stderr);
  const ch = ChannelDb.open(join(dir, 'channel.db'), 'dedup');
  const rows = displayCounts(join(dir, 'channel.db'));
  for (const r of rows) {
    assert.equal(r.count, 1, `messageId=${r.messageId} 应只展示一次`);
  }
  ch.close();
});

test('CLI-DOCTOR-RO: doctor 运行前后 engine.db 哈希不变（错误实现：doctor 修改状态文件）', () => {
  const dir = freshDir();
  cli(['run', '--stage', '4', '--events', EVENTS, '--state-dir', dir]);
  const before = createHash('sha256').update(readFileSync(join(dir, 'engine.db'))).digest('hex');
  const r = cli(['doctor', '--state-dir', dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /lastShutdown/);
  const after = createHash('sha256').update(readFileSync(join(dir, 'engine.db'))).digest('hex');
  assert.equal(before, after);
});
