# pi-interactive-subagents

Async subagents for [Pi](https://github.com/earendil-works/pi). Spawn a sub-agent, keep working in the main session, and get the result steered back when it finishes. Fully non-blocking.

Each Pi child runs as a separate interactive TUI process, not an RPC child.
The Herdr backend creates one native pane per child. The Linux process backend uses a PTY for headless tests.
A private mailbox carries coordinator messages separately from terminal input. Tool restrictions are not an OS sandbox.

## How it works

`subagent()` waits for startup and the bootstrap acknowledgment, then returns without waiting for task completion.
The process backend captures output beside the launch script. The Herdr backend displays the actual Pi TUI.
A live widget tracks running children. Completion notifications return results to the parent and trigger a new turn.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  scout      active · bash 7m                 │
│ 00:45  scout-2    waiting 2m                       │
╰────────────────────────────────────────────────────╯
```

Spawn several in parallel — they run concurrently and steer results back independently as each finishes. A root-session lineage shares one persistent technical launch ledger across every child and grandchild, including resumed runs. The defaults allow depth 2 (root is 0), four active descendant processes total, and unlimited cumulative launches for the lineage.

The launch counter tracks **process launches, including resumes**, not tokens, dollars, or model cost. Pre-spawn failures are refunded; cancellation and processes that actually started consume a launch. The count remains persisted even when cumulative launches are unlimited. Set `maxLaunchesPerLineage` to a non-negative integer for an explicit finite cap; after that cap is exhausted, start a new root session or explicitly change the root configuration. These launcher limits are operational safeguards, not a sandbox against code that bypasses the launcher.

## Tools

| Tool | Description |
| --- | --- |
| `implementation_route` | Advisory direct/delegated/SDD route selection from explicit scope facts |
| `subagent` | Spawn a sub-agent in an isolated background process (async) |
| `subagent_message` | Message a sub-agent by name — steers it if running, resumes its session if finished |
| `subagent_cancel` | Cancel an exact running name owned by this session; preserve files and deliver a cancelled result |
| `subagent_status` | Read owned worker identity and running, finished, or unknown status, with a validated terminal result when available |
| `subagents_list` | List available agent definitions and their effective capabilities |
| `ask_question` | *(sub-agent sessions only)* Ask the orchestrator a question and wait for the reply |

There is also a `/subagent <agent> <task>` command for spawning directly.

### Waiting and cancellation

The monitor explains a parked agent: `parent answer`, `children (N): name…`,
`aborted turn`, or `interactive input`. Named child dependencies are bounded and sanitized.
A completed handoff does not bypass the child-draining guard: a parent stays open while
its children are pending. Repeating a finish instruction does not cancel those children.

Use `subagent_cancel({ name: "worker" })` or `/subagent-cancel worker` to request cancellation.
Only exact names currently owned by this session are accepted; this never resumes a finished
agent and does not accept arbitrary process IDs. Saved files remain untouched; cancellation
is not reported as successful task completion. On Windows the managed process tree is stopped;
on POSIX the surface also enumerates descendants with `ps` because nested surfaces can have
separate process groups. This is process cleanup, not containment of deliberately escaping
processes. Failure to terminate a live surface is reported rather than silently accepted.

Offline regressions cover child-draining, reason display, late settled events after shutdown,
exact-name cancellation, and a real detached descendant with an unaffected sibling. Native
process cancellation was historically exercised on Windows. Current Linux tests cover PTY descendants and cancellation of one Herdr child without stopping its sibling.
These tests do not reproduce or cure provider-side long generation or compaction failures.
Custom profiles can still grant nested delegation; the separate `agent-config` harness now
keeps delegation in the parent by default, so its worker no longer creates hidden descendants.

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
| `model` | string | agent's model, then parent model | Override the model for this spawn. Worker requests for Astra are treated as reserved escalation. |
| `useAstraXhigh` | boolean | `false` | Worker-only reserved escalation to Astra at `xhigh`; every activation asks the user and no-UI sessions are refused |
| `cwd` | string | agent's `cwd` | Working directory (see [Role folders](#role-folders)) |

### Messaging

`subagent_message` is addressed **by name only**. Names are unique per session and persist after a sub-agent finishes, so the same name works either way:

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
```

- **Running** — the private mailbox preserves literal multiline messages. An acknowledgment confirms submission to Pi, not model execution or completion.
- **Finished** — the follow-up starts a new interactive process with the saved session and original name. The result arrives later.

For repository-bound continuation, use the restrictive options:

```typescript
subagent_message({
  name: "project-worker",
  message: "Continue the agreed task",
  resume_only: true,
  expected_cwd: "/absolute/canonical/repository",
  expected_agent: "project-worker",
});
```

`resume_only` refuses a running worker without sending a message. The expected root and profile must match the saved loadout.
`subagent_status({ name })` resolves only workers registered to the current parent session.
A running process or pending resume takes precedence over an earlier result receipt.
Finished status requires a validated `<session>.result.json` receipt. Missing or invalid evidence returns unknown status.
Results are bounded to 48,000 characters plus a truncation marker.
The runtime emits `interactive-subagents:disposed` only after successful cleanup of its pending launches and owned surfaces.

Every spawn records name → session file in `artifacts/<sessionId>/subagent-registry.json`, so names stay addressable across pi restarts. A nested sub-agent that spawns children gets its own registry keyed by its own session id. Resume is refused with a clear error (listing known names) if the name isn't registered, the session file is gone, or the session predates sandboxed resume.

**Resume replays the original restricted loadout.** Each launch saves its resolved policy to `<session>.loadout.json`.
The snapshot includes tools, extensions, model, thinking level, prompt, spawn targets, and working directory.
Resume reconstructs those restrictions instead of launching an unrestricted process.

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

All three are autonomous (`auto-exit: true`) and carry their identity in the system prompt (`system-prompt: append`). For reserved worker tasks, `useAstraXhigh: true` requests `openai/gpt-6-astra` at `xhigh`; the extension always asks the user before activation, including on resume, and refuses when interactive confirmation is unavailable. Native `openai/gpt-6-astra`, historical `openai-codex/gpt-6-astra`, and bare `gpt-6-astra` remain guarded aliases. Historical saved model IDs are replayed unchanged on resume, and the confirmation names the actual saved model.

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global).
Default discovery priority is **project > global > package-bundled**.
`allowProjectAgents: false` and `includeBundledAgents: false` disable those sources.
The installed `agent-config` policy requires named personal profiles and disables both sources.

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
| `skills` | string or boolean | Comma-separated personal skill names to bootstrap explicitly, or `false` to disable skills |
| `skill_catalog` | string | Comma-separated personal skill names to advertise for selective reading, without bootstrap expansion |
| `extensions` | boolean or `scoped` | `false` disables optional extensions; `scoped` requires explicit tools and binding snapshots, with no ambient discovery |
| `allowed_subagents` | string | `none` disables nested delegation |
| `prompt_mode` | string | `append` or `replace`, compatible with the managed harness profiles |
| `max_turns` | positive integer | Stop incomplete work at this turn limit. A resumed process receives a new budget |
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

