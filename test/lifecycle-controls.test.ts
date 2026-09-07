import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import doneExtension from '../pi-extension/subagents/subagent-done.ts';
import subagentsExtension from '../pi-extension/subagents/index.ts';
import { cancelOwnedSubagent } from '../pi-extension/subagents/cancellation.ts';
import { descendantProcessIds } from '../pi-extension/subagents/surface.ts';
import { readSubagentActivityFile } from '../pi-extension/subagents/activity.ts';
import { createStatusState, observeStatus, classifyStatus, formatStatusLine } from '../pi-extension/subagents/status.ts';

function setup(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-wait-reason-'));
  const saved = { ...process.env };
  const countKey = Symbol.for('pi-subagents/running-children-count');
  const namesKey = Symbol.for('pi-subagents/running-children-names');
  const savedCount = (globalThis as any)[countKey];
  const savedNames = (globalThis as any)[namesKey];
  for (const key of Object.keys(process.env)) if (key.startsWith('PI_SUBAGENT_')) delete process.env[key];
  process.env.PI_SUBAGENT_AUTO_EXIT = '1';
  process.env.PI_SUBAGENT_ID = 'fixture';
  process.env.PI_SUBAGENT_ACTIVITY_FILE = path.join(dir, 'activity.json');
  const events = new Map<string, Function>();
  doneExtension({ on: (name: string, handler: Function) => events.set(name, handler), registerTool() {}, registerShortcut() {} } as any);
  let shutdowns = 0;
  const ctx = { shutdown() { shutdowns++; } };
  t.after(() => {
    events.get('session_shutdown')!({ reason: 'quit' }, ctx);
    for (const key of Object.keys(process.env)) if (key.startsWith('PI_SUBAGENT_')) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) if (key.startsWith('PI_SUBAGENT_') && value !== undefined) process.env[key] = value;
    (globalThis as any)[countKey] = savedCount;
    (globalThis as any)[namesKey] = savedNames;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { events, ctx, shutdowns: () => shutdowns, countKey, namesKey,
    activity: () => readSubagentActivityFile(path.join(dir, 'activity.json'), 'fixture') };
}

test('normal handoffs wait for named children, expose the reason, then close when drained', t => {
  const f = setup(t);
  let children = 1;
  (globalThis as any)[f.countKey] = () => children;
  (globalThis as any)[f.namesKey] = () => ['bootstrap-recon'];
  for (let i = 0; i < 3; i++) {
    f.events.get('agent_end')!({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, f.ctx);
    f.events.get('agent_settled')!({}, f.ctx);
  }
  assert.equal(f.shutdowns(), 0);
  const read = f.activity();
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.activity.phase, 'waiting');
  assert.match((read.activity as any).waitingReason, /children.*bootstrap-recon/);
  children = 0;
  f.events.get('agent_settled')!({}, f.ctx);
  assert.equal(f.shutdowns(), 1);
});

test('settled event after shutdown does not use an invalidated context', t => {
  const f = setup(t);
  (globalThis as any)[f.countKey] = () => 0;
  f.events.get('agent_end')!({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, f.ctx);
  f.events.get('session_shutdown')!({ reason: 'quit' }, f.ctx);
  assert.doesNotThrow(() => f.events.get('agent_settled')!({}, { shutdown() { throw new Error('stale context'); } }));
});

test('cancellation is available as a tool and a slash command without resuming unknown names', async () => {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  subagentsExtension({ on() {}, registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerShortcut() {}, registerMessageRenderer() {} } as any);
  assert.ok(tools.has('subagent_cancel'));
  assert.ok(commands.has('subagent-cancel'));
  await assert.rejects(tools.get('subagent_cancel').execute('fixture', { name: 'unknown' }), /No running subagent/);
});

test('cancellation targets one exact owned name and leaves siblings untouched', () => {
  const first = { name: 'worker', surface: 'process:1', abortController: new AbortController() };
  const second = { name: 'worker-other', surface: 'process:2', abortController: new AbortController() };
  const closed: string[] = [];
  assert.throws(() => cancelOwnedSubagent('work', [first, second], s => closed.push(s)), /No running subagent/);
  assert.deepEqual(closed, []);
  cancelOwnedSubagent('worker', [first, second], s => closed.push(s));
  assert.deepEqual(closed, ['process:1']);
  assert.equal(first.abortController.signal.aborted, true);
  assert.equal(second.abortController.signal.aborted, false);
  assert.throws(() => cancelOwnedSubagent('worker-other', [second], () => { throw new Error('kill failed'); }), /kill failed/);
  assert.equal(second.abortController.signal.aborted, false);
});

test('descendant selection is leaf-first, cycle-safe, and excludes unrelated processes', () => {
  const table = '1 0\n10 1\n20 10\n30 20\n40 1\n50 40\n10 30\ninvalid row';
  assert.deepEqual(descendantProcessIds(10, table), [30, 20]);
});

test('waiting status renders its reason rather than a generic idle label', () => {
  const state = observeStatus(createStatusState({ source: 'pi', startTimeMs: 0 }), {
    snapshot: 'present', updatedAt: 100, sequence: 1, phase: 'waiting', waitingSince: 100,
    activityLabel: 'children (1): bootstrap-recon',
  }, 100);
  assert.match(formatStatusLine('worker', classifyStatus(state, 200)), /children.*bootstrap-recon/);
});
