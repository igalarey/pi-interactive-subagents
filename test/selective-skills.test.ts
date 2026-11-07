import './isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { resolvePersonalSkills } from '../pi-extension/subagents/skills.ts';
import { __test__ } from '../pi-extension/subagents/index.ts';
import { readSubagentLoadout, writeSubagentLoadout, type SubagentLoadout } from '../pi-extension/subagents/session.ts';

test('personal named selection survives snapshot replay and SDK no-skills excludes discovery', async () => {
  const agentDir = process.env.PI_CODING_AGENT_DIR!;
  const cwd = join(homedir(), 'project');
  function skill(root: string, name: string, body = 'approved') {
    const dir = join(root, name); mkdirSync(dir, { recursive: true });
    const path = join(dir, 'SKILL.md');
    writeFileSync(path, `---\nname: ${name}\ndescription: Fixture skill\n---\n${body}`); return path;
  }
  const selected = skill(join(agentDir, 'skills'), 'approved');
  skill(join(agentDir, 'skills'), 'unselected');
  skill(join(cwd, '.pi', 'skills'), 'project-only');
  skill(join(cwd, '.pi', 'skills'), 'approved', 'untrusted');
  assert.deepEqual(resolvePersonalSkills('approved', agentDir), [selected]);
  for (const name of ['project-only', '../approved', '/tmp/skill', 'missing']) assert.throws(() => resolvePersonalSkills(name, agentDir));
  const bad = skill(join(agentDir, 'skills'), 'invalid'); writeFileSync(bad, 'no frontmatter');
  assert.throws(() => resolvePersonalSkills('invalid', agentDir));
  symlinkSync(join(cwd, '.pi', 'skills', 'project-only'), join(agentDir, 'skills', 'escape'));
  assert.throws(() => resolvePersonalSkills('escape', agentDir));
  const loadout: SubagentLoadout = { agent: 'fixture', toolAllowlist: 'read', disableSkills: true,
    skillPolicy: 'personal-named', skillPaths: [selected], model: null, thinking: null, systemPromptMode: null,
    identity: null, spawnable: [], autoExit: true, cwd, agentDir };
  const session = join(homedir(), 'session.jsonl'); writeSubagentLoadout(session, loadout);
  const saved = readSubagentLoadout(session)!; assert.deepEqual(saved, loadout);
  const parts: string[] = []; __test__.applySandboxToParts(parts, saved, { artifactDir: cwd, name: 'fixture' });
  assert.ok(parts.includes('--no-skills')); assert.ok(parts.includes('--skill')); assert.ok(parts.includes(`'${selected}'`));
  const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noSkills: true, additionalSkillPaths: saved.skillPaths });
  await loader.reload(); assert.deepEqual(loader.getSkills().skills.map(s => s.name), ['approved']);
  const legacy = { ...loadout }; delete legacy.skillPolicy; delete legacy.skillPaths; legacy.disableSkills = false;
  const legacyParts: string[] = []; __test__.applySandboxToParts(legacyParts, legacy, { artifactDir: cwd, name: 'legacy' });
  assert.ok(legacyParts.includes('--no-skills'), 'legacy restricted snapshots cannot rediscover skills');
  writeFileSync(selected, 'invalid now');
  assert.throws(() => __test__.applySandboxToParts([], saved, { artifactDir: cwd, name: 'fixture' }), /skill/i);
});
