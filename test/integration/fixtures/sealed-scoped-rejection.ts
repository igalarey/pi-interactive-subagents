import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sealed = process.env.PI_TEST_SEALED_SUBAGENTS!;
const agentDir = process.env.PI_CODING_AGENT_DIR!;
const root = process.env.HOME!;
mkdirSync(join(agentDir, 'agents'), { recursive: true });
writeFileSync(join(agentDir, 'subagents.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(sealed, 'config.json.example'), 'utf8')), requireProfile: true, includeBundledAgents: false, allowProjectAgents: false, surfaceBackend: 'process' }));
const profile = join(agentDir, 'agents', 'scoped.md');
const definition = (mode: string) => `---\nname: scoped\nextensions: ${mode}\ntools: read\nskill_catalog: future-catalog\nallowed_subagents: none\n---\nRollout fixture`;
writeFileSync(profile, definition('false'));
const sessionDir = join(root, 'parent'); mkdirSync(sessionDir);
const session = join(sessionDir, 'parent.jsonl'); writeFileSync(session, '{}\n');
const bin = join(root, 'bin'); mkdirSync(bin);
const spawned = join(root, 'spawned');
writeFileSync(join(bin, 'pi'), `#!/bin/sh\nprintf attempted > '${spawned}'\nexit 1\n`, { mode: 0o700 });
process.env.PATH = `${bin}:/usr/bin:/bin`;
const { default: extension, __test__ } = await import(pathToFileURL(join(sealed, 'pi-extension/subagents/index.ts')).href);
assert.equal(__test__.loadAgentDefaults('scoped').disableExtensions, true);
const tools = new Map<string, any>(), handlers = new Map<string, any[]>();
const api = new Proxy({
  on(name: string, fn: any) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
  registerTool(tool: any) { tools.set(tool.name, tool); },
  events: { emit() {} },
}, { get(target, key) { return Reflect.get(target, key) ?? (() => {}); } });
extension(api);
const ctx = { hasUI: false, cwd: root, ui: { setWidget() {}, setStatus() {}, notify() {} }, sessionManager: { getSessionFile: () => session, getSessionId: () => 'sealed-parent', getSessionDir: () => sessionDir } };
try {
  for (const handler of handlers.get('session_start') ?? []) await handler({ reason: 'startup' }, ctx);
  writeFileSync(profile, definition('scoped'));
  assert.throws(() => __test__.loadAgentDefaults('scoped'), /Invalid extensions in scoped/);
  await assert.rejects(tools.get('subagent').execute('sealed', { agent: 'scoped', name: 'scoped', task: 'Must refuse before launch' }, undefined, undefined, ctx), /Invalid extensions in scoped/);
  assert.ok(!existsSync(spawned)); assert.ok(!existsSync(join(agentDir, 'sessions')));
} finally {
  for (const handler of handlers.get('session_shutdown') ?? []) await handler({ reason: 'quit' }, ctx);
}
