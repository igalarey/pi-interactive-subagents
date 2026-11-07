import './isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureLineageLedger, reconcileLineageLedger, readLineageLedger, DEFAULT_DELEGATION_LIMITS } from '../pi-extension/subagents/lineage.ts';
const root = () => mkdtempSync(join(tmpdir(), 'mutex-regression-'));
const initialize = (file: string, allowLimitUpdate = true) => ensureLineageLedger(file, 'root', DEFAULT_DELEGATION_LIMITS, { allowLimitUpdate });

test('crash-released lineage mutex preserves accounting at acquisition, mutation and release boundaries', async () => {
  for (const phase of ['before-acquire', 'held', 'after-write', 'release']) {
    const file = join(root(), 'lineage.json');
    await initialize(file);
    const child = fork(resolve('test/fixtures/lineage-mutex-child.mjs'), [file, phase], { silent: true });
    let errors = ''; child.stderr!.on('data', data => errors += data);
    try {
      const ready = await Promise.race([
        once(child, 'message'),
        once(child, 'exit').then(() => { throw new Error(`child exited: ${errors}`); }),
        new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('pause deadline')), 10000); timer.unref(); }),
      ]);
      assert.equal(ready[0].paused, true);
      if (phase !== 'before-acquire') await assert.rejects(reconcileLineageLedger(file), /Timed out acquiring subagent lineage lock/);
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      await reconcileLineageLedger(file, Date.now() + 120_000);
      const ledger = readLineageLedger(file)!;
      assert.equal(ledger.launchesUsed, ['after-write', 'release'].includes(phase) ? 1 : 0, phase);
      assert.equal(Object.keys(ledger.active).length, 0, phase);
      assert(existsSync(`${file}.lock/protocol.json`), 'permanent fence must survive every operation');
    } finally {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    }
  }
});

test('root-only initialization, racing roots, legacy refusal and persistent protocol fence', async () => {
  const file = join(root(), 'lineage.json');
  await assert.rejects(initialize(file, false), /inherited|root|initializ/i);
  assert(!existsSync(`${file}.lock`));
  await Promise.all([initialize(file), initialize(file)]);
  const marker = readFileSync(`${file}.lock/protocol.json`, 'utf8');
  // An old runtime can only enter by mkdir; the permanent fence must deny it.
  assert.throws(() => mkdirSync(`${file}.lock`), { code: 'EEXIST' });
  await initialize(file, false);
  assert.equal(readFileSync(`${file}.lock/protocol.json`, 'utf8'), marker);
  const legacy = join(root(), 'legacy.json'); mkdirSync(`${legacy}.lock`);
  writeFileSync(`${legacy}.lock/owner.json`, '{"pid":999999,"at":0}');
  await assert.rejects(initialize(legacy), /lock|protocol|fence/i);
  assert.equal(readFileSync(`${legacy}.lock/owner.json`, 'utf8'), '{"pid":999999,"at":0}');
  const ledger = readFileSync(file, 'utf8');
  writeFileSync(`${file}.lock/protocol.json`, '{"version":999}');
  await assert.rejects(initialize(file), /protocol|fence/i);
  assert.equal(readFileSync(file, 'utf8'), ledger);
});

test('missing database and symlinked protocol objects fail closed, never recreate a live mutex', async () => {
  for (const name of ['protocol.json', 'mutex.sqlite']) {
    const file = join(root(), 'lineage.json'); await initialize(file);
    const target = `${file}.lock/${name}`;
    renameSync(target, `${target}.saved`);
    await assert.rejects(initialize(file), /mutex|protocol|fence|ENOENT/i);
    assert(!existsSync(target));
    if (process.platform !== 'win32') {
      symlinkSync(`${target}.saved`, target);
      await assert.rejects(initialize(file), /symbolic|regular|protocol|mutex|fence/i);
    }
  }
});

test('unavailable SQLite refuses before creating a fence; descendants cannot opt into initialization', () => {
  const dir = root(), file = join(dir, 'lineage.json');
  const loader = join(dir, 'deny-sqlite.mjs');
  writeFileSync(loader, `export async function resolve(s,c,n){if(s==='node:sqlite')throw Error('fixture unavailable');return n(s,c);}`);
  const module = new URL('../pi-extension/subagents/lineage.ts', import.meta.url).href;
  const script = `const m=await import(${JSON.stringify(module)});await m.ensureLineageLedger(${JSON.stringify(file)},'root',m.DEFAULT_DELEGATION_LIMITS,{allowLimitUpdate:true});`;
  const result = spawnSync(process.execPath, ['--loader', loader, '--input-type=module', '-e', script], { env: process.env, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /SQLite.*required|requires.*SQLite/i);
  assert(!existsSync(`${file}.lock`));
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, PI_SUBAGENT_LINEAGE_FILE: file }, encoding: 'utf8' });
  assert.notEqual(child.status, 0); assert.match(child.stderr, /root|inherited|initializ/i);
  assert(!existsSync(`${file}.lock`));
});

test('interrupted root initialization remains fenced; independent roots serialize initialization', async () => {
  const file = join(root(), 'lineage.json');
  const module = new URL('../pi-extension/subagents/lineage.ts', import.meta.url).href;
  const code = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const mkdir=fs.mkdirSync;fs.mkdirSync=function(p,...a){const r=mkdir(p,...a);if(p===${JSON.stringify(file+'.lock')}){process.send('fenced');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,15000);}return r;};syncBuiltinESMExports();const m=await import(${JSON.stringify(module)});await m.ensureLineageLedger(${JSON.stringify(file)},'root',m.DEFAULT_DELEGATION_LIMITS,{allowLimitUpdate:true});`;
  const script = join(root(), 'initialize.mjs'); writeFileSync(script, code);
  const child = fork(script, [], { silent: true });
  try {
    await once(child, 'message');
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    await assert.rejects(initialize(file), /lock|fence|protocol/i);
    assert(existsSync(`${file}.lock`)); assert(!existsSync(file));
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  }
  const shared = join(root(), 'lineage.json');
  const worker = join(root(), 'root.mjs');
  writeFileSync(worker, `const m=await import(${JSON.stringify(module)});await m.ensureLineageLedger(${JSON.stringify(shared)},'root',m.DEFAULT_DELEGATION_LIMITS,{allowLimitUpdate:true});`);
  const children = Array.from({length:4},()=>fork(worker, [], {silent:true}));
  const exits = await Promise.all(children.map(child => once(child, 'exit')));
  assert(exits.every(([code]) => code === 0));
  assert(existsSync(`${shared}.lock/protocol.json`));
  assert.equal(readLineageLedger(shared)!.launchesUsed, 0);
});
