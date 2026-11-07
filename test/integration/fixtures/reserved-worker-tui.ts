import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTestEnv, createExtensionDriver, shellEscape } from '../harness.ts';

const env = createTestEnv();
const native = 'openai/gpt-6-astra', legacy = 'openai-codex/gpt-6-astra';
writeFileSync(join(env.agentDir, 'agents', 'worker.md'), `---\nname: worker\nmodel: ${native}\nthinking: xhigh\ntools: read\nskills: false\nallowed_subagents: none\nauto-exit: true\n---\nOffline guard fixture`);
const requestedModels = join(env.root, 'requested-models');
const bin = join(env.root, 'bin'); mkdirSync(bin);
writeFileSync(join(bin, 'pi'), `#!/bin/bash\nargs=()\nwhile (( $# )); do\n  if [[ "$1" == --model ]]; then\n    printf '%s\\n' "$2" >> ${shellEscape(requestedModels)}\n    args+=(--model skills-faux/local)\n    shift 2\n  else\n    args+=("$1")\n    shift\n  fi\ndone\nexec ${shellEscape(process.execPath)} ${shellEscape(process.env.PI_TEST_CLI!)} "\${args[@]}" -e ${shellEscape(resolve('test/integration/fixtures/faux-selective-skills.ts'))}\n`, { mode: 0o700 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.PI_TEST_PHASE = 'guard';
const driver = await createExtensionDriver(env);
const launch = (options: object) => driver.tool('subagent').execute('guard', { agent: 'worker', name: 'guarded-worker', task: 'Offline confirmation regression', ...options }, undefined, undefined, driver.ctx);
const resume = () => driver.tool('subagent_message').execute('guard-resume', { name: 'guarded-worker', message: 'Offline guarded resume', resume_only: true }, undefined, undefined, driver.ctx);
const resultFor = (entry: any) => entry.message?.customType === 'subagent_result' && entry.message?.details?.name === 'guarded-worker';
const models = () => existsSync(requestedModels) ? readFileSync(requestedModels, 'utf8').trim().split('\n') : [];
let confirmationModel = native;
let confirmations = 0;
let approve = false;
driver.ctx.ui.confirm = async (title: string, message: string) => {
  confirmations++;
  assert.match(title, /Astra xhigh/);
  assert.ok(message.includes(confirmationModel), 'confirmation must name the model that will actually run');
  return approve;
};
try {
  for (const options of [{ model: native }, { model: legacy }, { model: `${native}:high` }, { useAstraXhigh: true }, {}]) {
    driver.ctx.hasUI = false;
    const withoutUI = await launch(options);
    assert.equal(withoutUI.details.error, 'reserved model not approved', JSON.stringify(withoutUI));
    assert.match(JSON.stringify(withoutUI), /interactive UI/);
    const before = confirmations;
    driver.ctx.hasUI = true;
    const denied = await launch(options);
    assert.equal(denied.details.error, 'reserved model not approved');
    assert.equal(confirmations, before + 1);
    assert.deepEqual(models(), [], 'refusal must precede any child process');
  }
  approve = true;
  const first = await launch({ useAstraXhigh: true });
  assert.equal(first.details.status, 'started', JSON.stringify(first));
  await driver.waitForMessage(resultFor, { timeout: 15000 });
  const sidecar = `${first.details.sessionFile}.loadout.json`;
  const original = JSON.parse(readFileSync(sidecar, 'utf8'));
  assert.equal(original.model, native); assert.equal(original.thinking, 'xhigh');
  assert.deepEqual(models(), [`${native}:xhigh`]);
  for (const model of [native, legacy]) {
    confirmationModel = model;
    const snapshot = { ...original, model }; writeFileSync(sidecar, JSON.stringify(snapshot));
    const beforeModels = models();
    approve = false; driver.ctx.hasUI = false;
    assert.equal((await resume()).details.error, 'reserved model not approved');
    const before = confirmations; driver.ctx.hasUI = true;
    assert.equal((await resume()).details.error, 'reserved model not approved');
    assert.equal(confirmations, before + 1); assert.deepEqual(models(), beforeModels);
    approve = true;
    const offset = driver.sentMessages.length;
    const resumed = await resume(); assert.equal(resumed.details.status, 'started', JSON.stringify(resumed));
    assert.equal(confirmations, before + 2);
    await driver.waitForMessage(resultFor, { from: offset, timeout: 15000 });
    assert.equal(models().at(-1), `${model}:xhigh`);
    assert.deepEqual(JSON.parse(readFileSync(sidecar, 'utf8')), snapshot, 'historical model IDs must not be silently rewritten');
  }
  assert.deepEqual(models(), [`${native}:xhigh`, `${native}:xhigh`, `${legacy}:xhigh`]);
  const modes = readFileSync(process.env.PI_TEST_MODES!, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(modes.length, 3); assert.ok(modes.every(mode => mode.mode === 'tui' && mode.stdin && mode.stdout));
} finally { await driver.stop(); }
