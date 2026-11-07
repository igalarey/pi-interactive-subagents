import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTestEnv, createExtensionDriver, shellEscape } from '../harness.ts';

const env = createTestEnv();
function skill(root: string, name: string, marker: string) {
  const dir = join(root, name); mkdirSync(dir, { recursive: true });
  const path = join(dir, 'SKILL.md');
  writeFileSync(path, `---\nname: ${name}\ndescription: Description for ${name}\n---\n${marker}\n`);
  return path;
}
const bootstrap = skill(join(env.agentDir, 'skills'), 'bootstrap', 'EXPLICIT_BOOTSTRAP_BODY');
const catalogRead = skill(join(env.agentDir, 'skills'), 'catalog-read', 'SELECTIVELY_READ_PROCEDURE');
const catalogIdle = skill(join(env.agentDir, 'skills'), 'catalog-idle', 'NEVER_EXPANDED_PROCEDURE');
skill(join(env.dir, '.pi', 'skills'), 'bootstrap', 'MALICIOUS_CWD_BODY');
skill(join(env.dir, '.pi', 'skills'), 'catalog-read', 'MALICIOUS_CWD_BODY');
skill(join(env.dir, '.pi', 'skills'), 'cwd-only', 'MALICIOUS_CWD_BODY');
const profile = join(env.agentDir, 'agents', 'selective.md');
writeFileSync(profile, '---\nname: selective\nmodel: skills-faux/local\ntools: read\nskills: bootstrap\nskill_catalog: catalog-read, catalog-idle\nallowed_subagents: none\nauto-exit: true\n---\nUse catalog procedures only when needed.');
const bin = join(env.root, 'bin'); mkdirSync(bin);
writeFileSync(join(bin, 'pi'), `#!/bin/bash\nexec ${shellEscape(process.execPath)} ${shellEscape(process.env.PI_TEST_CLI!)} "$@" -e ${shellEscape(resolve('test/integration/fixtures/faux-selective-skills.ts'))}\n`, { mode: 0o700 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.PI_TEST_PHASE = 'launch';
process.env.PI_TEST_SELECTIVE_READ = catalogRead;
const driver = await createExtensionDriver(env);
const capture = () => readFileSync(process.env.PI_TEST_CAPTURE!, 'utf8').trim().split('\n').map(line => JSON.parse(line));
const resultFor = (entry: any) => entry.message?.customType === 'subagent_result' && entry.message?.details?.name === 'selective';
const launch = (agent = 'selective') => driver.tool('subagent').execute('launch', { agent, name: 'selective', cwd: env.dir, task: 'INITIAL_SELECTIVE_TASK' }, undefined, undefined, driver.ctx);
const resume = () => driver.tool('subagent_message').execute('resume', { name: 'selective', message: 'RESUME_SELECTIVE_TASK' }, undefined, undefined, driver.ctx);
try {
  const first = await launch();
  assert.equal(first.details.status, 'started', JSON.stringify(first));
  const done = await driver.waitForMessage(resultFor, { timeout: 15000 });
  assert.equal(done.message.details.exitCode, 0, JSON.stringify(done));
  const initial = capture(); assert.equal(initial.length, 2);
  const context = JSON.stringify(initial[0].context);
  assert.match(context, /EXPLICIT_BOOTSTRAP_BODY/);
  assert.match(context, /INITIAL_SELECTIVE_TASK/);
  assert.match(context, /Description for catalog-read/);
  assert.ok(context.includes(catalogRead), 'catalog exposes the selected personal path');
  assert.doesNotMatch(context, /SELECTIVELY_READ_PROCEDURE|NEVER_EXPANDED_PROCEDURE|MALICIOUS_CWD_BODY/);
  assert.match(JSON.stringify(initial[1].context), /SELECTIVELY_READ_PROCEDURE/);
  assert.doesNotMatch(JSON.stringify(initial), /NEVER_EXPANDED_PROCEDURE|MALICIOUS_CWD_BODY|cwd-only/);
  assert.deepEqual(initial[0].skills.map((s: any) => s.name).sort(), ['skill:bootstrap', 'skill:catalog-idle', 'skill:catalog-read']);
  const snapshotFile = `${first.details.sessionFile}.loadout.json`;
  const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'));
  assert.deepEqual(snapshot.skillPaths, [bootstrap]);
  assert.deepEqual(snapshot.skillCatalogPaths, [catalogRead, catalogIdle]);
  writeFileSync(profile, '---\nname: selective\ntools: read, write\nskills: cwd-only\nskill_catalog: nonexistent\n---\nChanged profile must not affect resume');
  process.env.PI_TEST_PHASE = 'resume';
  const offset = driver.sentMessages.length;
  const resumed = await resume(); assert.equal(resumed.details.status, 'started', JSON.stringify(resumed));
  const resumedDone = await driver.waitForMessage(resultFor, { from: offset, timeout: 15000 });
  assert.equal(resumedDone.message.details.exitCode, 0, JSON.stringify(resumedDone));
  const captures = capture(); assert.equal(captures.length, 3);
  assert.deepEqual(captures[2].skills, initial[0].skills);
  assert.deepEqual(captures[2].tools, initial[0].tools);
  assert.match(JSON.stringify(captures[2].context), /RESUME_SELECTIVE_TASK/);
  assert.doesNotMatch(JSON.stringify(captures[2].context), /NEVER_EXPANDED_PROCEDURE|MALICIOUS_CWD_BODY|cwd-only/);
  for (const script of [first.details.launchScriptFile, resumed.details.launchScriptFile]) {
    const text = readFileSync(script, 'utf8');
    assert.match(text, /--no-skills/); assert.match(text, /--skill/); assert.doesNotMatch(text, /--mode\s+rpc/);
    for (const path of [bootstrap, catalogRead, catalogIdle]) assert.ok(text.includes(path));
  }
  const modes = readFileSync(process.env.PI_TEST_MODES!, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(modes, Array(2).fill({ mode: 'tui', stdin: true, stdout: true }));
  unlinkSync(catalogIdle);
  await assert.rejects(resume(), /skill.*missing/i);
  assert.equal(capture().length, 3, 'missing saved catalog selection never reaches provider');
  writeFileSync(profile, '---\nname: selective\ntools: read\nskill_catalog: catalog-idle\n---\nMissing personal skill');
  await assert.rejects(launch(), /skill.*not found/i);
  assert.equal(capture().length, 3);
  writeFileSync(catalogIdle, '---\nname: catalog-idle\ndescription: Hidden catalog\ndisable-model-invocation: true\n---\nHidden procedure');
  await assert.rejects(launch(), /catalog.*disable-model-invocation/i);
  assert.equal(capture().length, 3);
  const { __test__ } = await import('../../../pi-extension/subagents/index.ts');
  for (const declaration of ['skills: false\nskill_catalog: bootstrap', 'skill_catalog: bootstrap\nskill_catalog: catalog-read']) {
    writeFileSync(profile, `---\nname: selective\n${declaration}\n---\nInvalid`);
    assert.throws(() => __test__.loadAgentDefaults('selective'), /Conflicting|Duplicate/);
  }
} finally { await driver.stop(); }
