// External event stream validation. schema_v1: unknown keys are rejected on purpose.
import { readFileSync } from 'node:fs';
import type { ExternalDoc, ExternalEvent, ExternalType } from './types.js';

const EVENT_KEYS = new Set(['at', 'type', 'threadId', 'taskId', 'body', 'task']);
const TASK_KEYS = new Set(['steps', 'stepMs', 'spill']);
const TYPES = new Set<ExternalType>(['message', 'followup', 'cancel']);

function fail(msg: string): never {
  throw new Error(`schema_v1: ${msg}`);
}

function checkTask(e: ExternalEvent): void {
  if (e.type !== 'message') {
    if (e.task !== undefined) fail(`event at=${e.at}: only message may carry task`);
    return;
  }
  const t = e.task;
  if (!t) fail(`event at=${e.at}: message requires task`);
  for (const k of Object.keys(t as object)) {
    if (!TASK_KEYS.has(k)) fail(`event at=${e.at}: unknown task key "${k}"`);
  }
  if (!Number.isInteger(t.steps) || t.steps < 1) fail(`event at=${e.at}: task.steps must be integer >= 1`);
  if (!Number.isInteger(t.stepMs) || t.stepMs < 0) fail(`event at=${e.at}: task.stepMs must be integer >= 0`);
  if (typeof t.spill !== 'boolean') fail(`event at=${e.at}: task.spill must be boolean`);
}

export function loadEvents(path: string): ExternalDoc {
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
  const raw = JSON.parse(text) as unknown;
  if (typeof raw !== 'object' || raw === null) fail('root must be object');
  const doc = raw as Record<string, unknown>;
  if (doc.schema !== 'v1') fail(`unsupported schema "${String(doc.schema)}"`);
  const extra = Object.keys(doc).filter((k) => k !== 'schema' && k !== 'events');
  if (extra.length > 0) fail(`unknown root keys: ${extra.join(',')}`);
  if (!Array.isArray(doc.events)) fail('events must be array');

  const events: ExternalEvent[] = [];
  for (let i = 0; i < doc.events.length; i++) {
    const e = doc.events[i] as Record<string, unknown>;
    for (const k of Object.keys(e)) {
      if (!EVENT_KEYS.has(k)) fail(`events[${i}]: unknown key "${k}"`);
    }
    if (!Number.isInteger(e.at) || (e.at as number) < 0) fail(`events[${i}].at must be integer >= 0`);
    if (!TYPES.has(e.type as ExternalType)) fail(`events[${i}].type must be message|followup|cancel`);
    if (typeof e.threadId !== 'string' || e.threadId.length === 0) fail(`events[${i}].threadId must be non-empty string`);
    if (typeof e.taskId !== 'string' || e.taskId.length === 0) fail(`events[${i}].taskId must be non-empty string`);
    if (typeof e.body !== 'string') fail(`events[${i}].body must be string`);
    checkTask(e as unknown as ExternalEvent);
    events.push(e as unknown as ExternalEvent);
  }
  events.sort((a, b) => a.at - b.at);
  return { schema: 'v1', events };
}

export function eventIdOf(e: ExternalEvent): string {
  return `${e.threadId}:${e.at}:${e.type}:${e.taskId}`;
}
