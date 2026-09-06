# pi-interactive-subagents

Async subagents for [Pi](https://github.com/earendil-works/pi). Spawn a sub-agent, keep working in the main session, and get the result steered back when it finishes. Fully non-blocking.

Each sub-agent runs in an isolated background process controlled through Pi's RPC protocol. The parent terminal stays responsive while the widget, messaging, sandbox, session resume, and automatic result delivery continue in the main session.

## How it works

`subagent()` returns immediately. The child runs in the background, with output captured beside its launch script. A live widget above the input tracks every running sub-agent, and when one finishes, its result is steered into the main session as a notification that triggers a new turn.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  scout      active · bash 7m                 │
│ 00:45  scout-2    waiting 2m                       │
╰────────────────────────────────────────────────────╯
```

Spawn several in parallel — they run concurrently and steer results back independently as each finishes.

## Tools

| Tool | Description |
| --- | --- |
| `implementation_route` | Advisory direct/delegated/SDD route selection from explicit scope facts |
| `subagent` | Spawn a sub-agent in an isolated background process (async) |
| `subagent_message` | Message a sub-agent by name — steers it if running, resumes its session if finished |
| `subagents_list` | List available agent definitions and their effective capabilities |
| `ask_question` | *(sub-agent sessions only)* Ask the orchestrator a question and wait for the reply |

There is also a `/subagent <agent> <task>` command for spawning directly.

### Implementation routing

Use `implementation_route` when the smallest safe route is not obvious. It is advisory only: it does not inspect the repository, launch a child, edit files, or create SDD artifacts.

- **direct** — the work is bounded enough for focused inspection and implementation in the current session. Unfamiliarity, file counts, and bounded ambiguity do not by themselves trigger delegation; ask one focused question when needed.
- **delegated** — exploration is genuinely broad, research spans multiple sources, or an independent work item benefits from separate context. Delegate a narrow action and integrate its result.
- **sdd** — the user explicitly requested SDD, or durable planning artifacts would materially reduce uncertainty. A proposal requires explicit user acceptance.

The tool requires the orchestrator to provide scope facts instead of pretending that the router can infer them:

```typescript
implementation_route({
  task: "Add the bounded parser test",
  alreadyUnderstood: true,
  filesToUnderstand: 1,
  filesToImplement: 1,
  mechanical: false,
  broadExploration: false,
  independentWork: false,
});
```

`alreadyUnderstood`, `filesToUnderstand`, and `filesToImplement` remain available as informational facts for existing consumers. Delegation is selected only from the explicit `broadExploration`, broad `needsResearch`, or `independentWork` signals.

`subagents_list` reports each profile's runtime, effective tool allowlist, skills, nested spawn targets, and missing extension diagnostics. Restricted launches validate extension-backed tools before creating a child surface or session; a missing capability fails closed.

### Spawning

```typescript
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });
```

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `agent` | string | required | Which agent to spawn (must be known and permitted) |
| `task` | string | required | Task prompt |
| `name` | string | agent name | Display name for the process and widget. Must be unique — duplicates are auto-suffixed (`scout`, `scout-2`, …) |
| `model` | string | agent's model | Override the model for this spawn. Worker requests for Astra are treated as reserved escalation. |
| `useAstraXhigh` | boolean | `false` | Worker-only reserved escalation to Astra at `xhigh`; every activation asks the user and no-UI sessions are refused |
| `cwd` | string | agent's `cwd` | Working directory (see [Role folders](#role-folders)) |

### Messaging

`subagent_message` is addressed **by name only**. Names are unique per session and persist after a sub-agent finishes, so the same name works either way:

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
```

- **Running** — the message is sent to the background process over RPC (newlines flattened) and picked up at the next turn boundary. The call returns immediately; the eventual completion still arrives as a steer message.
- **Finished** — the session is resumed with the message as the follow-up task, like a fresh spawn: fire-and-forget, always autonomous, result steered back later. The resumed run reclaims its original name.

Every spawn records name → session file in `artifacts/<sessionId>/subagent-registry.json`, so names stay addressable across pi restarts. A nested sub-agent that spawns children gets its own registry keyed by its own session id. Resume is refused with a clear error (listing known names) if the name isn't registered, the session file is gone, or the session predates sandboxed resume.

