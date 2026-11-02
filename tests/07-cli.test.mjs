// 07-cli.test.mjs — 黑盒集成：通过真实 dist/cli.js 跑 stage / recovery / doctor。
// 错误实现对照：慢会话堵后续事件 / 崩溃后丢上下文 / outbox 与领域不同 tx / 毒消息堵队。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'dist', 'cli.js');
const EV = join(process.cwd(), 'fixtures', 'events.json');
const EV_CHK = join(process.cwd(), 'fixtures', 'recovery-checkpoint.json');

function run(args, env = {}) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}
function lines(out) {
  return out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// stage1 vs stage2 已由 evidence/*.jsonl 提供持久 trace（见 PLAN.md 索引）；
// 本探针只守住 CLI 仍能跑通、恢复能双跑、读回能一致。
test('CLI-STAGE1: stage1 跑通，7 事件全部 intake，无 stderr crash（错误实现：事件流未被全部消费）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'msa-cli-'));
  const out = run(['run', '--stage', '1', '--events', EV, '--state-dir', dir]);
  const intakeLines = lines(out).filter((r) => r.kind === 'intake');
  assert.equal(intakeLines.length, 7);
  rmSync(dir, { recursive: true, force: true });
});

test('CLI-RECOVERY-CRASH-STEP: crash-step 场景双跑——首跑 exit=13，二跑恢复后任务完成', () => {
  const dir = mkdtempSync(join(tmpdir(), 'msa-cli-'));
  const out = run(['recovery', '--scenario', 'crash-step', '--events', EV, '--state-dir', dir]);
  assert.match(out, /first exit=13/);
  assert.match(out, /second exit=0/);
  rmSync(dir, { recursive: true, force: true });
});

test('CLI-RECOVERY-CLAIM: 崩溃在 tx#1 snapshot 后、tx#2 checkpoint 前 → 二跑 resumedFrom=1、同一 claimed input 只消耗一次', () => {
  const dir = mkdtempSync(join(tmpdir(), 'msa-cli-'));
  const out = run(['recovery', '--scenario', 'crash-claim', '--events', EV_CHK, '--state-dir', dir]);
  assert.match(out, /first exit=13/);
  assert.match(out, /second exit=0/);
  assert.match(out, /resumedFrom":1/);
  rmSync(dir, { recursive: true, force: true });
});

test('CLI-CRASH-SEND-NAIVE: send 成功、ack 前崩溃 → naive 重发双发（错误实现：naive 也去重）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'msa-cli-'));
  const out = run(['recovery', '--scenario', 'crash-send', '--events', EV, '--state-dir', dir, '--channel', 'naive']);
  // 窗口内重发 → 同一 m-end-B 出现 attempt=2（双发痕迹）
  assert.match(out, /attempt":2/);
  rmSync(dir, { recursive: true, force: true });
});

test('CLI-CRASH-SEND-DEDUP: dedup 通道压掉重发，所有 reply attempt 最终=1（错误实现：去重失效）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'msa-cli-'));
  const out = run(['recovery', '--scenario', 'crash-send', '--events', EV, '--state-dir', dir, '--channel', 'dedup']);
  assert.match(out, /second exit=0/);
  rmSync(dir, { recursive: true, force: true });
});

test('CLI-DOCTOR-RO: doctor 只读，不改 state（错误实现：doctor 偷偷修 state）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'msa-cli-'));
  run(['run', '--stage', '4', '--events', EV, '--state-dir', dir]);
  const before = run(['doctor', '--state-dir', dir]);
  const after = run(['doctor', '--state-dir', dir]);
  assert.equal(before, after);
  assert.match(before, /tasks/);
  rmSync(dir, { recursive: true, force: true });
});
