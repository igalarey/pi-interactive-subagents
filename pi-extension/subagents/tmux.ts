/**
 * Subagent surface layer. tmux panes are preferred when available; otherwise
 * commands run as background child processes with RPC input and file-backed
 * output. The fallback has no visible pane, but preserves async execution,
 * steering, status tracking, and result delivery in any parent terminal.
 */
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import {
  closeSync,
  createWriteStream,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
  type WriteStream,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/**
 * True when running inside tmux with the tmux binary on PATH.
 * `TMUX` is set by tmux in every process it spawns (shell or pane).
 */
export function isTmuxAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}

export function isMuxAvailable(): boolean {
  return isTmuxAvailable();
}

function requireTmux(): void {
  if (!isTmuxAvailable()) {
    throw new Error("This surface operation requires pi to run inside tmux");
  }
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Pane layout ──

/**
 * tmux layout applied to the subagent window to keep panes evenly sized.
 * Switchable: "even-horizontal" (equal columns, matches Ctrl+b Alt+1),
 * "main-vertical" (big main pane + tiled column), "tiled" (grid).
 */
const SUBAGENT_TMUX_LAYOUT = "even-horizontal";

let rebalanceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-balance subagent panes so repeated splits don't leave them lopsided.
 * tmux halves the target pane on every split and dumps freed space onto a
 * neighbor on close, so without this panes drift to wildly uneven widths.
 * Applies SUBAGENT_TMUX_LAYOUT to the parent pi window. Debounced so a burst
 * of parallel spawns or staggered exits collapses into a single layout call,
 * and non-fatal: a cosmetic resize must never break spawning or watching.
 */
function rebalanceSurfaces(hintPane?: string): void {
  // Prefer the parent pi pane (stable; survives a closing subagent pane).
  const target = process.env.TMUX_PANE ?? hintPane;
  if (!target) return;
  if (rebalanceTimer) clearTimeout(rebalanceTimer);
  rebalanceTimer = setTimeout(() => {
    rebalanceTimer = null;
    try {
      // -t <pane> resolves to that pane's window; does not change focus.
      execFileSync("tmux", ["select-layout", "-t", target, SUBAGENT_TMUX_LAYOUT], {
        encoding: "utf8",
      });
    } catch {
      // Pane/window may be gone; balancing is best-effort.
    }
  }, 120);
}

// ── Surface primitives ──

type BackgroundSurface = {
  child?: ChildProcess;
  outputFile?: string;
  outputStream?: WriteStream;
  exitCode?: number;
  spawnError?: string;
};

const BACKGROUND_PREFIX = "process:";
const backgroundSurfaces = new Map<string, BackgroundSurface>();

export function isBackgroundSurface(surface: string): boolean {
  return surface.startsWith(BACKGROUND_PREFIX);
}

export function createBackgroundSurface(): string {
  const surface = `${BACKGROUND_PREFIX}${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  backgroundSurfaces.set(surface, {});
  return surface;
}

/**
 * Create a tmux pane when possible, otherwise reserve a background process.
 */
export function createSurface(name: string): string {
  if (!isTmuxAvailable()) return createBackgroundSurface();
  void name; // tmux panes are not named; the pi process inside shows its own title.
  return createSurfaceSplit(name, "right", process.env.TMUX_PANE);
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  void name;
  requireTmux();

  const args = ["split-window", "-d"];
  if (direction === "left" || direction === "right") {
    args.push("-h");
  } else {
    args.push("-v");
  }
  if (direction === "left" || direction === "up") {
    args.push("-b");
  }
  if (fromSurface) {
    args.push("-t", fromSurface);
  }
  args.push("-P", "-F", "#{pane_id}");

  const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
  if (!pane.startsWith("%")) {
    throw new Error(`Unexpected tmux split-window output: ${pane}`);
  }

  rebalanceSurfaces(pane);
  return pane;
}

/**
 * Send a command string to a pane and execute it.
 * Typed literally (`-l`) so special characters are not interpreted as keys,
 * then submitted with Enter.
 */
export function sendCommand(surface: string, command: string): void {
  if (isBackgroundSurface(surface)) {
    const state = backgroundSurfaces.get(surface);
    const stdin = state?.child?.stdin;
    if (!state || !stdin || stdin.destroyed || !stdin.writable) {
      throw new Error("Background subagent input is not writable");
    }
    stdin.write(JSON.stringify({
      type: "prompt",
      message: command,
      streamingBehavior: "steer",
    }) + "\n");
    return;
  }

  requireTmux();
  execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
  execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string; initialInput?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });

  if (isBackgroundSurface(surface)) {
    const state = backgroundSurfaces.get(surface);
    if (!state) throw new Error(`Unknown background surface: ${surface}`);

    const outputFile = `${scriptPath}.log`;
    const outputStream = createWriteStream(outputFile, { flags: "a" });
    const shellScriptPath = process.platform === "win32" ? scriptPath.replace(/\\/g, "/") : scriptPath;
    const child = spawn("bash", [shellScriptPath], {
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    state.child = child;
    state.outputFile = outputFile;
    state.outputStream = outputStream;
    child.stdout?.pipe(outputStream, { end: false });
    child.stderr?.pipe(outputStream, { end: false });
    child.stdin?.on("error", () => {});
    outputStream.on("error", (error) => {
      state.spawnError = `Failed to capture background output: ${error.message}`;
      state.exitCode = 1;
      child.kill("SIGTERM");
    });
    child.once("error", (error) => {
      state.spawnError = error.message;
    });
    child.once("close", (code) => {
      outputStream.end(() => {
        state.exitCode = code ?? (state.spawnError ? 1 : 0);
      });
    });

    if (options?.initialInput) {
      const input = options.initialInput.endsWith("\n")
        ? options.initialInput
        : `${options.initialInput}\n`;
      child.stdin?.write(input);
    }
    return scriptPath;
  }

  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

function readBackgroundOutput(surface: string, lines: number): string {
  const outputFile = backgroundSurfaces.get(surface)?.outputFile;
  if (!outputFile || !existsSync(outputFile)) return "";

  const fd = openSync(outputFile, "r");
  try {
    const size = fstatSync(fd).size;
    const maxBytes = 256 * 1024;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf8").split(/\r?\n/).slice(-Math.max(1, lines)).join("\n");
  } finally {
    closeSync(fd);
  }
}

/**
 * Read the screen or background log contents (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  if (isBackgroundSurface(surface)) return readBackgroundOutput(surface, lines);
  requireTmux();
  return execFileSync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    {
      encoding: "utf8",
    },
  );
}

/**
 * Read the screen or background log contents (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  if (isBackgroundSurface(surface)) return readBackgroundOutput(surface, lines);
  requireTmux();
  const { stdout } = await execFileAsync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8" },
  );
  return stdout;
}

/**
 * Close a pane or terminate a background process tree.
 */
export function closeSurface(surface: string): void {
  if (isBackgroundSurface(surface)) {
    const state = backgroundSurfaces.get(surface);
    const child = state?.child;
    if (child?.pid && child.exitCode === null) {
      try {
        if (process.platform === "win32") {
          execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
        } else {
          process.kill(-child.pid, "SIGTERM");
        }
      } catch {
        child.kill("SIGTERM");
      }
    }
    child?.stdin?.destroy();
    state?.outputStream?.destroy();
    backgroundSurfaces.delete(surface);
    return;
  }

  requireTmux();
  execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
  rebalanceSurfaces();
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    const background = backgroundSurfaces.get(surface);
    if (background?.exitCode !== undefined) {
      return background.spawnError
        ? { reason: "error", exitCode: background.exitCode, errorMessage: background.spawnError }
        : { reason: "sentinel", exitCode: background.exitCode };
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
