import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupTestEnv, createTestEnv } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const PI_CLI = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const DONE_EXTENSION = join(ROOT, "pi-extension", "subagents", "subagent-done.ts");
const FIXTURE_EXTENSION = join(HERE, "fixtures", "faux-nested-lifecycle.ts");

function cleanChildEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith("PI_SUBAGENT_") && value !== undefined) env[key] = value;
  }
  return env;
}

test("official Pi RPC closes a nested parent only after the delivered child handoff settles", { timeout: 30_000 }, async (t) => {
  const env = createTestEnv();
  t.after(() => cleanupTestEnv(env));

  const sessionFile = join(env.root, "rpc-nested.jsonl");
  const activityFile = join(env.root, "rpc-nested.activity.json");
  mkdirSync(dirname(activityFile), { recursive: true });

  const child = spawn(process.execPath, [
    PI_CLI,
    "--mode", "rpc",
    "--session", sessionFile,
    "--no-extensions",
    "--tools", "ask_question",
    "-e", DONE_EXTENSION,
    "-e", FIXTURE_EXTENSION,
    "--model", "lifecycle-faux/nested",
  ], {
    cwd: env.dir,
    env: {
      ...cleanChildEnvironment(),
      PI_OFFLINE: "1",
      PI_CODING_AGENT_DIR: env.agentDir,
      PI_SUBAGENT_AUTO_EXIT: "1",
      PI_SUBAGENT_SESSION: sessionFile,
      PI_SUBAGENT_ID: "offline-nested-parent",
      PI_SUBAGENT_NAME: "offline-nested-parent",
      PI_SUBAGENT_ACTIVITY_FILE: activityFile,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdin.end(`${JSON.stringify({ id: "start", type: "prompt", message: "Run the nested lifecycle fixture." })}\n`);

  const outcome = await closed;
  assert.equal(outcome.signal, null, `Pi RPC was killed by ${outcome.signal}; stderr: ${stderr}`);
  assert.equal(outcome.code, 0, `Pi RPC exited non-zero; stderr: ${stderr}`);
  assert.equal(existsSync(sessionFile), true, `session was not created; stderr: ${stderr}`);

  const records = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(records.some((record) =>
    record.type === "response" && record.id === "start" && record.success === true
  ), "RPC prompt was not accepted");

  const starts = records.filter((record) => record.type === "agent_start");
  const ends = records.filter((record) => record.type === "agent_end");
  const settled = records.filter((record) => record.type === "agent_settled");
  assert.equal(starts.length, 2, "expected the spawning turn and one handoff-integration turn");
  assert.equal(ends.length, 2, "both real agent runs must complete before shutdown");
  assert.equal(settled.length, 2, "the first settlement must park and the second must close");

  const entries = readFileSync(sessionFile, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const customHandoff = entries.find((entry) =>
    entry.type === "custom_message" && entry.customType === "subagent_result"
  );
  assert.match(
    customHandoff?.content ?? "",
    /OFFLINE_CHILD_HANDOFF/,
    `delivered custom handoff missing from session: ${JSON.stringify(entries)}`,
  );

  const finalAssistant = [...entries].reverse().find((entry) =>
    entry.type === "message" && entry.message?.role === "assistant"
  );
  const finalText = (finalAssistant?.message?.content ?? [])
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("\n");
  assert.match(finalText, /Integrated OFFLINE_CHILD_HANDOFF/);
  assert.doesNotMatch(finalText, /MISSING_CHILD_HANDOFF/);
});