With `auto-exit: true`, the session shuts down after Pi reports settled work and pending child dependencies finish.
The agent writes its final message and stops. There is no "done" tool.
The last assistant message becomes the summary returned to the parent. Direct user interaction can keep the TUI open.

Notes:

- **Follow-up input does not strand an auto-exit sub-agent.** If the orchestrator sends another message, the session still closes once that turn completes normally; only an abort leaves it open.
- **Auto-exit is suppressed while work is in flight:** the session parks as `waiting` instead of exiting when an `ask_question` is still unanswered, or when the agent's own child sub-agents are still running (a worker can stop after dispatching children and stays open until the last result returns).

### interactive

Controls whether `stalled`/`recovered` status transitions send a steer message to the parent session. Defaults to the inverse of `auto-exit`: autonomous agents get stall pings, while explicitly interactive profiles stay quiet and rely on the widget. Set explicitly to override.

## Tool access control

Access is **whitelist-only**. Every sub-agent process is launched with `--no-extensions` (extension discovery disabled) and `--tools <allowlist>`; only the extensions backing the listed tools are loaded back in explicitly. There is no default toolset and no deny-list — an agent gets exactly what its frontmatter lists. The restriction survives resume via the loadout snapshot.

Spawns must name a known agent at **every** depth. A top-level session may spawn anything discoverable; a sub-agent may only spawn the agents in its `subagent_agents` list (enforced via `PI_SUBAGENT_ALLOWED`). There is no agentless spawn route, so a child can never escalate to a full-toolset profile by omitting its agent.