**Resume replays the original sandbox.** At spawn time the fully-resolved loadout — tool allowlist, backing extensions, model, thinking level, system prompt, spawn whitelist, cwd — is snapshotted to `<session>.loadout.json`. Resume rebuilds the exact same restricted process from that snapshot rather than relaunching unrestricted.

### ask_question

A sub-agent can ask its orchestrator one focused question only when a material ambiguity or blocker prevents safe progress, or a coordinator-only decision is required. Resolve local, reversible choices without asking for routine confirmation. The session **stays open** (parked as `waiting`) instead of exiting; the parent is notified with the sub-agent's name, replies via `subagent_message({ name, message })`, and the reply arrives as the sub-agent's next turn. Each sub-agent may have one pending question; a second one is rejected instead of replacing the first. Parallel questions are supported — each waiting sub-agent has its own name.

If the reply arrives while the sub-agent is still mid-turn, it is absorbed into the current turn — either way the question is marked answered and the session exits normally when the work is done. If the parent never replies, the background process stays open until it is terminated. Only available inside sub-agent sessions.

### Structured handoffs

Every launch asks the child to finish with a concise `## Handoff` footer containing `Status`, `Summary`, `Files`, `Verification`, `Risks/Blockers`, and `Next`. The parent receives the parsed footer in the result details when the child follows the format. An unstructured response is preserved as `unknown`; the extension never invents completion, file changes, or verification claims.

## Bundled agents

| Agent | Model | Thinking | Tools | Role |
| ----- | ----- | -------- | ----- | ---- |
| **scout** | `openai-codex/gpt-5.6-luna` | `max` | `read`, `grep`, `find`, `ls` | Fast read-only codebase recon |
| **researcher** | `openai-codex/gpt-5.6-luna` | `max` | `read`, `safe_bash` | Web research through sandboxed HTTP/search commands, synthesized into a sourced brief |
| **worker** | `openai-codex/gpt-5.6-sol` | `high` | `read`, `write`, `edit`, `bash` + spawning | General implementer; may spawn `scout` and `researcher` |

All three are autonomous (`auto-exit: true`) and carry their identity in the system prompt (`system-prompt: append`). For reserved worker tasks, `useAstraXhigh: true` requests `openai-codex/gpt-6-astra` at `xhigh`; the extension always asks the user before activation, including on resume, and refuses when interactive confirmation is unavailable.

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Discovery priority: **project > global > package-bundled** — a project-local file overrides a bundled agent with the same name.

```markdown
---
name: my-agent
description: Does something specific
model: openai-codex/gpt-6-astra
thinking: medium
tools: read, edit, write, safe_bash
session-mode: lineage-only
auto-exit: true
---

You are a specialized agent that does X...
```

### Frontmatter reference

