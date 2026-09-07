import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { closeSurface } from '../../pi-extension/subagents/surface.ts';
import { createTestEnv, cleanupTestEnv, createTrackedSurface, sendLongCommand, shellEscape, waitForFile } from './harness.ts';

test('cancelling a surface stops its detached descendant but not an unrelated sibling', { timeout: 30000 }, async t => {
  const env = createTestEnv();
  let descendant: number | undefined;
  t.after(() => {
    cleanupTestEnv(env);
    if (descendant) { try { process.kill(descendant, 'SIGTERM'); } catch {} }
  });
  const script = path.join(env.dir, 'fixture.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs'; import {spawn} from 'node:child_process';
const child = process.argv[3] === 'tree' ? spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], {detached:true,stdio:'ignore'}) : undefined;
fs.writeFileSync(process.argv[2], String(child?.pid ?? process.pid));
setInterval(()=>{},1000);
`);
  const target = createTrackedSurface(env, 'cancel-tree');
  const sibling = createTrackedSurface(env, 'preserve-sibling');
  const targetPid = path.join(env.dir, 'target.pid');
  const siblingPid = path.join(env.dir, 'sibling.pid');
  sendLongCommand(target, `${shellEscape(process.execPath)} ${shellEscape(script)} ${shellEscape(targetPid)} tree`, { scriptPath: path.join(env.dir, 'target.sh') });
  sendLongCommand(sibling, `${shellEscape(process.execPath)} ${shellEscape(script)} ${shellEscape(siblingPid)}`, { scriptPath: path.join(env.dir, 'sibling.sh') });
  descendant = Number(await waitForFile(targetPid, 10000, /^\d+$/));
  const other = Number(await waitForFile(siblingPid, 10000, /^\d+$/));
  closeSurface(target);
  let stopped = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { process.kill(descendant, 0); } catch (error: any) {
      if (error.code !== 'ESRCH') throw error;
      stopped = true;
      break;
    }
    await delay(50);
  }
  assert.equal(stopped, true, 'detached descendant survived cancellation');
  descendant = undefined;
  assert.doesNotThrow(() => process.kill(other, 0), 'unrelated sibling was stopped');
});