Every launch and finished-session resume also acquires a generation-tokened lease in the root lineage ledger. The depth, active-process count, and cumulative launch count are checked under one cross-process file lock, so grandchildren cannot reset the accounting in their own process. Releases are token-checked to prevent stale completion/cancellation races from deleting a retry's lease; failed process termination retains capacity, and abandoned owners are reclaimed conservatively without refunding launches. Linux process-start ticks disambiguate PID reuse; platforms without a comparable identity retain ambiguous live-PID capacity rather than claiming the PID is the original process. Existing lineage files retain usage across Pi restarts, inherited children cannot recreate a missing ledger or loosen its root policy, and corrupt accounting is refused rather than reset. On normal root initialization, the current root configuration is applied without clearing usage, descendants, or active leases; this migrates an old default finite ledger to the current unlimited default.

### Crash-released lineage mutex (protocol 2)

Lineage mutation uses the installed Node `node:sqlite` builtin as an OS-managed mutex, not as the accounting store. The JSON ledger, generation-tokened leases, launch counts and conservative abandoned-lease reconciliation are unchanged. Each operation opens a connection, acquires `BEGIN IMMEDIATE`, performs the existing atomic JSON update, then rolls back the mutex transaction and closes the connection. Process death releases the SQLite lock without deleting files. A kill after the JSON rename preserves the recorded launch; it does not refund accounting or fabricate completion.

The root creates a permanent `<ledger>.lock/` fence containing `protocol.json` and `mutex.sqlite`. Descendants cannot initialize or migrate it. Concurrent initializers wait for the marker, published only after database initialization. Unknown protocols, incomplete initialization, legacy-held lock directories, missing databases and symlinked protocol objects fail closed; none are reclaimed or repaired automatically. The existing one-second acquisition deadline remains, with zero SQLite busy-wait and asynchronous contention retries. Live paused owners are never reclaimed, regardless of age. Do not delete or replace the fence or database: doing so can split ownership between two locks.

A root can initialize the new fence for an unfenced legacy JSON ledger without resetting its accounting. Older mkdir-lock runtimes refuse the permanent fence, including when no transaction is active. **Transparent in-flight rollback is unsupported.** Back up the JSON ledger and complete fence together only after all owning processes have stopped; do not remove the fence to make an older runtime enter. Interrupted fence initialization requires explicit investigation and remains fail-closed, even if the initializer is dead. No automatic or manual lock-repair command is provided.

This requires a Node runtime exposing `node:sqlite`; absence is an explicit error with no alternate locking backend. Verified with Node 22.23.2 / SQLite 3.51.3 and official Pi 1.5.0 on Linux; Node currently labels this builtin experimental. The implementation uses SQLite's cross-platform locking rather than a Linux-only executable, but Windows execution has not been verified. Use local filesystems supporting SQLite file locking; network-filesystem locking and machine power-loss durability are not certified. Identity checks reject obvious file aliases/replacements; they are not an OS security boundary against a same-user process concurrently tampering with files.

Extensions can register additional tools for sub-agents at runtime via `registerToolExtension(name, path)` on the `__pi_interactive_subagents` process global. Restricted launches fail clearly when a declared extension-backed tool is unavailable; install or register the extension before using that profile rather than bypassing the whitelist.

## Role folders

With project profiles enabled, `cwd` can select a directory with role-specific configuration:

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

When `allowProjectAgents` is false, `cwd` changes only the working directory.
It cannot replace personal configuration or move session storage into the project.
Resume rejects a saved non-personal agent directory under this policy.

## Status widget & configuration

