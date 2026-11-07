import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const cli = process.env.PI_TEST_CLI;
test('Pi 1.5 offline TUI: personal bootstrap and selective catalog survive resume without cwd discovery', { skip: !cli, timeout: 60000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'selective-skills-tui-'));
  const file = (name: string) => join(root, name);
  mkdirSync(file('home')); mkdirSync(file('agent'));
  try {
    const result = spawnSync(process.execPath, [resolve('test/integration/fixtures/selective-skills-tui.ts')], {
      env: {
        HOME: file('home'), PI_CODING_AGENT_DIR: file('agent'), PATH: dirname(process.execPath) + ':/usr/bin:/bin', TERM: 'xterm-256color', PI_OFFLINE: '1', PI_TEST_CLI: cli!,
        PI_TEST_FAUX: resolve(dirname(cli!), '../node_modules/@earendil-works/pi-ai/dist/providers/faux.js'),
        PI_TEST_CAPTURE: file('captures'), PI_TEST_MODES: file('modes'),
      }, encoding: 'utf8', timeout: 55000,
    });
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
