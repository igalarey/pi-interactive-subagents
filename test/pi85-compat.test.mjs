import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';
import { __test__ as subagentsTestApi } from '../pi-extension/subagents/index.ts';
import { resolveBackgroundBash } from '../pi-extension/subagents/surface.ts';

const root = path.resolve(import.meta.dirname, '..');
const cases = [
  {
    file: 'pi-extension/subagents/index.ts',
    tools: ['implementation_route', 'subagent', 'subagent_message', 'subagents_list'],
  },
  {
    file: 'pi-extension/subagents/subagent-done.ts',
    tools: ['ask_question'],
  },
  {
    file: 'pi-extension/subagents/tools/safe-bash.ts',
    tools: ['safe_bash'],
  },
];

test('Windows background launches select Git Bash over the system placeholder', () => {
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const systemBash = 'C:\\Windows\\System32\\bash.exe';
  const existing = new Set([gitBash, systemBash]);

  assert.equal(resolveBackgroundBash({
    platform: 'win32',
    env: { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows' },
    exists: candidate => existing.has(candidate),
    pathMatches: [systemBash],
  }), gitBash);
});

test('absolute Windows subagent cwd is not joined to the parent cwd', () => {
  const cwd = 'C:\\fixtures\\agent-config';
  assert.equal(subagentsTestApi.resolveRequestedCwd(cwd, 'C:\\other'), cwd);
});

test('Pi 0.85 loads every extension entry point and registers its tools', async (t) => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagents-compat-'));
  t.after(() => fs.rmSync(emptyDir, { recursive: true, force: true }));

  const loaded = new Map();
  for (const expected of cases) {
    const result = await discoverAndLoadExtensions(
      [path.join(root, expected.file)],
      emptyDir,
      emptyDir,
    );
    assert.deepEqual(result.errors, [], expected.file);
    assert.equal(result.extensions.length, 1, expected.file);
    assert.deepEqual([...result.extensions[0].tools.keys()].sort(), expected.tools.sort());
    loaded.set(expected.file, result.extensions[0]);
  }

  const safeBash = loaded.get('pi-extension/subagents/tools/safe-bash.ts').tools.get('safe_bash').definition;
  await assert.rejects(
    safeBash.execute('blocked', { command: 'sudo whoami' }, undefined, undefined, undefined),
    /Command blocked by safe_bash/,
  );
  const harmless = await safeBash.execute(
    'harmless',
    { command: 'printf pi85-safe-bash-ok' },
    undefined,
    undefined,
    undefined,
  );
  assert.equal(harmless.content.find(part => part.type === 'text')?.text, 'pi85-safe-bash-ok');
});