The widget tracks each sub-agent from a runtime activity snapshot written by the child: `starting`, `active` (turn/provider/tool work), `waiting` (open for input or another stage), `stalled` (no valid snapshot for too long), or `running` (fallback). Sub-agent sessions also show their own tools widget — toggle it with `Ctrl+Alt+O`. Completion messages expand with `Ctrl+O`.

Use `/subagents` or `Ctrl+Alt+S` to open a live monitor. It shows the active descendant tree across the whole root lineage, with stable IDs, nesting depth, per-parent active child counts (`↳N`), task, model, current tool, sanitized action, and bounded observable events. Use arrow keys to select and collapse/expand branches. Counts remain visible whenever descendants are active, not only while an agent is waiting. Use `/subagent-log <name>` to inspect recent events for a directly owned running or completed named session. These views do not add monitoring output to the parent model's context. Thinking blocks are deliberately excluded.

### Historical snapshot viewer

The optional snapshot viewer is separate from the native Herdr execution backend.
It displays snapshots, not an interactive child. The installed harness disables this viewer.

In Pi's fullscreen mode, clicking a descendant widget row opens or focuses one Herdr tab for that stable descendant ID when `HERDR_ENV=1` and the viewer is enabled. The tab is explicitly scoped to `HERDR_WORKSPACE_ID`, preserves the caller's working directory, and runs only `viewer-runtime.mjs` against a bounded sanitized snapshot; it never starts or attaches a second Pi process, sends input, invokes a model, exposes hidden reasoning, or browses arbitrary sessions. Completed, failed, and cancelled owners write a terminal snapshot; an owner that disappears without doing so ages into a visible stale/disconnected state. Concurrent clicks are idempotent, and retired Pi sessions cannot perform a late run/focus. If Herdr is absent or the viewer is disabled, the same click falls back to Pi's bounded ownership-aware snapshot overlay; regular terminal mode keeps `/subagents` and `Ctrl+Alt+S` because Pi 0.85.1 routes widget mouse input only in fullscreen mode. Herdr failures are reported without affecting subagent execution.

On Windows, shell quoting is fail-closed and `PI_SUBAGENT_HERDR_SHELL` is required. Set it to `powershell` or `git-bash` to describe the shell Herdr is configured to use for **new tabs**. The caller's inherited `SHELL` is not authoritative and is never inferred because it may differ from that new-tab shell; `cmd.exe` is unsupported because `%VAR%` expansion cannot safely preserve arbitrary paths. Shell selection, the absolute `process.execPath`, and every quoted path are validated before `tab create`, so missing or invalid configuration creates no tab. A successful `pane run` only confirms command-text submission, not that Node started or the viewer became ready; diagnose runtime failures by reading the test-owned pane during the coordinated manual smoke. The viewer never falls back silently to a bare `node` resolved by the pane shell.

### Native Herdr backend and personal policy

Herdr launches Pi directly in a core-owned PTY, without tmux, `script`, an RPC child, or a transcript viewer.
The target comes from the caller's Herdr terminal or an explicit existing `PI_SUBAGENT_HERDR_TAB`.
There is no fallback to the focused pane. Startup waits for the child TUI and pane adoption before submitting the task.
Cancellation and cleanup operate only on owned surfaces.

Configuration precedence is an absolute `PI_SUBAGENTS_CONFIG` path, personal `subagents.json`, then package defaults.
The personal file lives under `PI_CODING_AGENT_DIR`, or `~/.pi/agent` when that variable is absent.
An invalid explicit configuration fails instead of falling back.
Do not edit sealed packages. `config.json.example` provides packaged defaults, with package-local `config.json` retained for compatibility.

The installed harness uses this policy:

```json
{
  "status": { "enabled": true },
  "delegation": {
    "maxDepth": 1,
    "maxConcurrentDescendants": 6,
    "maxLaunchesPerLineage": null
  },
  "herdrViewer": { "enabled": false },
  "surfaceBackend": "herdr",
  "includeBundledAgents": false,
  "allowProjectAgents": false,
  "requireProfile": true
}
```

