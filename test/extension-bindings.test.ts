import './isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { __test__, registerToolExtension } from '../pi-extension/subagents/index.ts';
import { readSubagentLoadout, writeSubagentLoadout, type SubagentLoadout } from '../pi-extension/subagents/session.ts';

const base: SubagentLoadout = { agent: 'coordinator', toolAllowlist: 'read,own_tool,subagent,ask_question', model: null, thinking: null, systemPromptMode: null, identity: null, spawnable: ['specialist'], autoExit: true, cwd: homedir(), agentDir: process.env.PI_CODING_AGENT_DIR! };
test('explicit binding snapshot validates bounded scopes and pins own paths without loading descendant providers', () => {
  const old = join(homedir(), 'old.ts'), ambient = join(homedir(), 'ambient.ts'), descendant = join(homedir(), 'descendant.ts');
  for (const file of [old, ambient, descendant]) writeFileSync(file, 'export default function () {}');
  registerToolExtension('own_tool', ambient);
  const snapshot = { ...base, extensionBindings: { own_tool: old, specialist_tool: descendant }, extensionBindingProfiles: { specialist: { toolAllowlist: 'read,specialist_tool,ask_question', spawnable: [] } } };
  const session = join(homedir(), 'bindings.jsonl');
  writeSubagentLoadout(session, snapshot);
  assert.deepEqual(readSubagentLoadout(session), snapshot);
  const parts: string[] = []; __test__.applySandboxToParts(parts, snapshot, { artifactDir: homedir(), name: 'pinned' });
  assert.ok(parts.includes(`'${old}'`)); assert.ok(!parts.includes(`'${ambient}'`)); assert.ok(!parts.includes(`'${descendant}'`));
  for (const change of [
    { extensionBindings: {} }, { extensionBindingProfiles: {} },
    { extensionBindings: { ...snapshot.extensionBindings, read: old } },
    { extensionBindings: { ...snapshot.extensionBindings, subagent: old } },
    { extensionBindings: { ...snapshot.extensionBindings, ask_question: old } },
    { extensionBindings: { ...snapshot.extensionBindings, unrelated: old } },
    { extensionBindings: { ...snapshot.extensionBindings, own_tool: './relative.ts' } },
    { extensionBindings: { ...snapshot.extensionBindings, 'bad tool': old } },
    { extensionBindingProfiles: { specialist: { toolAllowlist: null, spawnable: [] } } },
    { extensionBindingProfiles: { specialist: { toolAllowlist: 'specialist_tool', spawnable: ['unknown'] } } },
    { extensionBindings: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`tool${i}`, old])) },
  ]) {
    writeFileSync(`${session}.loadout.json`, JSON.stringify({ ...snapshot, ...change }));
    assert.equal(readSubagentLoadout(session), null, JSON.stringify(change).slice(0, 100));
  }
  const empty = { ...base, toolAllowlist: 'read', spawnable: [], extensionBindings: {}, extensionBindingProfiles: {} };
  writeSubagentLoadout(session, empty); assert.deepEqual(readSubagentLoadout(session), empty);
  writeSubagentLoadout(session, base); assert.deepEqual(readSubagentLoadout(session), base, 'legacy fields stay absent');
  unlinkSync(old);
  assert.throws(() => __test__.applySandboxToParts([], snapshot, { artifactDir: homedir(), name: 'missing' }), /binding.*missing|backing.*file/i);
});

