import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Deterministic offline provider + child-completion injector for the official
 * Pi RPC lifecycle regression. This is test-only and never performs I/O.
 */
export default async function fauxNestedLifecycle(pi: ExtensionAPI) {
  const fauxPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "node_modules",
    "@earendil-works",
    "pi-ai",
    "dist",
    "providers",
    "faux.js",
  );
  const { fauxAssistantMessage, fauxProvider, fauxToolCall } = await import(pathToFileURL(fauxPath).href);
  const faux = fauxProvider({
    provider: "lifecycle-faux",
    models: [{ id: "nested", name: "Nested lifecycle fixture" }],
  });

  const childMarker = "OFFLINE_CHILD_HANDOFF";
  const answerMarker = "OFFLINE_PARENT_ANSWER";
  let inputCount = 0;
  pi.on("input", () => {
    inputCount += 1;
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("ask_question", { question: "Which contract should I use?" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Waiting for the parent answer while my child is still running."),
    (context: unknown) => {
      const sawHandoff = JSON.stringify(context).includes(childMarker);
      return fauxAssistantMessage(
        sawHandoff
          ? `Observed ${childMarker}, but it does not answer my pending parent question.`
          : "MISSING_CHILD_HANDOFF",
      );
    },
    (context: unknown) => {
      const serialized = JSON.stringify(context);
      const sawHandoff = serialized.includes(childMarker);
      const sawAnswer = serialized.includes(answerMarker);
      const sawOnlyRpcInputs = inputCount === 2;
      return fauxAssistantMessage([
        "## Handoff",
        `Status: ${sawHandoff && sawAnswer && sawOnlyRpcInputs ? "complete" : "failed"}`,
        "Summary:",
        `- ${sawHandoff && sawAnswer && sawOnlyRpcInputs ? `Integrated ${childMarker} after ${answerMarker}; RPC_INPUT_COUNT_${inputCount}` : `MISSING_HANDOFF_OR_ANSWER; RPC_INPUT_COUNT_${inputCount}`}`,
        "Files:",
        "- None.",
        "Verification:",
        "- Deterministic faux provider context inspection.",
        "Risks/Blockers:",
        "- None.",
        "Next:",
        "- None.",
      ].join("\n"));
    },
  ]);
  pi.registerProvider(faux.provider);

  let runningChildren = 1;
  (globalThis as any)[Symbol.for("pi-subagents/running-children-count")] = () => runningChildren;
  (globalThis as any)[Symbol.for("pi-subagents/running-children-names")] = () =>
    runningChildren ? ["offline-child"] : [];

  let delivered = false;
  pi.on("agent_settled", () => {
    if (delivered) return;
    delivered = true;
    runningChildren = 0;
    pi.sendMessage(
      {
        customType: "subagent_result",
        content: [
          "## Handoff",
          "Status: complete",
          "Summary:",
          `- ${childMarker}`,
          "Files:",
          "- child.ts",
          "Verification:",
          "- offline fixture",
          "Risks/Blockers:",
          "- None.",
          "Next:",
          "- Integrate this result.",
        ].join("\n"),
        display: true,
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  });
}