| Field | Type | Description |
| ----- | ---- | ----------- |
| `name` | string | Agent name (used in `agent: "my-agent"`) |
| `description` | string | Shown in `subagents_list` |
| `model` | string | Default model |
| `thinking` | string | `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `tools` | string | Strict tool allowlist. Built-ins: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. Extension-backed: `web_search`, `web_fetch`, `safe_bash`, `video_extract`, `youtube_search`, `google_image_search`. Only the extensions backing the listed tools are loaded into the child; if a declared extension is unavailable, spawning fails with a diagnostic instead of silently granting an incomplete loadout |
| `subagent_agents` | string | Comma-separated agent names this agent may spawn. **Presence of this field grants the spawning toolset** (`subagent`, `subagent_message`, `subagents_list`) and restricts spawn targets to the list. Omit it and the agent cannot spawn at all |
| `skills` | string | Comma-separated skill names to auto-load |
| `session-mode` | string | `standalone` (default), `lineage-only`, or `fork` — see below |
| `system-prompt` | string | `append` or `replace`: pass the body as the child's `--append-system-prompt` / `--system-prompt`. Omit and the body is prepended to the task prompt instead |
| `auto-exit` | boolean | Auto-shutdown when the agent finishes (see below) |
| `interactive` | boolean | Whether stall/recovery transitions wake the parent (see below) |
| `cwd` | string | Default working directory |
| `disable-model-invocation` | boolean | Hide from `subagents_list`; still spawnable by explicit name |
| `cli` | string | `claude` runs the agent via the Claude Code CLI instead of pi |

### session-mode

- `standalone` — fresh session, no lineage link to the caller (default)
- `lineage-only` — fresh session with `parentSession` linkage for discovery/fork UX, but no copied turns
- `fork` — child session seeded with the caller's conversation context

### auto-exit

With `auto-exit: true`, the session shuts down when the agent's turn ends — the agent just writes its final message and stops (there is no "done" tool). The last assistant message becomes the summary returned to the parent. Recommended for all autonomous agents.

Notes:

- **Follow-up input does not strand an auto-exit sub-agent.** If the orchestrator sends another message, the session still closes once that turn completes normally; only an abort leaves it open.
- **Auto-exit is suppressed while work is in flight:** the session parks as `waiting` instead of exiting when an `ask_question` is still unanswered, or when the agent's own child sub-agents are still running (a worker can stop after dispatching children and stays open until the last result returns).

### interactive

Controls whether `stalled`/`recovered` status transitions send a steer message to the parent session. Defaults to the inverse of `auto-exit`: autonomous agents get stall pings, while explicitly interactive profiles stay quiet and rely on the widget. Set explicitly to override.

## Tool access control

Access is **whitelist-only**. Every sub-agent process is launched with `--no-extensions` (extension discovery disabled) and `--tools <allowlist>`; only the extensions backing the listed tools are loaded back in explicitly. There is no default toolset and no deny-list — an agent gets exactly what its frontmatter lists. The restriction survives resume via the loadout snapshot.

Spawns must name a known agent at **every** depth. A top-level session may spawn anything discoverable; a sub-agent may only spawn the agents in its `subagent_agents` list (enforced via `PI_SUBAGENT_ALLOWED`). There is no agentless spawn route, so a child can never escalate to a full-toolset profile by omitting its agent.

Extensions can register additional tools for sub-agents at runtime via `registerToolExtension(name, path)` on the `__pi_interactive_subagents` process global. Restricted launches fail clearly when a declared extension-backed tool is unavailable; install or register the extension before using that profile rather than bypassing the whitelist.

## Role folders

`cwd` starts a sub-agent in a directory with its own config, so role-specific setups (CLAUDE.md, skills, extensions) apply:

```
project/
└── agents/
    ├── game-designer/   ← CLAUDE.md, .pi/…
    └── sre/             ← CLAUDE.md, .pi/…
```

```typescript
subagent({ agent: "worker", cwd: "agents/sre", task: "Review the deployment pipeline" });
```

Set a per-agent default with `cwd:` in frontmatter.

## Status widget & configuration

The widget tracks each sub-agent from a runtime activity snapshot written by the child: `starting`, `active` (turn/provider/tool work), `waiting` (open for input or another stage), `stalled` (no valid snapshot for too long), or `running` (fallback). Sub-agent sessions also show their own tools widget — toggle it with `Ctrl+Alt+O`. Completion messages expand with `Ctrl+O`.

Use `/subagents` or `Ctrl+Alt+S` to open a live monitor. It shows each running agent's task, model, current tool and sanitized action, plus recent observable tool and assistant events. Use `/subagent-log <name>` to inspect recent events for a running or completed named session. These views read local activity/session artifacts directly in the TUI; they do not add monitoring output to the parent model's context. Thinking blocks are deliberately excluded.

Status display is configured via `config.json` in the extension directory (copy `config.json.example`; it's gitignored):

```json
{
  "status": { "enabled": true }
}
```

## Compatibility and verification

This package targets `@earendil-works/pi-coding-agent` and `pi-tui` 0.85.0 with `typebox` 1.3.7.

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:integration
npm run test:smoke
```

The integration command runs process-only coverage by default; live model tests remain opt-in. The smoke test loads every extension entry point through Pi's real extension loader and exercises `safe_bash` without invoking a model.

### Opt-in live child-process integration