`maxLaunchesPerLineage: null` explicitly means there is no cumulative process-launch policy cap. A non-negative integer retains the finite-cap behavior used by older version-one configs and ledgers. Depth and active-descendant limits remain finite. The existing 10,000-record bound on distinct persisted descendant identities remains a metadata resource guard: at capacity a new identity is rejected before mutation, while an existing identity can still resume and increment its accounting.

### Optional two-level coordination limit

`delegation.maxConcurrentChildren` is an optional integer from 0 to 10,000. It caps active immediate children **per non-root parent**, not the root's direct children. Reservations (including children not yet spawned) and resumes count under the same ledger lock as the global descendant/depth checks. Releasing a lease frees capacity; it does not reset launch accounting. Inherited processes use the root ledger's policy and cannot override it. Existing version-one ledgers without this field retain their previous behavior.

For a future depth-two policy, the root can explicitly configure `maxDepth: 2`, `maxConcurrentDescendants: 6`, and `maxConcurrentChildren: 2`. This runtime change does not install or activate that policy. Existing root-authorized policy updates remain supported; descendants cannot change limits.

### Selective personal skills

Restricted Pi profiles now disable automatic skill discovery. `skills: name-one, name-two` (or the existing singular `skill` alias) selects only those personal skills, while preserving the existing named bootstrap messages. `skills: false` still disables all skills. An omitted selection, or `skills: true`, does not grant discovery to a restricted profile. Intentionally unrestricted launches without a named selection retain their previous discovery behavior.

A named skill must be a valid `<name>/SKILL.md` under the personal `PI_CODING_AGENT_DIR/skills` (default `~/.pi/agent/skills`) or `~/.agents/skills`, in that order. Names use lowercase letters, numbers and single hyphens, up to 64 characters. Missing, malformed, mismatched-name and escaping symlink selections fail closed before child creation; project/cwd skill directories and package/settings discovery are not consulted. Invalid higher-priority selections do not fall back to another location.

The loadout saves the skill policy and explicit paths. Launch/resume passes `--no-skills` plus one supported Pi `--skill <file>` per selected skill, and resume revalidates the saved paths rather than selecting from a changed profile. Files are not content-pinned: edits to an approved personal skill are visible on resume. Missing/malformed snapshots still refuse resume; legacy restricted snapshots without skill metadata resume with discovery disabled and no selected skills. Tool-extension permissions remain controlled by the existing tool allowlist, not by skills.

`skill_catalog: name-one, name-two` advertises selected personal skills through Pi's normal name/description/path listing, without adding their procedures to the task. It uses the same personal-only resolution and validation as `skills`. Catalog-only profiles need not set `skills`. The loadout keeps bootstrap paths in `skillPaths` and catalog paths separately in `skillCatalogPaths`; the deduplicated union is passed with explicit `--skill` flags, but only `skills` produces bootstrap messages. A name present in both lists is explicitly bootstrapped. Legacy snapshots without `skillCatalogPaths` have an empty catalog.

`skills: false` conflicts with a declared `skill_catalog` and is rejected. A catalog entry with `disable-model-invocation: true` is rejected rather than silently hidden from the model. Catalogs do not grant tools or read files on behalf of the model: an allowed read tool is still needed to fetch a procedure. Resume uses saved paths, not edited profile declarations; missing or invalid saved catalog files fail closed just like bootstrap files. Descriptions and bodies remain file-backed, not content-pinned.

Offline regression coverage exercises selection, project-shadow exclusion, invalid/missing skills, escaping symlinks, saved-loadout replay, legacy fail-closed behavior, and the SDK resource loader with discovery disabled. Pi 1.5 CLI parsing and resource-loader source confirm `--no-skills` permits explicitly supplied `--skill` paths. `test/integration/selective-skills-tui.test.ts` additionally runs real offline Pi TUI launch/resume with a synthetic provider: it verifies explicit bootstrap, catalog descriptions/paths without procedure expansion, one selective read, malicious trusted-cwd skill exclusion, snapshot preservation after profile edits, and refusal when a selected catalog file disappears. Set `PI_TEST_CLI` to the installed Pi 1.5 `dist/cli.js` to enable it; no credentials are used.

