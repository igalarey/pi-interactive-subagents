/**
 * Opt-in live child-process integration tests.
 *
 * These tests invoke the extension through a synthetic parent API and launch
 * only child Pi processes in RPC mode. They do not exercise the parent Pi
 * loader, parent RPC protocol, TUI, tmux, or Orca. Set
 * PI_RUN_LIVE_SUBAGENT_TESTS=1 to enable all seven cases.
 *
 * Configuration:
 *   PI_TEST_MODEL       — non-reserved model used by live child sessions
 *   PI_TEST_AUTH_FILE   — optional concrete auth.json source copied privately
 *   PI_TEST_MODELS_FILE — optional concrete models.json source copied privately
 *   PI_TEST_TIMEOUT     — per-test timeout in ms (default: 60000)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  createTestEnv,
  createExtensionDriver,
  uniqueId,
  PI_TIMEOUT,
  TEST_MODEL,
  type TestEnv,
} from "./harness.ts";

const runLiveTests = process.env.PI_RUN_LIVE_SUBAGENT_TESTS === "1";
if (runLiveTests && !process.env.PI_TEST_MODEL?.trim()) {
  throw new Error("PI_TEST_MODEL is required when live subagent tests are enabled.");
}
if (runLiveTests && (/astra/i.test(TEST_MODEL) || /:xhigh$/i.test(TEST_MODEL))) {
  throw new Error("Live subagent tests refuse reserved Astra/xhigh models.");
}
if (runLiveTests && (!Number.isFinite(PI_TIMEOUT) || PI_TIMEOUT < 15_000 || PI_TIMEOUT > 120_000)) {
  throw new Error("PI_TEST_TIMEOUT must be between 15000 and 120000 milliseconds.");
}
const describeLive = runLiveTests ? describe : describe.skip;

type Driver = Awaited<ReturnType<typeof createExtensionDriver>>;

function handoffTask(marker: string): string {
  return [
    `Return this completion marker in your final response: ${marker}`,
    "Use the exact structured handoff headings Status, Summary, Files, Verification, Risks/Blockers, and Next.",
    "Set Status to complete. Do not call tools.",
  ].join("\n");
}

function isResultFor(name: string) {
  return (entry: { message: any }) =>
    entry.message?.customType === "subagent_result" && entry.message?.details?.name === name;
}

function sessionEntries(path: string): any[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describeLive("subagent lifecycle (synthetic parent, live RPC children)", { timeout: PI_TIMEOUT + 15_000 }, () => {
  let env: TestEnv;
  let driver: Driver;

  beforeEach(async () => {
    env = createTestEnv();
    driver = await createExtensionDriver(env);
  });

  afterEach(async () => {
    await driver?.stop();
  });

  it("delivers structured completion from one RPC child", async () => {
    const id = uniqueId();
    const name = `Delivery-${id}`;
    const marker = `DELIVERY_${id}`;
    const startedAt = Date.now();

    const acknowledgement = await driver.tool("subagent").execute(
      `spawn-${id}`,
      { agent: "test-echo", name, model: TEST_MODEL, task: handoffTask(marker) },
      undefined,
      undefined,
      driver.ctx,
    );

    assert.equal(acknowledgement.details.status, "started");
    assert.equal(acknowledgement.details.name, name);
    assert.ok(Date.now() - startedAt < 10_000, "spawn acknowledgement should be asynchronous");

    const delivered = await driver.waitForMessage(isResultFor(name));
    assert.equal(delivered.options?.deliverAs, "steer");
    assert.equal(delivered.options?.triggerTurn, true);
    assert.equal(delivered.message.details.exitCode, 0);
    assert.equal(delivered.message.details.handoff?.status, "complete");
    assert.match(delivered.message.content, new RegExp(marker));

    const sessionFile = acknowledgement.details.sessionFile as string;
    assert.equal(existsSync(sessionFile), true);
    assert.equal(relative(env.parentSessionDir, sessionFile).startsWith(".."), true);
    assert.equal(relative(env.agentDir, sessionFile).startsWith(".."), false);
    assert.equal(sessionEntries(sessionFile)[0].cwd, env.dir);
  });

  it("delivers ask_question, accepts a name-addressed RPC reply, then completes", async () => {
    const id = uniqueId();
    const name = `Question-${id}`;
    const question = `QUESTION_${id}`;
    const completion = `ANSWERED_${id}`;
    const answer = `REPLY_${id}`;

    const acknowledgement = await driver.tool("subagent").execute(
      `spawn-${id}`,
      {
        agent: "test-question",
        name,
        model: TEST_MODEL,
        task: [
          `Ask exactly: ${question}`,
          `After the reply, include ${completion} in the final structured handoff.`,
        ].join("\n"),
      },
      undefined,
      undefined,
      driver.ctx,
    );
    assert.equal(acknowledgement.details.status, "started");

    const asked = await driver.waitForMessage(
      (entry) => entry.message?.customType === "subagent_question" && entry.message?.details?.name === name,
    );
    assert.equal(asked.options?.deliverAs, "steer");
    assert.equal(asked.options?.triggerTurn, true);
    assert.equal(asked.message.details.question, question);

    const messageOffset = driver.sentMessages.length;
    const steered = await driver.tool("subagent_message").execute(
      `reply-${id}`,
      { name, message: answer },
      undefined,
      undefined,
      driver.ctx,
    );
    assert.equal(steered.details.status, "steered");

    const delivered = await driver.waitForMessage(isResultFor(name), { from: messageOffset });
    assert.equal(delivered.message.details.exitCode, 0);
    assert.match(delivered.message.content, new RegExp(completion));
    assert.match(delivered.message.content, new RegExp(answer));
  });

  it("resumes a finished session by the same name and delivers the follow-up", async () => {
    const id = uniqueId();
    const name = `Resume-${id}`;
    const firstMarker = `FIRST_${id}`;
    const secondMarker = `SECOND_${id}`;

    const firstAck = await driver.tool("subagent").execute(
      `spawn-${id}`,
      { agent: "test-echo", name, model: TEST_MODEL, task: handoffTask(firstMarker) },
      undefined,
      undefined,
      driver.ctx,
    );
    const firstDelivery = await driver.waitForMessage(isResultFor(name));
    assert.equal(firstDelivery.message.details.exitCode, 0);

    const messageOffset = driver.sentMessages.length;
    const resumeAck = await driver.tool("subagent_message").execute(
      `resume-${id}`,
      { name, message: handoffTask(secondMarker) },
      undefined,
      undefined,
      driver.ctx,
    );
    assert.equal(resumeAck.details.status, "started");
    assert.equal(resumeAck.details.sessionFile, firstAck.details.sessionFile);

    const secondDelivery = await driver.waitForMessage(isResultFor(name), { from: messageOffset });
    assert.equal(secondDelivery.message.details.exitCode, 0);
    assert.equal(secondDelivery.message.details.sessionFile, firstAck.details.sessionFile);
    assert.match(secondDelivery.message.content, new RegExp(secondMarker));

    const assistants = sessionEntries(firstAck.details.sessionFile).filter(
      (entry) => entry.type === "message" && entry.message?.role === "assistant",
    );
    assert.ok(assistants.length >= 2, "resume should append a second assistant turn");
  });

  it("reports a child startup failure without hanging", async () => {
    const id = uniqueId();
    const name = `Startup-failure-${id}`;
    const missingCwd = join(env.dir, `missing-${id}`);

    const acknowledgement = await driver.tool("subagent").execute(
      `spawn-${id}`,
      {
        agent: "test-echo",
        name,
        model: TEST_MODEL,
        cwd: missingCwd,
        task: handoffTask(`SHOULD_NOT_RUN_${id}`),
      },
      undefined,
      undefined,
      driver.ctx,
    );
    assert.equal(acknowledgement.details.status, "started");

    const delivered = await driver.waitForMessage(isResultFor(name));
    assert.notEqual(delivered.message.details.exitCode, 0);
    assert.match(delivered.message.content, /failed|exit code/i);
    assert.equal(existsSync(missingCwd), false);
  });

  it("delivers two parallel child results independently", async () => {
    const id = uniqueId();
    const names = [`Parallel-A-${id}`, `Parallel-B-${id}`];
    const markers = [`PARALLEL_A_${id}`, `PARALLEL_B_${id}`];

    const acknowledgements = await Promise.all(names.map((name, index) =>
      driver.tool("subagent").execute(
        `spawn-${id}-${index}`,
        { agent: "test-echo", name, model: TEST_MODEL, task: handoffTask(markers[index]) },
        undefined,
        undefined,
        driver.ctx,
      ),
    ));
    assert.deepEqual(acknowledgements.map((ack) => ack.details.status), ["started", "started"]);

    const deliveries = await Promise.all(names.map((name) => driver.waitForMessage(isResultFor(name))));
    for (const [index, delivered] of deliveries.entries()) {
      assert.equal(delivered.message.details.exitCode, 0);
      assert.match(delivered.message.content, new RegExp(markers[index]));
    }
    assert.notEqual(acknowledgements[0].details.sessionFile, acknowledgements[1].details.sessionFile);
  });

  it("lists current fixture agents and current public tool contracts", async () => {
    const listed = await driver.tool("subagents_list").execute("list", {}, undefined, undefined, driver.ctx);
    const echo = listed.details.agents.find((agent: any) => agent.name === "test-echo");
    assert.ok(echo, "test-echo should be discoverable from the isolated config dir");
    assert.equal(echo.capabilities.runtime, "pi");

    const spawnSchema = driver.tool("subagent").parameters;
    assert.deepEqual(Object.keys(spawnSchema.properties).sort(), [
      "agent",
      "cwd",
      "model",
      "name",
      "task",
      "useAstraXhigh",
    ]);
    assert.equal(spawnSchema.properties.fork, undefined);
    assert.throws(() => driver.tool("ask_question"), /not registered/);
  });

  it("uses the requested cwd while keeping the child session in normal isolated storage", async () => {
    const id = uniqueId();
    const name = `Cwd-${id}`;
    const marker = `CWD_${id}`;
    const childCwd = join(env.dir, "child-cwd");
    mkdirSync(childCwd, { recursive: true });

    const acknowledgement = await driver.tool("subagent").execute(
      `spawn-${id}`,
      { agent: "test-echo", name, model: TEST_MODEL, cwd: childCwd, task: handoffTask(marker) },
      undefined,
      undefined,
      driver.ctx,
    );
    const delivered = await driver.waitForMessage(isResultFor(name));
    assert.equal(delivered.message.details.exitCode, 0);

    const sessionFile = acknowledgement.details.sessionFile as string;
    const header = sessionEntries(sessionFile)[0];
    assert.equal(header.cwd, childCwd);
    assert.equal(relative(env.agentDir, sessionFile).startsWith(".."), false);
    assert.equal(relative(env.parentSessionDir, sessionFile).startsWith(".."), true);
    assert.match(delivered.message.content, new RegExp(marker));
  });
});