The seven live cases exercise structured result delivery, `ask_question` plus name-addressed reply, finished-session resume, startup failure, parallel delivery, agent/schema discovery, and cwd/session placement. The parent is a **synthetic in-process `ExtensionAPI` driver**; only the children are real Pi processes using JSONL RPC. This is not an E2E test of the parent Pi loader, parent RPC protocol, or TUI/UI. It needs neither Orca nor tmux.

Each test creates a private temporary `PI_CODING_AGENT_DIR` and a separate synthetic parent session directory. Child sessions use Pi's normal cwd-keyed storage beneath that temporary config. The harness never discovers or copies credentials or models from the active home. To opt in, the executor may select only these concrete files:

- `PI_TEST_AUTH_FILE` → copied opaquely to temporary `auth.json`
- `PI_TEST_MODELS_FILE` → copied opaquely to temporary `models.json`

Either file is optional when environment credentials and the built-in model catalog suffice. Contents are never parsed or printed by the harness. Child processes are terminated before cleanup; fixture deletion failures fail the test and report the retained private fixture path instead of silently leaving secrets behind.

Live calls are never enabled by `npm run test:integration` alone. To run the minimum one-child/one-turn pilot, explicitly select a non-reserved model and, only if needed, concrete config files:

```bash
# POSIX shells
PI_TEST_MODEL=openai-codex/gpt-5.6-sol \
PI_TEST_AUTH_FILE=/explicit/path/to/auth.json \
npm run test:live:pilot
```

```powershell
# PowerShell
$env:PI_TEST_MODEL = "openai-codex/gpt-5.6-sol"
$env:PI_TEST_AUTH_FILE = "C:\explicit\path\to\auth.json"
# Optional when the selected model needs a custom catalog:
# $env:PI_TEST_MODELS_FILE = "C:\explicit\path\to\models.json"
npm run test:live:pilot
```

The pilot defaults to a 60-second per-test deadline. Set `PI_TEST_TIMEOUT` between `15000` and `120000` milliseconds if needed. The runner refuses Astra/xhigh models. It sets `PI_OFFLINE=1` only to suppress Pi startup update/package/telemetry traffic; the live prompt still calls and consumes the explicitly selected model provider.

After the pilot is reviewed, the full seven-case suite can be enabled with `PI_RUN_LIVE_SUBAGENT_TESTS=1`, an explicit non-reserved `PI_TEST_MODEL`, and `npm run test:integration`. Keep `--test-concurrency=1`; the fixtures temporarily set process-wide cwd/config variables.

Verified on native Windows with Pi 0.85.0 and `openai-codex/gpt-5.6-sol`: one-child pilot passed, then all seven cases passed in approximately 36.5 seconds. No terminal-host APIs were used; this does not certify Herdr, other operating systems, or the parent UI. Explicit config copies and test sessions were temporary. Offline coverage includes 177 unit cases, 14 local integration checks and 3 loader/compatibility checks.

The startup-failure case reproduced a launcher bug: printing the completion marker could hide a failed command behind the shell's final zero exit status. Launch and resume scripts now preserve the command status after printing that marker; a model-free subprocess regression covers exit codes 0, 7 and 127.

Extensions may register their own backing file through `globalThis.__pi_interactive_subagents.registerToolExtension(name, path)`. An explicit registration takes precedence over legacy extension-directory discovery, so a packaged tool is not silently replaced by an older file when launching a restricted child. Re-registering the same path is idempotent; conflicting registrations are rejected, and a missing explicitly selected file blocks launch rather than falling back. Registration is not a sandbox for extension code.

## Requirements

- [Pi 0.85.0](https://github.com/earendil-works/pi)
- A compatible Bash executable for generated launch scripts

On Windows, Git Bash is detected automatically and is the recommended option. Pi itself may be started from Orca's terminal, PowerShell, Command Prompt, Git Bash, or another terminal; the extension launches the child Bash executable independently. Other compatible Bash distributions can be used by setting `PI_SUBAGENT_BASH` to the full executable path.

```powershell
$env:PI_SUBAGENT_BASH = "C:\Program Files\Git\bin\bash.exe"
pi
```

## Acknowledgements

Forked from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), which originated the subagent architecture and status widget; its supervision features were inspired by [RepoPrompt](https://repoprompt.com/).

## License

MIT
