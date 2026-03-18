/**
 * cmux — pi ↔ cmux integration extension.
 *
 * Lifecycle hooks:
 *   - session_start:     Set "Idle" status, auto-name session via haiku.
 *   - agent_start:       Set sidebar to "Running" (blue bolt).
 *   - tool_execution_start: Live tool activity in sidebar (visible from other workspaces).
 *   - agent_end:         "Needs input" (blue bell) + cmux notification + peon-ping.
 *   - session_shutdown:  Clear status and agent PID.
 *
 * Session naming:
 *   On first user prompt, spawns a cheap haiku call to generate a 2-4 word
 *   session name from the prompt + cwd. Sets it via pi.setSessionName() so
 *   it shows in the footer. Also displayed as the first sidebar status entry
 *   (key "session"). Workspace label is never touched — left to the operator.
 *
 * peon-ping:
 *   If peon-ping is installed, plays notification sounds on agent_end.
 *
 * Tools:
 *   - cmux:        General workspace/pane/surface control — tree, read, send, split, etc.
 *   - cmux_status: Set sidebar status, progress, log entries.
 *   - cmux_notify: Send native notifications to the user.
 *
 * Worker mode (PI_CMUX_ROLE=worker):
 *   Keeps all visibility features (sidebar, notifications, tool activity)
 *   but disables subprocess-spawning features (session naming haiku,
 *   turn summary haiku). Use for agents spawned by an orchestrator.
 *
 * Requires: cmux CLI in PATH and CMUX_SOCKET_PATH env var.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { execSync, execFileSync, spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import * as path from "node:path";

// ── Config ─────────────────────────────────────────────

const STATUS_KEY = "pi_agent";
// Session name — first item under workspace label (sorts before pi_agent).
const SESSION_NAME_KEY = "0_session";
const NAMING_MODEL = process.env.PI_CMUX_NAMING_MODEL || "claude-haiku-4-5";
// Helper pi subprocesses must not reload this extension or they recurse forever.
const CMUX_CHILD_ENV = "PI_CMUX_CHILD";
// Worker mode: full visibility, no subprocess spawns (session naming, turn summaries).
const IS_WORKER = process.env.PI_CMUX_ROLE === "worker";

// SF Symbols + colors matching cmux Claude Code integration
const STATUS_RUNNING = { value: "Running", icon: "bolt.fill", color: "#4C8DFF" };
const STATUS_IDLE = { value: "Idle", icon: "pause.circle.fill", color: "#8E8E93" };
const STATUS_NEEDS_INPUT = { value: "Needs input", icon: "bell.fill", color: "#4C8DFF" };

// ── Fleet tracker (orchestrator only) ──────────────────

interface AgentInfo {
  id: string;
  surfaceRef: string;
  workspaceRef: string;
  model: string;
  cwd: string;
  prompt: string;        // first 200 chars
  status: "starting" | "running" | "idle" | "completed" | "failed";
  spawnedAt: number;
}

const fleet = new Map<string, AgentInfo>();
const MAX_AGENTS = parseInt(process.env.PI_CMUX_MAX_AGENTS || "5");

// ── cmux CLI wrapper ───────────────────────────────────

function cmux(...args: string[]): string {
  try {
    return execFileSync("cmux", args, {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    }).trim();
  } catch (e: any) {
    const msg = e.stderr?.toString().trim() || e.message;
    throw new Error(`cmux ${args[0]} failed: ${msg}`);
  }
}

function cmuxSafe(...args: string[]): string | null {
  try {
    return cmux(...args);
  } catch {
    return null;
  }
}

function hasCmux(): boolean {
  try {
    execSync("which cmux", { encoding: "utf-8", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

// ── peon-ping detection ────────────────────────────────

let peonPath: string | null = null;

function detectPeonPing(): string | null {
  // Check common locations
  const candidates = [
    `${process.env.HOME}/.claude/hooks/peon-ping/peon.sh`,
    `${process.env.HOME}/.openpeon/peon.sh`,
  ];
  for (const p of candidates) {
    try {
      execSync(`test -f "${p}"`, { timeout: 1000 });
      return p;
    } catch {}
  }
  // Check PATH
  try {
    const which = execSync("which peon", { encoding: "utf-8", timeout: 1000 }).trim();
    if (which) return which;
  } catch {}
  return null;
}

function playPeonPing(event: "stop" | "notification"): void {
  if (!peonPath) return;
  try {
    // peon.sh reads hook event type from stdin JSON
    const child = spawn("bash", [peonPath], {
      stdio: ["pipe", "ignore", "ignore"],
      detached: true,
      env: { ...process.env, CLAUDE_HOOK_EVENT_NAME: event === "stop" ? "Stop" : "Notification" },
    });
    child.stdin?.write(JSON.stringify({ event: event === "stop" ? "Stop" : "Notification" }));
    child.stdin?.end();
    child.unref();
  } catch {}
}

// ── Sidebar status helpers ─────────────────────────────

function setStatus(status: { value: string; icon: string; color: string }): void {
  cmuxSafe("set-status", STATUS_KEY, status.value, "--icon", status.icon, "--color", status.color);
  clearBuiltinStatus();
}

function clearStatus(): void {
  cmuxSafe("clear-status", STATUS_KEY);
  // cmux has a built-in claude_code status key that conflicts with ours — always clear it
  cmuxSafe("clear-status", "claude_code");
}

function clearBuiltinStatus(): void {
  cmuxSafe("clear-status", "claude_code");
}

// ── Focus detection ────────────────────────────────────

/** Check if this pi surface is currently focused by the user. */
function isFocused(): boolean {
  try {
    const raw = cmux("identify");
    const info = JSON.parse(raw);
    return info.caller?.surface_ref === info.focused?.surface_ref;
  } catch {
    return false; // can't tell — assume not focused
  }
}

