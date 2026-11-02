// TaskRunner: in-process mock worker. Model call happens OUTSIDE transactions.
// Step protocol:
//   tx#1 read unconsumed inputs -> snapshot/claim (crash before tx#2 re-reads them)
//   await mockStep (outside tx; crash-injectable here)
//   tx#2 step checkpoint + consumed inputIds + (maybe) finish/cancel outcome
// Workdir is rebuildable output only; durable context lives in the steps table.
import type { EngineDb } from './engine-db.js';
import { enqueueReply } from './engine.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RunnerHooks {
  trace: (kind: string, payload: Record<string, unknown>) => void;
}

function crashAt(spec: string | undefined, taskId: string, stepN: number, where: string): void {
  if (!spec) return;
  const [tid, sn] = spec.split(':');
  if (tid === taskId && Number(sn) === stepN) {
    console.error(`[crash-inject] process.exit(13) at ${where} task=${taskId} step=${stepN}`);
    process.exit(13);
  }
}

async function mockStep(taskId: string, stepN: number, stepMs: number, inputCount: number): Promise<string> {
  await sleep(stepMs);
  return `${taskId} step#${stepN} done (consumed ${inputCount} inputs)`;
}

// Runs one assignment to its terminal boundary. Re-entrant across restarts:
// stepsDone and consumed inputs are durable; checkpoint rows are the context.
export async function runAssignment(
  db: EngineDb,
  assignmentId: number,
  taskId: string,
  hooks: RunnerHooks,
): Promise<'completed' | 'cancelled'> {
  let task = db.tx(() => {
    const t = db.getTask(taskId)!;
    if (t.state === 'cancelled' || t.state === 'completed' || t.state === 'failed') {
      // terminal before this assignment started: cancel won the race, just close out
      db.finishAssignment(assignmentId);
      return undefined;
    }
    if (t.state === 'queued') db.setTaskState(taskId, 'running');
    return db.getTask(taskId)!;
  });
  if (!task) return 'cancelled';

  hooks.trace('task.boot', { taskId, resumedFrom: task.stepsDone, recovery: task.stepsDone > 0 });

  for (;;) {
    // Cancel boundary: intent does not release the running slot; it terminates here.
    const cancelCheck = db.tx(() => {
      const t = db.getTask(taskId)!;
      if (t.state !== 'cancelling') return false;
      db.setTaskState(taskId, 'cancelled');
      db.finishAssignment(assignmentId);
      enqueueReply(db, taskId, t.threadId, `[cancelled] ${taskId}`);
      return true;
    });
    if (cancelCheck) {
      hooks.trace('task.terminal', { taskId, outcome: 'cancelled' });
      return 'cancelled';
    }

    // Deterministic barrier (teaching): wait until a specific input row exists before
    // the tx#1 snapshot, so the crash window is chosen by logic, not by wall-clock.
    const gate = process.env.MOCK_CLAIM_WAIT_FOR_INPUT;
    if (gate) {
      const g = gate.split(':');
      if (g[0] === taskId && Number(g[1]) === task.stepsDone + 1) {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const exists = db.tx(() => db.queuedInputs(taskId).some((i) => i.inputId === g[2]));
          if (exists) break;
          await sleep(10);
        }
      }
    }

    // tx#1: snapshot unconsumed inputs (claim). Crash AFTER this commits but BEFORE
    // tx#2: the claim itself is not durable; the input stays 'queued' and is re-read.
    const pending = db.tx(() => db.queuedInputs(taskId));
    crashAt(process.env.MOCK_CRASH_AFTER_CLAIM, taskId, task.stepsDone + 1, 'after-claim (tx#1 committed, tx#2 pending)');

    // Model call, outside any transaction.
    const nextStep = task.stepsDone + 1;
    crashAt(process.env.MOCK_CRASH_AT_STEP, taskId, nextStep, 'step start (before model call)');
    const result = await mockStep(taskId, nextStep, task.stepMs, pending.length);

    // tx#2: checkpoint + consume inputs. Finish/cancel decision commits here too;
    // whoever commits first (this or the cancel intake) wins; a late report sends no reply.
    const outcome = db.tx(() => {
      db.insertStep(taskId, nextStep, result);
      db.markInputsConsumed(pending.map((p) => p.inputId));
      db.setStepsDone(taskId, nextStep);
      const t = db.getTask(taskId)!;
      if (t.state === 'cancelling') {
        db.setTaskState(taskId, 'cancelled');
        db.finishAssignment(assignmentId);
        enqueueReply(db, taskId, t.threadId, `[cancelled] ${taskId}`);
        return 'cancelled' as const;
      }
      const stillQueued = db.queuedInputs(taskId).length;
      if (nextStep >= t.stepsTotal && stillQueued === 0) {
        db.setTaskState(taskId, 'completed');
        db.finishAssignment(assignmentId);
        enqueueReply(db, taskId, t.threadId, `[done] ${taskId} after ${nextStep} steps`);
        return 'completed' as const;
      }
      return 'continue' as const;
    });

    hooks.trace('task.step', { taskId, step: nextStep, consumedInputs: pending.map((p) => p.inputId) });
    task = db.getTask(taskId)!;

    if (outcome !== 'continue') {
      hooks.trace('task.terminal', { taskId, outcome });
      return outcome;
    }
    // Unconsumed appends were not dropped: the loop runs another step to consume them.
  }
}
