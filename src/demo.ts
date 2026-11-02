// Stage wiring: one fixture stream consumed verbatim by all four stages.
//   stage 1: serial inline baseline (router awaits the task itself)
//   stage 2: workers pool; intake never blocks on slow work
//   stage 3: + thread pass-through (followup appends, cancel lands)
//   stage 4: + file engine.db, boot recovery
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EngineDb } from './engine-db.js';
import { ChannelDb } from './channel-db.js';
import { StateLock } from './lock.js';
import { intake, recoverAtBoot, gracefulShutdown } from './engine.js';
import { runAssignment } from './runner.js';
import { processOneDueEffect } from './effects.js';
import { loadEvents } from './schema.js';
import type { RunOptions, TraceRecord } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runStage(opts: RunOptions): Promise<{ trace: TraceRecord[]; enginePath: string }> {
  const lock = new StateLock(opts.stateDir);
  if (lock.acquire() !== 'acquired') throw new Error(`state dir busy: ${opts.stateDir}`);

  const enginePath = opts.stage >= 4 ? join(opts.stateDir, 'engine.db') : ':memory:';
  const db = EngineDb.open(enginePath);
  const channel = ChannelDb.open(join(opts.stateDir, 'channel.db'), opts.channel);

  const trace: TraceRecord[] = [];
  let seq = 0;
  const start = Date.now();
  const hooks = {
    trace: (kind: string, payload: Record<string, unknown>) =>
      trace.push({ seq: ++seq, at: Date.now() - start, kind, ...payload }),
  };

  const rec = recoverAtBoot(db);
  hooks.trace('boot', { stage: opts.stage, crashed: rec.crashed, recovered: rec.recovered });

  const doc = loadEvents(opts.eventsPath);
  const passThrough = opts.stage >= 3;

  if (opts.stage === 1) {
    for (let i = 0; i < doc.events.length; i++) {
      const e = doc.events[i];
      const out = intake(db, e, passThrough);
      hooks.trace('intake', { eventId: `${e.threadId}:${e.at}:${e.type}:${e.taskId}`, result: out.result, note: out.note });
      // inline baseline: router drains effects AND runs the task itself, serially
      for (;;) {
        const did = await processOneDueEffect(db, channel, hooks);
        if (!did) break;
        const a = db.tx(() => db.claimQueuedAssignment());
        if (a) await runAssignment(db, a.id, a.taskId, hooks);
      }
    }
  } else {
    let stopped = false;
    const pool = Array.from({ length: opts.workers }, () =>
      (async () => {
        while (!stopped) {
          const a = db.tx(() => db.claimQueuedAssignment());
          if (!a) {
            await sleep(8);
            continue;
          }
          await runAssignment(db, a.id, a.taskId, hooks);
        }
      })(),
    );
    const effectsLoop = (async () => {
      while (!stopped) {
        const did = await processOneDueEffect(db, channel, hooks);
        if (!did) await sleep(8);
      }
    })();

    for (let i = 0; i < doc.events.length; i++) {
      const e = doc.events[i];
      // logical barrier: feed this event only after the target task committed step N,
      // so the append lands strictly between step1 commit and step2 snapshot.
      const holdAfter = process.env.MOCK_FEED_AFTER_TASK_STEP;
      if (holdAfter) {
        const h = holdAfter.split(':');
        if (h[0] === e.taskId) {
          const deadline = Date.now() + 3000;
          while (Date.now() < deadline) {
            const sd = db.tx(() => db.getTask(e.taskId)?.stepsDone ?? 0);
            if (sd >= Number(h[1])) break;
            await sleep(10);
          }
        }
      }
      // logical scheduling: a cancel lands on a LIVE task by waiting for it to leave
      // 'queued' (wall-clock never decides teaching semantics).
      if (e.type === 'cancel') {
        const deadline = Date.now() + 1000;
        while (Date.now() < deadline) {
          const st = db.tx(() => db.getTask(e.taskId)?.state);
          if (!st || st === 'running' || st === 'cancelling' || st === 'completed' || st === 'cancelled') break;
          await sleep(5);
        }
      }
      const out = intake(db, e, passThrough);
      hooks.trace('intake', { eventId: `${e.threadId}:${e.at}:${e.type}:${e.taskId}`, result: out.result, note: out.note });
      const delta = i + 1 < doc.events.length ? doc.events[i + 1].at - e.at : 5;
      if (delta > 0) await sleep(Math.min(delta, 20));
    }

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const q = db.tx(() => {
        const active = db.activeTasks().length;
        const due = db.dueEffects(1).length;
        return active === 0 && due === 0;
      });
      if (q) break;
      await sleep(15);
    }
    stopped = true;
    await Promise.all([...pool, effectsLoop]);
  }

  gracefulShutdown(db);
  db.close();
  channel.close();
  lock.release();

  if (opts.outPath) {
    writeFileSync(opts.outPath, trace.map((t) => JSON.stringify(t)).join('\n') + '\n');
  }
  for (const t of trace) console.log(JSON.stringify(t));
  return { trace, enginePath };
}

