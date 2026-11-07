import { isAbsolute } from 'node:path';
import { statSync } from 'node:fs';

export interface ExtensionBindingProfile {
  toolAllowlist: string;
  spawnable: string[];
}
export interface ExtensionBindingSnapshot {
  extensionBindings?: Record<string, string>;
  extensionBindingProfiles?: Record<string, ExtensionBindingProfile>;
  toolAllowlist: string | null;
  spawnable: string[] | null;
}
const RESERVED = new Set(['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'ask_question', 'subagent', 'subagent_message', 'subagents_list', 'subagent_cancel', 'subagent_status', 'implementation_route']);
export function isReservedBindingTool(name: string): boolean { return RESERVED.has(name); }
function validName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(name) && !['constructor', 'prototype', '__proto__'].includes(name);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function bindingTools(value: string): string[] { return value.split(',').map(tool => tool.trim()).filter(Boolean); }
function validTools(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 8192 && bindingTools(value).length <= 256 && bindingTools(value).every(validName);
}
function validProfiles(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 100 && value.every(name => typeof name === 'string' && validName(name)) && new Set(value).size === value.length;
}

export function validateExtensionBindingSnapshot(input: ExtensionBindingSnapshot): void {
  const bindings = input.extensionBindings, profiles = input.extensionBindingProfiles;
  if (bindings === undefined && profiles === undefined) return;
  if (!object(bindings) || !object(profiles) || !validTools(input.toolAllowlist) || !validProfiles(input.spawnable ?? [])) throw new Error('Invalid extension binding snapshot scope');
  if (Object.keys(bindings).length > 256 || Object.keys(profiles).length > 100 || Buffer.byteLength(JSON.stringify([bindings, profiles])) > 48 * 1024) throw new Error('Extension binding snapshot exceeds bounds');
  for (const [tool, path] of Object.entries(bindings)) {
    if (!validName(tool) || isReservedBindingTool(tool) || typeof path !== 'string' || path.length > 32768 || !isAbsolute(path) || path.includes('\0')) throw new Error(`Invalid extension binding: ${tool}`);
  }
  for (const [name, scope] of Object.entries(profiles)) {
    if (!validName(name) || !object(scope) || Object.keys(scope).sort().join(',') !== 'spawnable,toolAllowlist' || !validTools(scope.toolAllowlist) || !validProfiles(scope.spawnable)) throw new Error(`Invalid extension binding profile: ${name}`);
  }
  const needed = new Set(bindingTools(input.toolAllowlist!).filter(tool => !isReservedBindingTool(tool)));
  const visited = new Set<string>();
  const queue = [...(input.spawnable ?? [])];
  while (queue.length) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    if (!Object.hasOwn(profiles, name)) throw new Error(`Missing extension binding profile scope: ${name}`);
    visited.add(name);
    const scope = profiles[name];
    for (const tool of bindingTools(scope.toolAllowlist)) if (!isReservedBindingTool(tool)) needed.add(tool);
    queue.push(...scope.spawnable);
  }
  if (visited.size !== Object.keys(profiles).length || needed.size !== Object.keys(bindings).length || [...needed].some(tool => !Object.hasOwn(bindings, tool))) throw new Error('Extension binding snapshot widens or omits scoped mappings');
}

export function assertExtensionBindingFiles(input: ExtensionBindingSnapshot): void {
  validateExtensionBindingSnapshot(input);
  for (const path of Object.values(input.extensionBindings ?? {})) {
    try { if (statSync(path).isFile()) continue; } catch {}
    throw new Error(`Extension binding backing file missing or invalid: ${path}`);
  }
}

export function assertBindingProfileCeiling(name: string, scope: ExtensionBindingProfile, profiles: Record<string, ExtensionBindingProfile>): void {
  const ceiling = Object.hasOwn(profiles, name) ? profiles[name] : undefined;
  if (!ceiling || bindingTools(scope.toolAllowlist).some(tool => !bindingTools(ceiling.toolAllowlist).includes(tool)) || scope.spawnable.some(profile => !ceiling.spawnable.includes(profile))) {
    throw new Error(`Subagent profile ${name} would widen its snapshotted tool/spawn ceiling`);
  }
}
