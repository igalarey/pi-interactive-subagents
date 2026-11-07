import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTestEnv, createExtensionDriver, shellEscape } from '../harness.ts';

const env = createTestEnv();
const events = join(env.root, 'extension-events');
function backing(name: string) {
  const file = join(env.root, `${name}.ts`);
  writeFileSync(file, `import { appendFileSync } from 'node:fs'; export default function(pi) { appendFileSync(${JSON.stringify(events)}, JSON.stringify({ tool: ${JSON.stringify(name)}, role: process.env.PI_SUBAGENT_AGENT, event: 'loaded' })+'\\n'); pi.registerTool({ name: ${JSON.stringify(name)}, label: 'Fixture', description: 'Offline fixture', parameters: { type: 'object', properties: {} }, async execute() { appendFileSync(${JSON.stringify(events)}, JSON.stringify({ tool: ${JSON.stringify(name)}, role: process.env.PI_SUBAGENT_AGENT, event: 'called' })+'\\n'); return { content: [{ type:'text', text:'APPROVED_TOOL_RESULT' }], details: {} }; } }); }`);
  return file;
}
const own = backing('own_tool'), specialist = backing('specialist_tool'), unrelated = backing('unrelated_tool');
const specialistFile = join(env.agentDir, 'agents', 'specialist.md');
const specialistProfile = (extra = '') => `---\nname: specialist\nmodel: bindings-faux/local\nextensions: scoped\ntools: read, specialist_tool${extra === 'tool' ? ', unrelated_tool' : ''}\nskills: false\nauto-exit: true\n${extra === 'spawn' ? 'subagent_agents: coordinator\n' : ''}---\nSpecialist fixture`;
writeFileSync(specialistFile, specialistProfile());
writeFileSync(join(env.agentDir, 'agents', 'coordinator.md'), '---\nname: coordinator\nmodel: bindings-faux/local\nextensions: scoped\ntools: read, own_tool\nsubagent_agents: specialist\nskills: false\nauto-exit: true\n---\nCoordinator fixture');
writeFileSync(join(env.agentDir, 'subagents.json'), JSON.stringify({ ...JSON.parse(readFileSync(resolve('config.json.example'), 'utf8')), surfaceBackend: 'process', includeBundledAgents: false, allowProjectAgents: false, requireProfile: true, delegation: { maxDepth: 2, maxConcurrentDescendants: 6, maxConcurrentChildren: 2, maxLaunchesPerLineage: null } }));
mkdirSync(join(env.agentDir, 'extensions'), { recursive: true });
writeFileSync(join(env.agentDir, 'extensions', 'ambient.ts'), `export default function() { throw new Error('GLOBAL_EXTENSION_MUST_NOT_LOAD'); }`);
const bin = join(env.root, 'bin'); mkdirSync(bin);
writeFileSync(join(bin, 'pi'), `#!/bin/bash\nexec ${shellEscape(process.execPath)} ${shellEscape(process.env.PI_TEST_CLI!)} "$@" -e ${shellEscape(resolve('test/integration/fixtures/faux-binding-coordinator.ts'))}\n`, { mode: 0o700 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.PI_TEST_PHASE = 'launch';
const driver = await createExtensionDriver(env);
const module = await import('../../../pi-extension/subagents/index.ts');
for (const [tool, path] of Object.entries({ own_tool: own, specialist_tool: specialist, unrelated_tool: unrelated })) module.registerToolExtension(tool, path);
const call = (tool: string, params: object) => driver.tool(tool).execute('bindings', params, undefined, undefined, driver.ctx);
const resultFor = (entry: any) => entry.message?.customType === 'subagent_result' && entry.message?.details?.name === 'coordinator';
const captures = () => readFileSync(process.env.PI_TEST_CAPTURE!, 'utf8').trim().split('\n').map(line => JSON.parse(line));
try {
  const first = await call('subagent', { agent: 'coordinator', name: 'coordinator', task: 'Launch specialist.' });
  assert.equal(first.details.status, 'started', JSON.stringify(first));
  const done = await driver.waitForMessage(resultFor, { timeout: 20000 });
  assert.equal(done.message.details.exitCode, 0, JSON.stringify(done));
  assert.ok(captures().some(row => row.role === 'specialist'), `real nested specialist must start: ${JSON.stringify(captures())}`);
  const snapshot = JSON.parse(readFileSync(`${first.details.sessionFile}.loadout.json`, 'utf8'));
  assert.equal(snapshot.extensionPolicy, 'scoped');
  assert.deepEqual(snapshot.extensionBindings, { own_tool: own, specialist_tool: specialist });
  assert.deepEqual(snapshot.extensionBindingProfiles, { specialist: { toolAllowlist: 'read,specialist_tool,ask_question', spawnable: [] } });
  const script = readFileSync(first.details.launchScriptFile, 'utf8');
  assert.ok(script.includes(own)); assert.ok(!script.includes(specialist)); assert.ok(!script.includes(unrelated));
  for (const phase of ['resume', 'widen-tool', 'widen-spawn']) {
    writeFileSync(specialistFile, specialistProfile(phase === 'widen-tool' ? 'tool' : phase === 'widen-spawn' ? 'spawn' : ''));
    process.env.PI_TEST_PHASE = phase;
    const offset = driver.sentMessages.length;
    const resumed = await call('subagent_message', { name: 'coordinator', message: 'Launch specialist again.', resume_only: true });
    assert.equal(resumed.details.status, 'started', JSON.stringify(resumed));
    await driver.waitForMessage(resultFor, { from: offset, timeout: 20000 });
    const phaseRows = captures().filter(row => row.phase === phase);
    assert.equal(phaseRows.some(row => row.role === 'specialist'), phase === 'resume', phase);
    if (phase.startsWith('widen')) assert.match(JSON.stringify(phaseRows), /ceiling|widen|scope/i);
    assert.deepEqual(JSON.parse(readFileSync(`${first.details.sessionFile}.loadout.json`, 'utf8')), snapshot);
  }
  const loaded = readFileSync(events, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(loaded.some(row => row.event === 'called' && row.tool === 'specialist_tool'));
  assert.ok(loaded.every(row => (row.tool === 'own_tool' && row.role === 'coordinator') || (row.tool === 'specialist_tool' && row.role === 'specialist')));
  for (const row of captures()) {
    assert.ok(!row.tools.includes('unrelated_tool'));
    if (row.role === 'specialist') assert.ok(!row.tools.includes('subagent') && !row.tools.includes('own_tool'));
    else assert.ok(!row.tools.includes('specialist_tool'));
  }
  const modes = readFileSync(process.env.PI_TEST_MODES!, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(modes.length >= 6); assert.ok(modes.every(row => row.mode === 'tui' && row.stdin && row.stdout));
  const count = captures().length;
  unlinkSync(specialist);
  await assert.rejects(call('subagent_message', { name: 'coordinator', message: 'missing', resume_only: true }), /binding.*missing|backing.*file/i);
  assert.equal(captures().length, count);
  assert.ok(existsSync(own));
} finally { await driver.stop(); }