test('restore requires actual child session, saved identity/config and active lineage ownership; explicit empty never falls back', async () => {
  const { ensureLineageLedger, reserveLineageLaunch, releaseLineageLaunch } = await import('../pi-extension/subagents/lineage.ts');
  const session = join(homedir(), 'child.jsonl'), file = join(homedir(), 'lineage.json');
  writeFileSync(session, '');
  writeFileSync(join(homedir(), 'unrelated-root.jsonl'), '');
  const snapshot = { ...base, toolAllowlist: 'read', spawnable: [], extensionBindings: {}, extensionBindingProfiles: {} };
  writeSubagentLoadout(session, snapshot);
  await ensureLineageLedger(file, 'root', { maxDepth: 2, maxConcurrentDescendants: 6, maxConcurrentChildren: 2, maxLaunchesPerLineage: null }, { allowLimitUpdate: true });
  const lease = await reserveLineageLaunch(file, { id: 'child', parentId: null, name: 'child', agent: 'coordinator', depth: 1, sessionFile: session, activityFile: join(homedir(), 'subagent-activity', 'child.json'), ownerPid: process.pid, task: 'test', kind: 'launch' });
  const ambient = join(homedir(), 'ambient-restore.ts');
  writeFileSync(ambient, 'export default function () {}');
  registerToolExtension('ambient_only', ambient);
  const saved = { ...process.env };
  const ctx = (file = session) => ({ sessionManager: { getSessionFile: () => file } });
  try {
    Object.assign(process.env, { PI_SUBAGENT_SESSION: session, PI_SUBAGENT_AGENT: 'coordinator', PI_SUBAGENT_ID: 'child', PI_SUBAGENT_DEPTH: '1', PI_SUBAGENT_LINEAGE_ID: 'root', PI_SUBAGENT_LINEAGE_FILE: file });
    assert.throws(() => __test__.restoreExtensionBindings(ctx(join(homedir(), 'unrelated-root.jsonl'))), /session/i);
    process.env.PI_SUBAGENT_AGENT = 'forged'; assert.throws(() => __test__.restoreExtensionBindings(ctx()), /identity|agent/i);
    process.env.PI_SUBAGENT_AGENT = 'coordinator';
    process.env.PI_CODING_AGENT_DIR = homedir(); assert.throws(() => __test__.restoreExtensionBindings(ctx()), /directory|config/i);
    process.env.PI_CODING_AGENT_DIR = snapshot.agentDir!;
    __test__.restoreExtensionBindings(ctx());
    assert.equal(__test__.getToolExtensionPath('ambient_only'), undefined, 'explicit empty scope hides ambient registration');
    assert.throws(() => registerToolExtension('new_tool', join(homedir(), 'new.ts')), /binding|scope/i);
    await releaseLineageLaunch(file, lease.id, lease.token);
    assert.throws(() => __test__.restoreExtensionBindings(ctx()), /lineage|active/i);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    __test__.restoreExtensionBindings({ sessionManager: { getSessionFile: () => join(homedir(), 'root.jsonl') } });
  }
});

test('shared registry advertises frozen verified runtime capabilities without another entrypoint', () => {
  const registry = (globalThis as any)[Symbol.for('pi.subagents.tool-extension-registry')];
  assert.equal(typeof registry.registerToolExtension, 'function');
  assert.deepEqual(registry.capabilities, { version: 1, personalSkillCatalog: true, perParentChildLimit: true, persistedExtensionBindings: true, scopedExtensionProfiles: true });
  assert.ok(Object.isFrozen(registry.capabilities));
  assert.ok(Object.isFrozen(registry));
});

test('scoped snapshots require explicit nonempty scope and binding maps, never legacy fallback', () => {
  const session = join(homedir(), 'scoped.jsonl');
  const scoped = { ...base, toolAllowlist: 'read', spawnable: [], extensionPolicy: 'scoped', extensionBindings: {}, extensionBindingProfiles: {} };
  writeFileSync(`${session}.loadout.json`, JSON.stringify(scoped));
  assert.deepEqual(readSubagentLoadout(session), scoped);
  for (const mutation of [
    { extensionBindings: undefined }, { extensionBindingProfiles: undefined },
    { extensionBindings: undefined, extensionBindingProfiles: undefined },
    { toolAllowlist: null }, { toolAllowlist: '' }, { extensionPolicy: 'ambient' },
  ]) {
    const malformed = { ...scoped, ...mutation };
    writeFileSync(`${session}.loadout.json`, JSON.stringify(malformed));
    assert.equal(readSubagentLoadout(session), null);
    assert.throws(() => __test__.applySandboxToParts([], malformed as any, { artifactDir: homedir(), name: 'scoped' }), /scoped|binding/i);
  }
});
