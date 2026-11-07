import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTestEnv, createExtensionDriver, shellEscape } from '../harness.ts';

const env = createTestEnv();
const loaded = join(env.root, 'loaded');
function backing(name: string) {
  const path = join(env.root, `${name}.ts`);
  writeFileSync(path, `import { appendFileSync } from 'node:fs'; export default function(pi) { appendFileSync(${JSON.stringify(loaded)}, ${JSON.stringify(name + '\n')}); pi.registerTool({name:${JSON.stringify(name)},label:'Fixture',description:'Scoped fixture',parameters:{type:'object',properties:{}},async execute(){return {content:[{type:'text',text:'approved'}],details:{}};}}); }`);
  return path;
}
const permitted = backing('scoped_tool'), unselected = backing('unselected_tool');
const skillDir = join(env.agentDir, 'skills', 'catalog'); mkdirSync(skillDir, { recursive: true });
const skill = join(skillDir, 'SKILL.md');
writeFileSync(skill, '---\nname: catalog\ndescription: Scoped catalog description\n---\nSCOPED_CATALOG_PROCEDURE');
const badDir = join(env.dir, '.pi', 'skills', 'cwd-only'); mkdirSync(badDir, { recursive: true });
writeFileSync(join(badDir, 'SKILL.md'), '---\nname: cwd-only\ndescription: MALICIOUS_CWD_DESCRIPTION\n---\nMALICIOUS_CWD_BODY');
mkdirSync(join(env.agentDir, 'extensions'), { recursive: true });
writeFileSync(join(env.agentDir, 'extensions', 'ambient.ts'), `export default function(){throw new Error('NO_AMBIENT_EXTENSIONS');}`);
const profileFile = join(env.agentDir, 'agents', 'scoped.md');
const profile = (tools: string) => `---\nname: scoped\nmodel: skills-faux/local\nextensions: scoped\n${tools}\nskill_catalog: catalog\nallowed_subagents: none\nauto-exit: true\n---\nScoped fixture`;
writeFileSync(profileFile, profile('tools: read, scoped_tool'));
const bin = join(env.root, 'bin'); mkdirSync(bin);
writeFileSync(join(bin, 'pi'), `#!/bin/bash\nexec ${shellEscape(process.execPath)} ${shellEscape(process.env.PI_TEST_CLI!)} "$@" -e ${shellEscape(resolve('test/integration/fixtures/faux-selective-skills.ts'))}\n`, { mode: 0o700 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.PI_TEST_PHASE = 'launch'; process.env.PI_TEST_SELECTIVE_READ = skill;
const driver = await createExtensionDriver(env);
const module = await import('../../../pi-extension/subagents/index.ts');
module.registerToolExtension('scoped_tool', permitted); module.registerToolExtension('unselected_tool', unselected);
const captures = () => readFileSync(process.env.PI_TEST_CAPTURE!, 'utf8').trim().split('\n').map(line => JSON.parse(line));
const launch = () => driver.tool('subagent').execute('scoped', { agent: 'scoped', name: 'scoped', task: 'Selectively read the catalog.' }, undefined, undefined, driver.ctx);
const resume = () => driver.tool('subagent_message').execute('scoped-resume', { name: 'scoped', message: 'Resume saved scope.', resume_only: true }, undefined, undefined, driver.ctx);
const resultFor = (entry: any) => entry.message?.customType === 'subagent_result' && entry.message?.details?.name === 'scoped';
try {
  const first = await launch(); assert.equal(first.details.status, 'started', JSON.stringify(first));
  await driver.waitForMessage(resultFor, { timeout: 15000 });
  const rows = captures(); assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].tools.sort(), ['ask_question', 'read', 'scoped_tool']);
  assert.match(JSON.stringify(rows[0].context), /Scoped catalog description/);
  assert.doesNotMatch(JSON.stringify(rows[0].context), /SCOPED_CATALOG_PROCEDURE|MALICIOUS_CWD/);
  assert.match(JSON.stringify(rows[1].context), /SCOPED_CATALOG_PROCEDURE/);
  assert.deepEqual(rows[0].skills.map((s: any) => s.name), ['skill:catalog']);
  const sidecar = `${first.details.sessionFile}.loadout.json`;
  const snapshot = JSON.parse(readFileSync(sidecar, 'utf8'));
  assert.equal(snapshot.extensionPolicy, 'scoped');
  assert.deepEqual(snapshot.extensionBindings, { scoped_tool: permitted });
  assert.deepEqual(snapshot.skillCatalogPaths, [skill]);
  writeFileSync(profileFile, profile('tools: read, unselected_tool').replace('extensions: scoped', 'extensions: true'));
  process.env.PI_TEST_PHASE = 'resume'; const offset = driver.sentMessages.length;
  const resumed = await resume(); assert.equal(resumed.details.status, 'started', JSON.stringify(resumed));
  await driver.waitForMessage(resultFor, { from: offset, timeout: 15000 });
  assert.deepEqual(captures()[2].tools.sort(), ['ask_question', 'read', 'scoped_tool']);
  assert.deepEqual(JSON.parse(readFileSync(sidecar, 'utf8')), snapshot);
  assert.deepEqual(readFileSync(loaded, 'utf8').trim().split('\n'), ['scoped_tool', 'scoped_tool']);
  for (const script of [first.details.launchScriptFile, resumed.details.launchScriptFile]) {
    const text = readFileSync(script, 'utf8'); assert.match(text, /--no-extensions/); assert.match(text, /--no-skills/);
    assert.ok(text.includes(permitted)); assert.ok(!text.includes(unselected));
  }
  writeFileSync(sidecar, JSON.stringify({ ...snapshot, extensionBindings: undefined, extensionBindingProfiles: undefined }));
  const downgraded = await resume(); assert.match(JSON.stringify(downgraded), /no sandbox snapshot/);
  assert.equal(captures().length, 3);
  writeFileSync(sidecar, JSON.stringify(snapshot));
  unlinkSync(permitted); await assert.rejects(resume(), /binding.*missing|backing.*file/i);
  for (const tools of ['', 'tools:', 'tools: , ']) {
    writeFileSync(profileFile, profile(tools)); await assert.rejects(launch(), /scoped.*explicit.*tools/i);
  }
  writeFileSync(profileFile, profile('tools: read, unknown_provider'));
  await assert.rejects(launch(), /binding|extension.*available/i);
  assert.equal(captures().length, 3);
  writeFileSync(profileFile, profile('tools: read'));
  const nextOffset = driver.sentMessages.length;
  const builtin = await launch(); assert.equal(builtin.details.status, 'started', JSON.stringify(builtin));
  await driver.waitForMessage(resultFor, { from: nextOffset, timeout: 15000 });
  const builtinSnapshot = JSON.parse(readFileSync(`${builtin.details.sessionFile}.loadout.json`, 'utf8'));
  assert.equal(builtinSnapshot.extensionPolicy, 'scoped'); assert.deepEqual(builtinSnapshot.extensionBindings, {});
  assert.deepEqual(captures().at(-1).tools.sort(), ['ask_question', 'read']);
  assert.deepEqual(readFileSync(loaded, 'utf8').trim().split('\n'), ['scoped_tool', 'scoped_tool']);
  assert.ok(existsSync(unselected));
} finally { await driver.stop(); }
