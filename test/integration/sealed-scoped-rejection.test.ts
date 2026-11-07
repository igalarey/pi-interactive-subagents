import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const sealed = process.env.PI_TEST_SEALED_SUBAGENTS;
test('verified f049ad72 sealed runtime rejects scoped before launch under managed original policy', { skip: !sealed, timeout: 15000 }, () => {
  const release = dirname(dirname(sealed!));
  const manifest = JSON.parse(readFileSync(join(release, 'release.json'), 'utf8'));
  const source = 'f049ad72cbc88003f59f5033a5d60a235f62eae5';
  assert.equal(manifest.sources.subagents.commit, source);
  assert.equal(manifest.packages.find((p: any) => p.name === 'pi-interactive-subagents').commit, source);
  const entry = 'packages/pi-interactive-subagents/pi-extension/subagents/index.ts';
  const recorded = manifest.files.find((f: any) => f.path === entry);
  const bytes = readFileSync(join(release, entry));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), recorded.sha256);
  assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), recorded.gitObject);
  const root = mkdtempSync(join(tmpdir(), 'sealed-scoped-rejection-'));
  mkdirSync(join(root, 'agent'));
  try {
    const copy = join(root, 'verified-sealed-source'); mkdirSync(copy);
    for (const path of ['pi-extension', 'agents', 'package.json', 'config.json.example']) cpSync(join(sealed!, path), join(copy, path), { recursive: true });
    for (const file of manifest.files) {
      const relative = file.path.replace(/^packages\/pi-interactive-subagents\//, '');
      if (relative === file.path || !/^(pi-extension\/|agents\/|package\.json$|config\.json\.example$)/.test(relative)) continue;
      assert.equal(createHash('sha256').update(readFileSync(join(copy, relative))).digest('hex'), file.sha256, relative);
    }
    symlinkSync(resolve('node_modules'), join(copy, 'node_modules'), 'dir');
    const result = spawnSync(process.execPath, [resolve('test/integration/fixtures/sealed-scoped-rejection.ts')], {
      env: { HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent'), PATH: dirname(process.execPath) + ':/usr/bin:/bin', PI_OFFLINE: '1', PI_TEST_SEALED_SUBAGENTS: copy },
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
    assert.equal(createHash('sha256').update(readFileSync(join(release, entry))).digest('hex'), recorded.sha256);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
