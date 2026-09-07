import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const model = process.env.PI_TEST_MODEL?.trim();
if (!model) {
  console.error("PI_TEST_MODEL is required (choose a non-reserved model for the live pilot).");
  process.exit(2);
}
if (/astra/i.test(model) || /:xhigh$/i.test(model)) {
  console.error("The live pilot refuses reserved Astra/xhigh models.");
  process.exit(2);
}

for (const variable of ["PI_TEST_AUTH_FILE", "PI_TEST_MODELS_FILE"]) {
  const selected = process.env[variable]?.trim();
  if (!selected) continue;
  try {
    const stat = lstatSync(resolve(selected));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a concrete regular file");
  } catch (error) {
    console.error(`${variable} is invalid: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

const requestedTimeout = Number(process.env.PI_TEST_TIMEOUT ?? "60000");
if (!Number.isFinite(requestedTimeout) || requestedTimeout < 15_000 || requestedTimeout > 120_000) {
  console.error("PI_TEST_TIMEOUT must be between 15000 and 120000 milliseconds.");
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testFile = join(root, "test", "integration", "subagent-lifecycle.test.ts");
const result = spawnSync(
  process.execPath,
  [
    "--test",
    "--test-concurrency=1",
    `--test-timeout=${requestedTimeout + 15_000}`,
    "--test-name-pattern=delivers structured completion from one RPC child",
    testFile,
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      PI_OFFLINE: "1",
      PI_RUN_LIVE_SUBAGENT_TESTS: "1",
      PI_TEST_MODEL: model,
      PI_TEST_TIMEOUT: String(requestedTimeout),
    },
    stdio: "inherit",
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
