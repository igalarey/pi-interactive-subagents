import { loadSkills } from '@earendil-works/pi-coding-agent';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { homedir } from 'node:os';

function personalRoots(agentDir: string): string[] {
  return [join(agentDir, 'skills'), join(homedir(), '.agents', 'skills')];
}

export function validatePersonalSkillPaths(paths: string[], agentDir: string, options: { catalog?: boolean } = {}): void {
  const roots = personalRoots(agentDir).filter(existsSync).map(root => realpathSync(root));
  for (const path of paths) {
    if (!isAbsolute(path) || !existsSync(path)) throw new Error(`Selected skill is missing: ${path}`);
    const canonical = realpathSync(path);
    if (!roots.some(root => {
      const rel = relative(root, canonical);
      return rel !== '' && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel);
    }) || !statSync(canonical).isFile() || basename(path) !== 'SKILL.md') {
      throw new Error(`Selected skill is outside personal trusted skill locations: ${path}`);
    }
    const result = loadSkills({ cwd: agentDir, agentDir, skillPaths: [canonical], includeDefaults: false });
    if (result.diagnostics.length || result.skills.length !== 1 || result.skills[0].name !== basename(dirname(path))) {
      throw new Error(`Invalid named personal skill: ${path}`);
    }
    if (options.catalog && result.skills[0].disableModelInvocation) {
      throw new Error(`Skill catalog cannot advertise disable-model-invocation skill: ${path}`);
    }
  }
}

export function resolvePersonalSkills(names: string | undefined, agentDir: string, options: { catalog?: boolean } = {}): string[] {
  if (names === undefined) return [];
  const selected = [...new Set(names.split(',').map(name => name.trim()))];
  if (selected.length > 100) throw new Error('Too many selected skills (maximum 100)');
  const paths = selected.map(name => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) throw new Error(`Invalid skill name: ${name}`);
    const path = personalRoots(agentDir).map(root => join(root, name, 'SKILL.md')).find(existsSync);
    if (!path) throw new Error(`Named personal skill not found: ${name}`);
    return path;
  });
  validatePersonalSkillPaths(paths, agentDir, options);
  return paths;
}
