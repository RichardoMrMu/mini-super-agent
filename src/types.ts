// Shared domain types. Minimal on purpose: this is a teaching repo, not a framework.

export type ExternalType = 'message' | 'followup' | 'cancel';

export interface ExternalTask {
  steps: number;
  stepMs: number;
  spill: boolean;
}

export interface ExternalEvent {
  at: number;
  type: ExternalType;
  threadId: string;
  taskId: string;
  body: string;
  task?: ExternalTask;
}

export interface ExternalDoc {
  schema: 'v1';
  events: ExternalEvent[];
}

export type TaskState =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type InputState = 'queued' | 'consumed' | 'filtered';
export type ReceiptState = 'written' | 'accepted' | 'dropped';
export type EffectState = 'due' | 'running' | 'done';

export interface TraceRecord {
  seq: number;
  at: number;
  kind: string;
  [k: string]: unknown;
}

export interface RunOptions {
  stage: 1 | 2 | 3 | 4;
  eventsPath: string;
  stateDir: string;
  workers: number;
  channel: 'naive' | 'dedup';
  outPath?: string;
}