// ── Notification helper ────────────────────────────────

function notify(title: string, body?: string, subtitle?: string): void {
  const args = ["notify", "--title", title];
  if (subtitle) args.push("--subtitle", subtitle);
  if (body) args.push("--body", body);
  cmuxSafe(...args);
}

// ── Session naming ─────────────────────────────────────

function generateSessionName(prompt: string, cwd: string): void {
  const dirName = path.basename(cwd);
  const input = `Project directory: ${dirName}\nFirst prompt: ${prompt.slice(0, 300)}`;

  try {
    const child = spawn("pi", [
      "-p",
      "--model", NAMING_MODEL,
      "--no-session",
      "--no-extensions",
      "--no-tools",
      "--no-skills",
      "--no-prompt-templates",
      "--system-prompt",
      `You are a session namer. Given a project directory and first user prompt, decide whether this session deserves a name.

ONLY name sessions where the user is doing specific, identifiable work. Reply with ONLY the name (2-4 words, no quotes, no explanation, no punctuation) or reply with exactly SKIP if the session doesn't warrant a name.

SKIP when:
- The prompt is vague, conversational, or exploratory ("hey", "help me with something", "what do you think")
- The prompt is a single trivial question or greeting
- You can't tell what the actual work is

NAME when:
- The prompt describes a clear task, feature, bug, or project
- The work is specific enough to distinguish from other sessions

Good names: 'cmux sidebar integration', 'auth refactor', 'deploy pipeline fix', 'test suite cleanup'
Bad names: 'general chat', 'coding session', 'help request', 'project work'`,
    ], {
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 15000,
      env: { ...process.env, [CMUX_CHILD_ENV]: "1" },
    });

    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.stdin?.write(input);
    child.stdin?.end();

    child.on("close", () => {
      const name = output.trim().slice(0, 60);
      if (name && name.length > 1 && name.toUpperCase() !== "SKIP") {
        _pendingSessionName = name;
      }
    });
  } catch {}
}

let _pendingSessionName: string | null = null;
let _hasNamedSession = false;
let _turnCount = 0;
const RENAME_INTERVAL_TURNS = 8;

// ── Session rename at inflection points ────────────────

function reevaluateSessionName(context: string, currentName: string | undefined, cwd: string): void {
  const dirName = path.basename(cwd);
  const input = `Project directory: ${dirName}\nCurrent session name: ${currentName || "(unnamed)"}\n\nRecent work:\n${context.slice(0, 600)}`;

  try {
    const child = spawn("pi", [
      "-p",
      "--model", NAMING_MODEL,
      "--no-session",
      "--no-extensions",
      "--no-tools",
      "--no-skills",
      "--no-prompt-templates",
      "--system-prompt",
      `You are a session renamer. Given a project directory, the current session name, and a summary of recent work, decide if the session name should change.

Reply with ONLY the new name (2-4 words) or reply with exactly KEEP if the current name still fits.

KEEP when:
- The work is still on the same topic as the current name
- The name is already a good description of what's happening
- The shift is minor (same feature, just a different subtask)

RENAME when:
- The work has clearly shifted to a different topic or feature
- The current name no longer describes what's actually happening
- The session started unnamed and now has clear direction

Good names: 'cmux sidebar integration', 'auth refactor', 'deploy pipeline fix'
No quotes, no explanation, no punctuation. Just the name or KEEP.`,
    ], {
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 15000,
      env: { ...process.env, [CMUX_CHILD_ENV]: "1" },
    });

    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.stdin?.write(input);
    child.stdin?.end();

    child.on("close", () => {
      const name = output.trim().slice(0, 60);
      if (name && name.length > 1 && name.toUpperCase() !== "KEEP") {
        _pendingSessionName = name;
      }
    });
  } catch {}
}

// ── Turn summary for sidebar ───────────────────────────