### Scoped profile rollout gate

`extensions: scoped` is a Pi-only, fail-closed profile mode. It requires a nonempty explicit `tools` declaration (implicit defaults from `allowed_subagents: none` do not satisfy it). Optional extension grants come only from declared tools through the validated binding snapshot. A builtins-only scoped profile loads no optional provider; lifecycle/control extensions remain the existing fixed runtime support. Existing `extensions: true` and `extensions: false` semantics are unchanged.

Scoped loadouts persist `extensionPolicy: "scoped"`. Both `extensionBindings` and `extensionBindingProfiles` are mandatory, including explicit empty maps for a builtins-only profile. A missing map or null/empty tool scope invalidates the snapshot; resume never treats it as a legacy loadout or substitutes ambient registrations. Later edits changing a profile to `extensions: true` do not change its saved scoped replay. Catalog selection remains separate from procedure bootstrap.

This syntax also gates old loaded runtimes: the sealed `f049ad72cbc88003f59f5033a5d60a235f62eae5` parser explicitly rejects values other than `true`/`false`. The isolated sealed-source regression verifies the release manifest and copied source hashes, then proves parser and launch refusal under the original managed policy (`requireProfile: true`, `includeBundledAgents: false`, `allowProjectAgents: false`, process backend). It does not claim arbitrary older permissive configurations are safe. The sealed artifact is read-only; the test runs one verified copy in an isolated subprocess, not a duplicate runtime in the real parent.

Run the current scoped TUI regression with `PI_TEST_CLI` set to the installed Pi 1.5 `dist/cli.js`. Enable `test/integration/sealed-scoped-rejection.test.ts` with `PI_TEST_SEALED_SUBAGENTS` set to the original release's `packages/pi-interactive-subagents` directory. Tests use synthetic providers or a launch sentinel, never credentials/live models.

### Persisted extension bindings and nested lookup

New restricted Pi loadouts save two optional fields together:

```ts
extensionBindings?: Record<string, string>; // tool name -> absolute existing backing file
extensionBindingProfiles?: Record<string, {
  toolAllowlist: string;
  spawnable: string[];
}>;
```

The flat binding map contains exactly the custom tools needed by the child's own `toolAllowlist` and the reachable closure of its permitted spawnable profiles. Built-in, lifecycle/control and route-selector names are reserved and cannot appear as binding keys. The profile map pins tool/spawn ceilings for that closure; unrelated ambient registrations are excluded. Every snapshotted descendant needs an explicit non-null tool scope and must use Pi. A later profile edit may narrow its scope, but adding tools or spawn targets—including making a formerly non-delegating specialist delegate—is refused before launch. Resume checks the saved scope and preserves its exact backing paths, not replacement ambient registrations.

Only paths required by the current child's own tools receive `-e`. Descendant mappings enable lookup, not current tool permissions, and propagating a mapping never executes its module. Global extension discovery remains disabled. A missing backing file anywhere in the saved closure fails closed; there is no ambient substitution for an explicit snapshot, even an empty one.

At `session_start`, restoration reads the existing `PI_SUBAGENT_SESSION` sidecar only after its path matches the actual SDK session, its saved agent/config directory matches the child identity/config, and its session/agent/depth/id matches an active record in the inherited root lineage. Invalid restoration also blocks later binding lookup/dispatch. There is no additional environment authorization list. This is a runtime permission contract, not an OS sandbox against an actor who can edit all of the same user's session/ledger files. Backing file contents are not hashed or pinned.

Both binding fields absent means a legacy loadout: existing own-tool allowlist replay remains supported with its previous per-tool resolution, but the child gains no inherited registry or descendant scope from current ambient registrations. Both fields present means explicit scope; empty maps are not legacy. A legacy coordinator needs a fresh launch to obtain validated descendant bindings.

Names in binding maps/scopes are 1–100 ASCII letters/digits/underscores/hyphens, starting with a letter; prototype-related names are rejected. Limits are 256 bindings, 100 profiles, 256 tools per allowlist, 8,192 characters per allowlist, 32,768 per path, and 48 KiB for the serialized pair of maps (within the existing 64 KiB sidecar bound). Malformed scopes, relative paths, reserved keys, missing mappings and mappings outside the saved scope are rejected. Root-owned depth/global/per-parent ledger limits remain independent and authoritative.

