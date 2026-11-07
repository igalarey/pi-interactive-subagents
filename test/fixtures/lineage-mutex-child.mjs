import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
const [file, phase] = process.argv.slice(2);
let paused = false;
function pause() {
  if (paused) return;
  paused = true;
  process.send({ paused: true });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
  throw new Error('diagnostic pause expired');
}
const mkdir = fs.mkdirSync, rm = fs.rmSync, rename = fs.renameSync;
fs.mkdirSync = function(path, ...args) {
  const result = mkdir.call(this, path, ...args);
  if (path === `${file}.lock` && phase !== 'after-write' && phase !== 'release') pause();
  return result;
};
fs.rmSync = function(path, ...args) {
  if (path === `${file}.lock` && phase === 'release') pause();
  return rm.call(this, path, ...args);
};
fs.renameSync = function(from, to) {
  const result = rename.call(this, from, to);
  if (to === file && phase === 'after-write') pause();
  return result;
};
syncBuiltinESMExports();
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) {
  if (sql === 'BEGIN IMMEDIATE' && phase === 'before-acquire') pause();
  if (sql === 'ROLLBACK' && phase === 'release') pause();
  const result = exec.call(this, sql);
  if (sql === 'BEGIN IMMEDIATE' && phase === 'held') pause();
  return result;
};
const { reserveLineageLaunch } = await import('../../pi-extension/subagents/lineage.ts');
await reserveLineageLaunch(file, {
  id: 'killed', parentId: null, name: 'killed', agent: 'worker', depth: 1,
  sessionFile: `${file}.session`, activityFile: `${file.slice(0, file.lastIndexOf('/'))}/subagent-activity/killed.json`,
  ownerPid: process.pid, task: 'synthetic', kind: 'launch',
});
throw new Error('expected pause');