// Recovery demo: crash the first run at a breakpoint, restart on the SAME state dir.
export async function runRecovery(opts: {
  scenario: 'crash-step' | 'crash-send' | 'crash-claim';
  eventsPath: string;
  stateDir: string;
  outPath?: string;
}): Promise<void> {
  rmSync(opts.stateDir, { recursive: true, force: true });
  mkdirSync(opts.stateDir, { recursive: true });
  const runner = resolve('dist', 'cli.js');

  // crash-claim: dedicated fixture; crash after step2's tx#1 snapshot commits,
  // before tx#2 checkpoints it. Proves claim (read) is not durable, consume is.
  const events = opts.scenario === 'crash-claim' ? resolve('fixtures/recovery-checkpoint.json') : opts.eventsPath;
  const crashEnv =
    opts.scenario === 'crash-step'
      ? { MOCK_CRASH_AT_STEP: 'C:1' }
      : opts.scenario === 'crash-claim'
        ? {
            MOCK_FEED_AFTER_TASK_STEP: 'A:1',
            MOCK_CLAIM_WAIT_FOR_INPUT: 'A:2:in:t1:30:followup:A',
            MOCK_CRASH_AFTER_CLAIM: 'A:2',
          }
        : { MOCK_CRASH_AFTER_SEND: '1' };

  const first = spawnSync(process.execPath, [runner, 'run', '--stage', '4', '--events', events, '--state-dir', opts.stateDir], {
    env: { ...process.env, ...crashEnv },
    encoding: 'utf8',
  });
  console.log('--- first run (crashed) exit =', first.status, '---');
  console.log(first.stdout);
  console.error(first.stderr);

  const second = spawnSync(process.execPath, [runner, 'run', '--stage', '4', '--events', events, '--state-dir', opts.stateDir], {
    encoding: 'utf8',
  });
  console.log('--- second run (recovered) exit =', second.status, '---');
  console.log(second.stdout);
  console.error(second.stderr);

  if (opts.outPath) {
    writeFileSync(
      opts.outPath,
      `# scenario=${opts.scenario}\n# first exit=${first.status}\n# second exit=${second.status}\n` +
        `\n--- first run (crashed) stdout ---\n${first.stdout}\n--- second run (recovered) stdout ---\n${second.stdout}`,
    );
  }
}

export function doctor(stateDir: string): void {
  if (!existsSync(join(stateDir, 'engine.db'))) {
    console.log(JSON.stringify({ stateDir, engineDb: 'missing' }));
    return;
  }
  const db = EngineDb.open(join(stateDir, 'engine.db'));
  const summary = {
    stateDir,
    lastShutdown: db.getMeta('lastShutdown'),
    tasks: db
      .activeTasks()
      .map((t) => ({ taskId: t.taskId, state: t.state, steps: `${t.stepsDone}/${t.stepsTotal}` })),
    dueEffects: db.dueEffects(10).map((e) => ({ kind: e.kind, key: e.key, attempts: e.attempts })),
    writtenReceipts: db.allWrittenReceipts().map((r) => ({ receiptId: r.receiptId, conv: r.conversationId, attempts: r.attempts })),
  };
  db.close();
  console.log(JSON.stringify(summary, null, 2));
}