function generateTurnSummary(assistantText: string, cwd: string): void {
  if (!assistantText || assistantText.length < 10) {
    return; // Too short to summarize, keep current status (needs input)
  }

  // Truncate to keep the haiku call cheap
  const truncated = assistantText.slice(0, 800);
  const dirName = path.basename(cwd);

  try {
    const child = spawn("pi", [
      "-p",
      "--model", NAMING_MODEL,
      "--no-session",
      "--no-extensions",
      "--no-tools",
      "--no-skills",
      "--no-prompt-templates",
      "--system-prompt",
      "Summarize what was just done in 3-8 words for a sidebar status. No quotes, no periods. Examples: 'Added cmux extension + tests', 'Fixed auth redirect bug', 'Refactored DB queries', 'Waiting for deploy config'",
    ], {
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 10000,
      env: { ...process.env, [CMUX_CHILD_ENV]: "1" },
    });

    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.stdin?.write(`Project: ${dirName}\nAssistant just said:\n${truncated}`);
    child.stdin?.end();

    child.on("close", () => {
      const summary = output.trim().slice(0, 50);
      if (summary && summary.length > 1) {
        cmuxSafe("set-status", STATUS_KEY, summary, "--icon", "bell.fill", "--color", "#4C8DFF");
      }
    });
  } catch {
    // Fall through — status stays as Idle from the sync call
  }
}

// ── Tool description helper ────────────────────────────

function describeToolUse(toolName: string, args: any): string {
  switch (toolName) {
    case "read":
      return `Reading ${shortenPath(args.path || "")}`;
    case "edit":
      return `Editing ${shortenPath(args.path || "")}`;
    case "write":
      return `Writing ${shortenPath(args.path || "")}`;
    case "bash": {
      const cmd = args.command || "";
      const first = cmd.split(/\s/)[0] || cmd;
      return `Running ${first.slice(0, 30)}`;
    }
    case "grep":
      return `Searching ${args.pattern || ""}`.slice(0, 40);
    case "find":
      return `Finding ${args.pattern || ""}`.slice(0, 40);
    case "web_search":
      return `Searching web`;
    case "codex":
      return `Spawning codex`;
    default:
      return `Using ${toolName}`;
  }
}

function shortenPath(p: string): string {
  const home = process.env.HOME || "";
  if (home && p.startsWith(home)) p = "~" + p.slice(home.length);
  const parts = p.split("/");
  if (parts.length > 3) return "…/" + parts.slice(-2).join("/");
  return p;
}

// ── Heartbeat ──────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 3000;