The existing shared registration API is unchanged:

```ts
const registry = globalThis[Symbol.for("pi.subagents.tool-extension-registry")];
registry.registerToolExtension(toolName, absoluteExistingBackingFile);
registry.capabilities; // frozen object on the frozen registry:
// { version: 1, personalSkillCatalog: true,
//   perParentChildLimit: true, persistedExtensionBindings: true,
//   scopedExtensionProfiles: true }
```

Hosts can require these exact feature markers before dispatching new coordinating profiles, failing closed with restart/upgrade guidance when an old loaded runtime lacks them. This does not add a tool, import a second runtime, or activate an installed profile.

`test/integration/extension-bindings-tui.test.ts` runs official Pi 1.5 TUI coordinator → specialist launches and coordinator resumes using an isolated faux provider, with depth 2 / global 6 / per-parent 2. It checks own versus descendant extension loading, exclusion of unrelated/global extensions, specialist non-delegation, tool/spawn profile ceilings, saved mappings and missing dependencies. `test/extension-bindings.test.ts` additionally checks ambient-path replacement versus saved-path replay, malformed/oversized snapshots, forged session/identity/config/lineage contexts, explicit-empty versus legacy fields, and the frozen feature marker.

## Compatibility and verification

Package dependency metadata remains pinned to Pi 0.85.1 and `typebox` 1.3.7.
The current interactive transport and installed harness are verified on Linux with Pi 1.5.0 and Node 22.23.2.
The legacy SDK smoke checks loading, not current cross-platform TUI behavior.
The 0.85.0 `pi-server` packaging workaround is no longer required.

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:integration
npm run test:smoke
```

The integration command runs process-only coverage by default; live model tests remain opt-in. The smoke test loads every extension entry point through Pi's real extension loader and exercises `safe_bash` without invoking a model.

### Current offline TUI and Herdr verification

Set `PI_TEST_CLI` to the installed Pi `dist/cli.js` path for the real TUI fixtures:

```sh
PI_TEST_CLI=/absolute/path/to/pi-coding-agent/dist/cli.js \
node --test --test-concurrency=1 \
  test/integration/interactive-tui.test.ts \
  test/integration/project-session-contract.test.ts
```

These tests use synthetic providers and isolated configuration, without account credentials or paid model calls.
They cover multiline delivery, owned results, restrictive resume, pending-resume status, and disposal.
See [interactive transport](test/interactive-transport.md) and [native Herdr panels](test/herdr-panels.md) for prerequisites and commands.
The Herdr test needs explicit desktop-control authorization. Process-only tests do not certify visible panels.
Current Windows TUI behavior and live-provider execution remain unverified.

### Historical live child-process verification

The retained live suite covers result delivery, questions, resume, startup failure, parallel delivery, discovery, and session placement.
Its parent is a synthetic in-process `ExtensionAPI` driver.
The historical Windows verification used RPC children, before the interactive transport migration.
It is historical evidence, not certification of the current TUI transport or parent UI.

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

- [Pi 1.5.0](https://github.com/earendil-works/pi) for the verified interactive transport
- Node 22.23.2 and a compatible Bash executable
- Herdr app and core (`hc`) for native panes
- Linux util-linux `script` for the process-PTY fallback

`PI_SUBAGENT_SURFACE_BACKEND=process` selects the fallback explicitly for isolated tests.
It overrides the configured backend without changing personal configuration.

The historical Windows launcher detects Git Bash automatically.
`PI_SUBAGENT_BASH` can select another compatible Bash executable by its full path.
This setting does not establish Windows support for the current TUI transport.

```powershell
$env:PI_SUBAGENT_BASH = "C:\Program Files\Git\bin\bash.exe"
pi
```

## Acknowledgements

Forked from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), which originated the subagent architecture and status widget; its supervision features were inspired by [RepoPrompt](https://repoprompt.com/).

## License

MIT
