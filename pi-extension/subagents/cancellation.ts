export interface CancellableSubagent {
  name: string;
  surface: string;
  abortController?: AbortController;
}

export function cancelOwnedSubagent(
  name: string,
  agents: Iterable<CancellableSubagent>,
  close: (surface: string) => void,
): void {
  const matches = Array.from(agents).filter(agent => agent.name === name);
  if (matches.length !== 1) throw new Error(`No running subagent with unique name: ${name}`);
  const target = matches[0];
  if (!target.abortController) throw new Error(`Subagent is still launching: ${name}`);
  close(target.surface);
  target.abortController.abort();
}
