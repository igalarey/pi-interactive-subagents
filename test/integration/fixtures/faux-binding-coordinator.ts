import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export default async function (pi: ExtensionAPI) {
  const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(pathToFileURL(process.env.PI_TEST_FAUX!).href);
  const faux = fauxProvider({ provider: 'bindings-faux', models: [{ id: 'local' }] });
  const role = process.env.PI_SUBAGENT_AGENT;
  const capture = (context: unknown) => appendFileSync(process.env.PI_TEST_CAPTURE!, JSON.stringify({ phase: process.env.PI_TEST_PHASE, role, context, tools: pi.getActiveTools() }) + '\n');
  const first = role === 'coordinator'
    ? fauxToolCall('subagent', { agent: 'specialist', name: `specialist-${process.env.PI_TEST_PHASE}`, task: 'Use the approved specialist tool.' })
    : fauxToolCall('specialist_tool', {});
  faux.setResponses([
    (context: unknown) => { capture(context); return fauxAssistantMessage(first, { stopReason: 'toolUse' }); },
    ...Array.from({ length: 8 }, () => (context: unknown) => { capture(context); return fauxAssistantMessage(`${role} complete`); }),
  ]);
  pi.registerProvider(faux.provider);
  pi.on('session_start', (_event, ctx) => {
    appendFileSync(process.env.PI_TEST_MODES!, JSON.stringify({ role, mode: ctx.mode, stdin: process.stdin.isTTY, stdout: process.stdout.isTTY }) + '\n');
  });
}
