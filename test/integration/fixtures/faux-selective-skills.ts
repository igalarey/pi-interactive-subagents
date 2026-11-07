import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export default async function (pi: ExtensionAPI) {
  const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(pathToFileURL(process.env.PI_TEST_FAUX!).href);
  const faux = fauxProvider({ provider: 'skills-faux', models: [{ id: 'local' }] });
  const capture = (context: unknown) => appendFileSync(process.env.PI_TEST_CAPTURE!, JSON.stringify({
    phase: process.env.PI_TEST_PHASE, context,
    skills: pi.getCommands().filter(command => command.source === 'skill'),
    tools: pi.getActiveTools(),
  }) + '\n');
  faux.setResponses(process.env.PI_TEST_PHASE === 'launch' ? [
    (context: unknown) => { capture(context); return fauxAssistantMessage(fauxToolCall('read', { path: process.env.PI_TEST_SELECTIVE_READ }), { stopReason: 'toolUse' }); },
    (context: unknown) => { capture(context); return fauxAssistantMessage('Selective read complete.'); },
  ] : [(context: unknown) => { capture(context); return fauxAssistantMessage('Resumed with saved skill policy.'); }]);
  pi.registerProvider(faux.provider);
  pi.on('project_trust', () => ({ trusted: 'yes', remember: false }));
  pi.on('session_start', (_event, ctx) => {
    appendFileSync(process.env.PI_TEST_MODES!, JSON.stringify({ mode: ctx.mode, stdin: process.stdin.isTTY, stdout: process.stdout.isTTY }) + '\n');
  });
}