let _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let _agentStartedAt: number | null = null;
let _lastToolDesc: string | null = null;

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function startHeartbeat(): void {
  stopHeartbeat();
  _agentStartedAt = Date.now();
  _lastToolDesc = null;
  _heartbeatTimer = setInterval(() => {
    if (!_agentStartedAt) return;
    const elapsed = formatElapsed(Date.now() - _agentStartedAt);
    const label = _lastToolDesc || "Thinking";
    cmuxSafe("set-status", STATUS_KEY, `${label} · ${elapsed}`, "--icon", "bolt.fill", "--color", "#4C8DFF");
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
  _agentStartedAt = null;
  _lastToolDesc = null;
}

// ── Extension ──────────────────────────────────────────

export default function cmuxExtension(pi: ExtensionAPI) {
  if (process.env[CMUX_CHILD_ENV] === "1") return;
  if (!hasCmux()) return; // silently skip when not in cmux

  // Detect peon-ping on load
  peonPath = detectPeonPing();

  // ── Lifecycle: session start — clean slate ──
  pi.on("session_start", async (_event, ctx) => {
    _pendingSessionName = null;
    _turnCount = 0;
    const existingName = pi.getSessionName();
    _hasNamedSession = Boolean(existingName);
    // Clear stale state from previous sessions
    cmuxSafe("clear-notifications");
    cmuxSafe("clear-log");
    setStatus(STATUS_IDLE);
    if (existingName) {
      cmuxSafe("set-status", SESSION_NAME_KEY, existingName, "--icon", "text.bubble", "--color", "#8E8E93");
    }
  });

  // ── Lifecycle: user types → instantly clear attention state ──
  pi.on("input", async () => {
    setStatus(STATUS_IDLE);
    cmuxSafe("clear-notifications");
    cmuxSafe("claude-hook", "prompt-submit");
  });

  // ── Lifecycle: first prompt → auto-name session ──
  pi.on("before_agent_start", async (event, ctx) => {
    // Name the session from the first user prompt
    if (!_hasNamedSession && event.prompt) {
      _hasNamedSession = true;

      // If session already has a name (e.g. from /continue), skip
      const existing = pi.getSessionName();
      if (!existing && !IS_WORKER) {
        generateSessionName(event.prompt, ctx.cwd);
      }
    }
  });

  // ── Lifecycle: agent running — clear attention state, start heartbeat ──
  pi.on("agent_start", async () => {
    cmuxSafe("clear-notifications");
    setStatus(STATUS_RUNNING);
    startHeartbeat();

    // Apply pending session name from async haiku call
    if (_pendingSessionName) {
      pi.setSessionName(_pendingSessionName);
      cmuxSafe("set-status", SESSION_NAME_KEY, _pendingSessionName, "--icon", "text.bubble", "--color", "#8E8E93");
      _pendingSessionName = null;
    }
  });

  // ── Lifecycle: tool execution — live status updates (visible from other workspaces) ──
  pi.on("tool_execution_start", async (event) => {
    const desc = describeToolUse(event.toolName, event.args);
    _lastToolDesc = desc;
    // Immediate update — heartbeat will append elapsed time on next tick
    const elapsed = _agentStartedAt ? formatElapsed(Date.now() - _agentStartedAt) : "";
    cmuxSafe("set-status", STATUS_KEY, elapsed ? `${desc} · ${elapsed}` : desc, "--icon", "bolt.fill", "--color", "#4C8DFF");
  });

  // ── Lifecycle: agent done → idle + summary, peon-ping ──
  pi.on("agent_end", async (event, ctx) => {
    stopHeartbeat();
    _turnCount++;
    // Set needs-input immediately (summary will overwrite async, keeping bell icon)
    setStatus(STATUS_NEEDS_INPUT);

    // Extract last assistant message text for summary
    let lastAssistantText = "";
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const msg = event.messages[i] as any;
      if (msg.role === "assistant" && msg.content) {
        for (const block of msg.content) {
          if (block.type === "text" && block.text) {
            lastAssistantText = block.text;
            break;
          }
        }
        if (lastAssistantText) break;
      }
    }

    // Async: generate tiny summary for sidebar (keeps bell icon)
    // Workers skip this — it spawns a child pi process
    if (!IS_WORKER) {
      generateTurnSummary(lastAssistantText, ctx.cwd);

      // Re-evaluate session name every N turns
      if (_turnCount % RENAME_INTERVAL_TURNS === 0 && lastAssistantText) {
        reevaluateSessionName(lastAssistantText, pi.getSessionName(), ctx.cwd);
      }
    }

    // Notify — but only if the user isn't already looking at this surface
    if (!isFocused()) {
      const sessionName = pi.getSessionName();
      notify("pi", sessionName ? `${sessionName} — waiting for input` : "Waiting for input");
      playPeonPing("stop");
    }
  });

  // ── Lifecycle: compaction — natural inflection point for rename ──
  pi.on("session_compact", async (event, ctx) => {
    if (IS_WORKER) return;
    const summary = (event as any).compactionEntry?.summary;
    if (summary) {
      reevaluateSessionName(summary, pi.getSessionName(), ctx.cwd);
    }
  });

  // ── Lifecycle: session shutdown ──
  pi.on("session_shutdown", async () => {
    stopHeartbeat();
    _pendingSessionName = null;
    _hasNamedSession = false;
    _turnCount = 0;
    clearStatus();
    cmuxSafe("clear-status", SESSION_NAME_KEY);
    cmuxSafe("clear-notifications");
    cmuxSafe("clear-progress");
  });

  // ── Apply pending session name between turns ──
  pi.on("context", async () => {
    if (_pendingSessionName) {
      pi.setSessionName(_pendingSessionName);
      cmuxSafe("set-status", SESSION_NAME_KEY, _pendingSessionName, "--icon", "text.bubble", "--color", "#8E8E93");
      _pendingSessionName = null;
    }
  });

  // ────────────────────────────────────────────────────────
  // Tool: cmux — workspace/pane/surface control
  // ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "cmux",
    label: "cmux",
    description: [
      "Control the cmux terminal multiplexer. Actions:",
      "• tree — show workspace/pane/surface hierarchy",
      "• identify — which workspace/surface pi is running in",
      "• list-workspaces — list all workspaces",
      "• read-screen — read terminal content from any surface (--surface, --lines, --scrollback)",
      "• send — send text to a surface (--surface <ref> <text>)",
      "• send-key — send a key to a surface (--surface <ref> <key>)",
      "• new-workspace — create a workspace (--cwd <path>)",
      "• new-split — split pane (left|right|up|down)",
      "• new-pane — create pane (--type terminal|browser, --direction, --url)",
      "• select-workspace — switch workspace (--workspace <ref>)",
      "• close-surface — close a surface",
      "Use refs like surface:1, workspace:2, pane:3. Run 'tree' first to discover refs.",
    ].join("\n"),
    parameters: Type.Object({
      action: Type.String({ description: "cmux command: tree, identify, list-workspaces, read-screen, send, send-key, new-workspace, new-split, new-pane, select-workspace, close-surface, list-panes" }),
      args: Type.Optional(Type.Array(Type.String(), { description: "Additional arguments for the command" })),
    }),

    async execute(_id, params) {
      const action = params.action;
      const args = params.args || [];

      // Allowlist of safe commands
      const allowed = new Set([
        "tree", "identify", "list-workspaces", "current-workspace",
        "read-screen", "send", "send-key",
        "new-workspace", "new-split", "new-pane", "new-surface",
        "select-workspace", "close-surface", "close-workspace",
        "list-panes", "list-pane-surfaces",
        "focus-pane", "rename-workspace",
        "surface-health",
      ]);

      if (!allowed.has(action)) {
        return {
          content: [{ type: "text", text: `Unknown or disallowed action: ${action}\nAllowed: ${[...allowed].join(", ")}` }],
          isError: true,
        };
      }

      try {
        const result = cmux(action, ...args);
        return { content: [{ type: "text", text: result || "OK" }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], isError: true };
      }
    },

    renderCall(args, theme) {
      const cmdArgs = args.args?.length ? " " + args.args.join(" ") : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("cmux")) + " " + theme.fg("accent", args.action) + theme.fg("dim", cmdArgs),
        0, 0,
      );
    },

    renderResult(result, _opts, theme) {
      const txt = result.content[0];
      const text = txt?.type === "text" ? txt.text : "";
      const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const lines = text.split("\n");
      const preview = lines.slice(0, 5).join("\n");
      const suffix = lines.length > 5 ? theme.fg("dim", `\n… ${lines.length - 5} more lines`) : "";
      return new Text(`${icon} ${preview}${suffix}`, 0, 0);
    },
  });

  // ────────────────────────────────────────────────────────
  // Tool: cmux_status — sidebar status, progress, logs
  // ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "cmux_status",
    label: "cmux Status",
    description: [
      "Set cmux sidebar status, progress bar, or log entries.",
      "Actions:",
      "• set-status <key> <value> — set a status entry (optional: icon, color)",
      "• clear-status <key> — clear a status entry",
      "• set-progress <0.0-1.0> — set progress bar (optional: label)",
      "• clear-progress — clear progress bar",
      "• log <message> — add a log entry (optional: level info|warn|error)",
      "• clear-log — clear all log entries",
      "• sidebar-state — get current sidebar state",
    ].join("\n"),
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("set-status"),
        Type.Literal("clear-status"),
        Type.Literal("set-progress"),
        Type.Literal("clear-progress"),
        Type.Literal("log"),
        Type.Literal("clear-log"),
        Type.Literal("sidebar-state"),
      ]),
      key: Type.Optional(Type.String({ description: "Status key (for set-status/clear-status)" })),
      value: Type.Optional(Type.String({ description: "Status value or progress (0.0-1.0) or log message" })),
      icon: Type.Optional(Type.String({ description: "SF Symbol name (e.g. bolt.fill, checkmark.circle)" })),
      color: Type.Optional(Type.String({ description: "Hex color (e.g. #4C8DFF)" })),
      level: Type.Optional(Type.Union([
        Type.Literal("info"),
        Type.Literal("warn"),
        Type.Literal("error"),
      ], { description: "Log level" })),
      label: Type.Optional(Type.String({ description: "Progress bar label" })),
    }),

    async execute(_id, params) {
      try {
        switch (params.action) {
          case "set-status": {
            if (!params.key || !params.value)
              return { content: [{ type: "text", text: "set-status requires key and value" }], isError: true };
            const args = ["set-status", params.key, params.value];
            if (params.icon) args.push("--icon", params.icon);
            if (params.color) args.push("--color", params.color);
            cmux(...args);
            return { content: [{ type: "text", text: `Status ${params.key}=${params.value}` }] };
          }
          case "clear-status": {
            if (!params.key)
              return { content: [{ type: "text", text: "clear-status requires key" }], isError: true };
            cmux("clear-status", params.key);
            return { content: [{ type: "text", text: `Cleared ${params.key}` }] };
          }
          case "set-progress": {
            if (!params.value)
              return { content: [{ type: "text", text: "set-progress requires value (0.0-1.0)" }], isError: true };
            const args = ["set-progress", params.value];
            if (params.label) args.push("--label", params.label);
            cmux(...args);
            return { content: [{ type: "text", text: `Progress: ${params.value}${params.label ? ` (${params.label})` : ""}` }] };
          }
          case "clear-progress":
            cmux("clear-progress");
            return { content: [{ type: "text", text: "Progress cleared" }] };
          case "log": {
            if (!params.value)
              return { content: [{ type: "text", text: "log requires a message" }], isError: true };
            const args = ["log"];
            if (params.level) args.push("--level", params.level);
            args.push("--source", "pi", "--", params.value);
            cmux(...args);
            return { content: [{ type: "text", text: `Logged: ${params.value}` }] };
          }
          case "clear-log":
            cmux("clear-log");
            return { content: [{ type: "text", text: "Log cleared" }] };
          case "sidebar-state": {
            const result = cmux("sidebar-state");
            return { content: [{ type: "text", text: result }] };
          }
        }
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], isError: true };
      }
    },

    renderCall(args, theme) {
      const parts = [args.action];
      if (args.key) parts.push(args.key);
      if (args.value) parts.push(args.value);
      return new Text(
        theme.fg("toolTitle", theme.bold("cmux_status")) + " " + theme.fg("dim", parts.join(" ")),
        0, 0,
      );
    },

    renderResult(result, _opts, theme) {
      const txt = result.content[0];
      const text = txt?.type === "text" ? txt.text : "";
      const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      return new Text(`${icon} ${text}`, 0, 0);
    },
  });

  // ────────────────────────────────────────────────────────
  // Tool: cmux_notify — native notifications
  // ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "cmux_notify",
    label: "cmux Notify",
    description: "Send a native macOS notification via cmux. Use to alert the user about completed tasks, errors, or anything requiring attention.",
    parameters: Type.Object({
      title: Type.String({ description: "Notification title" }),
      body: Type.Optional(Type.String({ description: "Notification body text" })),
      subtitle: Type.Optional(Type.String({ description: "Notification subtitle" })),
    }),

    async execute(_id, params) {
      try {
        notify(params.title, params.body, params.subtitle);
        return { content: [{ type: "text", text: `Notification sent: ${params.title}` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], isError: true };
      }
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("cmux_notify")) + " " + theme.fg("dim", args.title),
        0, 0,
      );
    },

    renderResult(result, _opts, theme) {
      const txt = result.content[0];
      const text = txt?.type === "text" ? txt.text : "";
      const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "🔔");
      return new Text(`${icon} ${text}`, 0, 0);
    },
  });

  // ────────────────────────────────────────────────────────
  // Fleet tools — orchestrator only (workers can't spawn workers)
  // ────────────────────────────────────────────────────────

  if (!IS_WORKER) {

    // ── Tool: spawn_pi — launch a worker agent ──────────────

    pi.registerTool({
      name: "spawn_pi",
      label: "Spawn Pi Agent",
      description: [
        "Spawn a new pi agent in a cmux workspace. The agent runs in a visible",
        "terminal you can switch to at any time.",
        "",
        "The spawned agent loads extensions normally but with PI_CMUX_ROLE=worker,",
        "which keeps sidebar/notifications but prevents recursive spawning.",
      ].join("\n"),
      parameters: Type.Object({
        prompt: Type.String({ description: "Initial prompt for the agent" }),
        cwd: Type.Optional(Type.String({ description: "Working directory (default: current)" })),
        model: Type.Optional(Type.String({ description: "Model to use (default: anthropic/claude-opus-4-6)" })),
        direction: Type.Optional(Type.Union([
          Type.Literal("right"),
          Type.Literal("down"),
        ], { description: "Split direction for the worker pane (default: right)" })),
        skills: Type.Optional(Type.Array(Type.String(), {
          description: "Skill names to load (e.g. ['next-best-practices'])",
        })),
      }),

      async execute(_id, params) {
        if (fleet.size >= MAX_AGENTS) {
          return {
            content: [{ type: "text", text: `Fleet limit reached (${MAX_AGENTS}). Kill an agent first.` }],
            isError: true,
          };
        }

        const agentId = Math.random().toString(36).slice(2, 10);
        const cwd = params.cwd || process.cwd();
        const model = params.model || "anthropic/claude-opus-4-6";
        const direction = params.direction || "right";

        try {
          // 1. Create the surface
          let surfaceRef: string;
          let workspaceRef: string;

          {
            // Split a new terminal pane in the current workspace
            const splitDir = direction;
            const paneResult = cmux("new-pane", "--type", "terminal", "--direction", splitDir);
            const sfMatch = paneResult.match(/surface:\d+/);
            const pnMatch = paneResult.match(/pane:\d+/);
            surfaceRef = sfMatch ? sfMatch[0] : "";
            if (!surfaceRef) throw new Error(`Failed to create terminal pane: ${paneResult}`);

            // Resize worker pane to ~1/3
            if (pnMatch) cmuxSafe("resize-pane", "--pane", pnMatch[0], "-L", "--amount", "40");

            // Get current workspace ref
            const identify = cmuxSafe("identify");
            if (identify) {
              try {
                const info = JSON.parse(identify);
                workspaceRef = info.caller?.workspace_ref || "current";
              } catch { workspaceRef = "current"; }
            } else {
              workspaceRef = "current";
            }
          }

          // 2. Write prompt to temp file to avoid shell escaping nightmares
          const promptFile = path.join(cwd, `.pi-worker-${agentId}.md`);
          writeFileSync(promptFile, params.prompt);

          // 3. Build the pi command with @file reference
          const piArgs = ["pi", "--model", model];
          if (params.skills?.length) {
            for (const skill of params.skills) piArgs.push("--skill", skill);
          }
          piArgs.push(`@${promptFile}`);

          // 4. Send cd + pi as one chained command, clean up prompt file after
          const fullCmd = `cd ${cwd} && PI_CMUX_ROLE=worker ${piArgs.join(" ")}; rm -f ${promptFile}`;
          cmux("send", "--surface", surfaceRef, fullCmd);
          cmux("send-key", "--surface", surfaceRef, "Enter");

          // 4. Register in fleet
          const agent: AgentInfo = {
            id: agentId,
            surfaceRef,
            workspaceRef,
            model,
            cwd,
            prompt: params.prompt.slice(0, 200),
            status: "starting",
            spawnedAt: Date.now(),
          };
          fleet.set(agentId, agent);

          // Start completion detection if not already running
          startCompletionPolling();

          // 5. Update sidebar with fleet count
          cmuxSafe("set-status", "fleet",
            `${fleet.size} agent${fleet.size > 1 ? "s" : ""}`,
            "--icon", "person.3.fill", "--color", "#4C8DFF");

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                agent_id: agentId,
                workspace: workspaceRef,
                surface: surfaceRef,
                model,
                cwd,
                status: "launched",
              }, null, 2),
            }],
          };
        } catch (e: any) {
          return { content: [{ type: "text", text: `Failed to spawn: ${e.message}` }], isError: true };
        }
      },

      renderCall(args, theme) {
        const model = args.model ? theme.fg("dim", ` (${args.model})`) : "";
        const prompt = args.prompt.length > 50 ? args.prompt.slice(0, 47) + "…" : args.prompt;
        return new Text(
          theme.fg("toolTitle", theme.bold("spawn_pi")) + model + " " + theme.fg("accent", prompt),
          0, 0,
        );
      },

      renderResult(result, _opts, theme) {
        const txt = result.content[0];
        const text = txt?.type === "text" ? txt.text : "";
        if (result.isError) return new Text(theme.fg("error", `✗ ${text}`), 0, 0);
        try {
          const data = JSON.parse(text);
          return new Text(
            theme.fg("success", "✓") + ` agent:${data.agent_id} → ${data.workspace}`,
            0, 0,
          );
        } catch {
          return new Text(theme.fg("success", `✓ ${text}`), 0, 0);
        }
      },
    });

    // ── Tool: read_agent — read a worker's screen ───────────

    pi.registerTool({
      name: "read_agent",
      label: "Read Agent",
      description: "Read the terminal output of a spawned agent.",
      parameters: Type.Object({
        agent_id: Type.String({ description: "Agent ID from spawn_pi" }),
        lines: Type.Optional(Type.Number({ description: "Lines to read (default: 30)" })),
      }),

      async execute(_id, params) {
        const agent = fleet.get(params.agent_id);
        if (!agent) {
          return { content: [{ type: "text", text: `Agent ${params.agent_id} not found. Use list_agents to see active agents.` }], isError: true };
        }
        try {
          const lines = String(params.lines || 30);
          const screen = cmux("read-screen", "--surface", agent.surfaceRef, "--lines", lines);
          return { content: [{ type: "text", text: screen }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: e.message }], isError: true };
        }
      },

      renderCall(args, theme) {
        return new Text(
          theme.fg("toolTitle", theme.bold("read_agent")) + " " + theme.fg("accent", args.agent_id),
          0, 0,
        );
      },

      renderResult(result, _opts, theme) {
        const txt = result.content[0];
        const text = txt?.type === "text" ? txt.text : "";
        const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const lines = text.split("\n");
        const preview = lines.slice(0, 5).join("\n");
        const suffix = lines.length > 5 ? theme.fg("dim", `\n… ${lines.length - 5} more lines`) : "";
        return new Text(`${icon} ${preview}${suffix}`, 0, 0);
      },
    });

    // ── Tool: send_agent — steer a worker ───────────────────

    pi.registerTool({
      name: "send_agent",
      label: "Send to Agent",
      description: "Send a message or instruction to a spawned agent.",
      parameters: Type.Object({
        agent_id: Type.String({ description: "Agent ID from spawn_pi" }),
        message: Type.String({ description: "Message to send to the agent" }),
      }),

      async execute(_id, params) {
        const agent = fleet.get(params.agent_id);
        if (!agent) {
          return { content: [{ type: "text", text: `Agent ${params.agent_id} not found.` }], isError: true };
        }
        try {
          cmux("send", "--surface", agent.surfaceRef, params.message);
          cmux("send-key", "--surface", agent.surfaceRef, "Enter");
          return { content: [{ type: "text", text: `Sent to agent ${params.agent_id}` }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: e.message }], isError: true };
        }
      },

      renderCall(args, theme) {
        const msg = args.message.length > 50 ? args.message.slice(0, 47) + "…" : args.message;
        return new Text(
          theme.fg("toolTitle", theme.bold("send_agent")) + " " +
          theme.fg("accent", args.agent_id) + " " + theme.fg("dim", msg),
          0, 0,
        );
      },

      renderResult(result, _opts, theme) {
        const txt = result.content[0];
        const text = txt?.type === "text" ? txt.text : "";
        const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        return new Text(`${icon} ${text}`, 0, 0);
      },
    });

    // ── Tool: kill_agent — abort a worker ───────────────────

    pi.registerTool({
      name: "kill_agent",
      label: "Kill Agent",
      description: "Stop a spawned agent. Sends Ctrl-C and optionally closes the workspace.",
      parameters: Type.Object({
        agent_id: Type.String({ description: "Agent ID from spawn_pi" }),
        close_workspace: Type.Optional(Type.Boolean({ description: "Also close the workspace (default: false)" })),
      }),

      async execute(_id, params) {
        const agent = fleet.get(params.agent_id);
        if (!agent) {
          return { content: [{ type: "text", text: `Agent ${params.agent_id} not found.` }], isError: true };
        }
        try {
          // Send Ctrl-C to interrupt
          cmuxSafe("send-key", "--surface", agent.surfaceRef, "C-c");
          // Give it a moment, then send exit
          setTimeout(() => {
            cmuxSafe("send", "--surface", agent.surfaceRef, "exit");
            cmuxSafe("send-key", "--surface", agent.surfaceRef, "Enter");
          }, 1000);

          if (params.close_workspace && agent.workspaceRef !== "current") {
            setTimeout(() => {
              cmuxSafe("close-surface", "--surface", agent.surfaceRef);
            }, 2000);
          }

          agent.status = "failed";
          fleet.delete(params.agent_id);

          // Update sidebar
          if (fleet.size > 0) {
            cmuxSafe("set-status", "fleet",
              `${fleet.size} agent${fleet.size > 1 ? "s" : ""}`,
              "--icon", "person.3.fill", "--color", "#4C8DFF");
          } else {
            cmuxSafe("clear-status", "fleet");

          }

          return { content: [{ type: "text", text: `Killed agent ${params.agent_id}` }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: e.message }], isError: true };
        }
      },

      renderCall(args, theme) {
        return new Text(
          theme.fg("toolTitle", theme.bold("kill_agent")) + " " + theme.fg("error", args.agent_id),
          0, 0,
        );
      },

      renderResult(result, _opts, theme) {
        const txt = result.content[0];
        const text = txt?.type === "text" ? txt.text : "";
        const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        return new Text(`${icon} ${text}`, 0, 0);
      },
    });

    // ── Tool: list_agents — show fleet status ───────────────

    pi.registerTool({
      name: "list_agents",
      label: "List Agents",
      description: "Show all spawned agents and their status.",
      parameters: Type.Object({}),

      async execute() {
        if (fleet.size === 0) {
          return { content: [{ type: "text", text: "No agents spawned." }] };
        }

        const lines: string[] = [];
        for (const [id, agent] of fleet) {
          const elapsed = Math.round((Date.now() - agent.spawnedAt) / 1000);
          const mins = Math.floor(elapsed / 60);
          const secs = elapsed % 60;
          const time = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
          lines.push(
            `${id}  ${agent.workspaceRef}  ${agent.model}  ${agent.status}  ${time}\n` +
            `  cwd: ${agent.cwd}\n` +
            `  prompt: ${agent.prompt}`
          );
        }

        return { content: [{ type: "text", text: lines.join("\n\n") }] };
      },

      renderCall(_args, theme) {
        return new Text(
          theme.fg("toolTitle", theme.bold("list_agents")) + " " + theme.fg("dim", `(${fleet.size})`),
          0, 0,
        );
      },

      renderResult(result, _opts, theme) {
        const txt = result.content[0];
        const text = txt?.type === "text" ? txt.text : "";
        if (fleet.size === 0) return new Text(theme.fg("dim", "No agents"), 0, 0);
        const lines = text.split("\n");
        const preview = lines.slice(0, 6).join("\n");
        const suffix = lines.length > 6 ? theme.fg("dim", `\n… ${lines.length - 6} more lines`) : "";
        return new Text(`${preview}${suffix}`, 0, 0);
      },
    });

    // ── Completion detection polling ──────────────────────────
    //
    // Polls each agent's terminal every 5s. When a shell prompt is visible
    // (❯ or $), pi has exited → mark agent idle and notify the orchestrator.

    let _completionPollTimer: ReturnType<typeof setInterval> | null = null;
    const COMPLETION_POLL_MS = 5000;
    const SPAWN_GRACE_MS = 15000; // let pi boot before checking

    // Detect agent idle:
    // Pi footer visible (cost info) WITHOUT a spinner = agent finished, pi at input prompt
    // Shell prompt (❯ or $) = pi exited back to shell
    const HAS_PI_FOOTER = /\$[0-9]+\.[0-9]+/;           // $0.175 in footer
    const IS_WORKING = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s|Working|Thinking/;  // spinner or status
    const IDLE_SHELL_RE = /^[❯$]\s*$/m;                  // shell prompt alone on line

    function startCompletionPolling(): void {
      if (_completionPollTimer) return;
      _completionPollTimer = setInterval(() => {
        if (fleet.size === 0) {
          stopCompletionPolling();
          return;
        }

        for (const [id, agent] of fleet) {
          if (agent.status === "idle" || agent.status === "completed" || agent.status === "failed") continue;
          if (Date.now() - agent.spawnedAt < SPAWN_GRACE_MS) continue;

          const screen = cmuxSafe("read-screen", "--surface", agent.surfaceRef, "--lines", "5");
          if (!screen) continue;

          const piIdle = HAS_PI_FOOTER.test(screen) && !IS_WORKING.test(screen);
          if (piIdle || IDLE_SHELL_RE.test(screen)) {
            agent.status = "idle";
            pi.sendMessage(
              {
                customType: "agent-completion",
                content: `🐝 Agent ${id} has finished and is idle.\nPrompt: ${agent.prompt}\nSurface: ${agent.surfaceRef}`,
                display: true,
              },
              { triggerTurn: true },
            );
            cmuxSafe("log", "--level", "info", "--source", "fleet", "--", `Agent ${id} idle`);
          }
        }
      }, COMPLETION_POLL_MS);
    }

    function stopCompletionPolling(): void {
      if (_completionPollTimer) {
        clearInterval(_completionPollTimer);
        _completionPollTimer = null;
      }
    }

  } // end !IS_WORKER

  // ── Fleet cleanup on session shutdown ─────────────────────

  pi.on("session_shutdown", async () => {
    // Kill all spawned agents
    for (const [id, agent] of fleet) {
      cmuxSafe("send-key", "--surface", agent.surfaceRef, "C-c");
      setTimeout(() => {
        cmuxSafe("send", "--surface", agent.surfaceRef, "exit");
        cmuxSafe("send-key", "--surface", agent.surfaceRef, "Enter");
      }, 500);
    }
    fleet.clear();
    cmuxSafe("clear-status", "fleet");
  });
}
