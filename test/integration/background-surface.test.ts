/**
 * Integration tests for the process-backed surface layer.
 *
 * These tests launch real local child processes but make no model calls.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  sendCommand,
  sendLongCommand,
  readScreen,
  waitForScreen,
  waitForFile,
  shellEscape,
  uniqueId,
  type TestEnv,
} from "./harness.ts";

describe("background surface", { timeout: 60_000 }, () => {
  let env: TestEnv;

  before(() => {
    env = createTestEnv();
  });

  after(() => {
    cleanupTestEnv(env);
  });

  it("runs a command and captures its output", async () => {
    const surface = createTrackedSurface(env, "echo-test");
    const marker = uniqueId();

    sendLongCommand(surface, `printf '%s\\n' ${shellEscape(`MARKER_${marker}`)}`, {
      scriptPath: join(env.dir, `echo-${marker}.sh`),
    });

    const output = await waitForScreen(surface, new RegExp(`MARKER_${marker}`), 20_000, 50);
    assert.match(output, new RegExp(`MARKER_${marker}`));
  });

  it("steers a running process through JSONL input", async () => {
    const surface = createTrackedSurface(env, "steer-test");
    const script = join(env.dir, `steer-${uniqueId()}.sh`);

    sendLongCommand(
      surface,
      "IFS= read -r first; IFS= read -r second; printf '%s\\n%s\\n' \"$first\" \"$second\"",
      {
        scriptPath: script,
        initialInput: JSON.stringify({ type: "prompt", message: "start" }),
      },
    );
    sendCommand(surface, "continue");

    const output = await waitForScreen(surface, /"message":"continue"/, 20_000, 50);
    assert.match(output, /"message":"start"/);
    assert.match(output, /"streamingBehavior":"steer"/);
  });

  it("runs multiple surfaces concurrently", async () => {
    const first = createTrackedSurface(env, "first");
    const second = createTrackedSurface(env, "second");
    const id = uniqueId();
    const firstFile = join(env.dir, `first-${id}.txt`);
    const secondFile = join(env.dir, `second-${id}.txt`);

    sendLongCommand(first, `sleep 1; printf FIRST > ${shellEscape(firstFile)}`, {
      scriptPath: join(env.dir, `first-${id}.sh`),
    });
    sendLongCommand(second, `printf SECOND > ${shellEscape(secondFile)}`, {
      scriptPath: join(env.dir, `second-${id}.sh`),
    });

    const [firstContent, secondContent] = await Promise.all([
      waitForFile(firstFile, 20_000, /FIRST/),
      waitForFile(secondFile, 20_000, /SECOND/),
    ]);
    assert.equal(firstContent, "FIRST");
    assert.equal(secondContent, "SECOND");
    assert.match(readScreen(first, 20), /^$/);
  });
});
