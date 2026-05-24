/**
 * cmux — pi ↔ cmux integration extension.
 *
 * Lifecycle hooks:
 *   - session_start:     Set "Idle", publish model/usage metadata, start pane stack reporter.
 *   - agent_start:       Set current pane row to "Running" (blue bolt).
 *   - tool_execution_start: Live tool activity in sidebar (visible from other workspaces).
 *   - agent_end:         "Needs input" (blue bell) + metadata refresh + cmux notification + peon-ping.
 *   - session_shutdown:  Clear Pi-owned sidebar state and worker IPC.
 *
 * Session naming:
 *   Opt-in via PI_CMUX_SESSION_NAMING=1. On first user prompt, spawns a cheap
 *   helper model call to generate a 2-4 word session name from the prompt + cwd.
 *   Sets it via pi.setSessionName() and displays it as a high-priority sidebar
 *   entry. Workspace label is never touched — left to the operator.
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
 *   but disables subprocess-spawning features (session naming,
 *   turn summary helpers). Use for agents spawned by an orchestrator.
 *
 * Requires: cmux CLI in PATH and CMUX_SOCKET_PATH env var.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { execSync, execFileSync, spawn } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import * as path from "node:path";

// ── Config ─────────────────────────────────────────────

const STATUS_KEY = "pi_agent";
// Session name + Pi metadata live above the pane stack.
const SESSION_NAME_KEY = "0_session";
const PI_MODEL_KEY = "pi_model";
const PI_USAGE_KEY = "pi_usage";
const SESSION_STATUS_PRIORITY = 60;
const PI_METADATA_PRIORITY = 50;
// Pane stack lives at the bottom of the cmux sidebar.
const PANE_STACK_HEADER_KEY = "zz_panes";
const PANE_STACK_ITEM_KEY_PREFIX = "zz_pane_";
const PANE_STACK_MAX_ITEMS = 6;
const PANE_STACK_POLL_MS = 5000;
const PANE_STACK_PRIORITY = -100;
const NAMING_MODEL = process.env.PI_CMUX_NAMING_MODEL || "openai-codex/gpt-5.5";
// Session naming has caused Pi rendering artifacts when names update mid-render.
// Keep it opt-in until Pi/core footer rendering is proven stable with live renames.
const ENABLE_SESSION_NAMING = process.env.PI_CMUX_SESSION_NAMING === "1";
// Helper pi subprocesses must not reload this extension or they recurse forever.
const CMUX_CHILD_ENV = "PI_CMUX_CHILD";
// Worker mode: full visibility, no subprocess spawns (session naming, turn summaries).
const IS_WORKER = process.env.PI_CMUX_ROLE === "worker";
const WORKER_AGENT_ID = process.env.PI_CMUX_AGENT_ID || null;

// Fleet IPC: workers write status files, orchestrator reads them (no read-screen dependency)
const FLEET_IPC_DIR = path.join(process.env.TMPDIR || "/tmp", "pi-fleet");

// SF Symbols + colors matching cmux Claude Code integration
const STATUS_RUNNING = { value: "Running", icon: "bolt.fill", color: "#4C8DFF" };
const STATUS_IDLE = { value: "Idle", icon: "pause.circle.fill", color: "#8E8E93" };
const STATUS_NEEDS_INPUT = { value: "Needs input", icon: "bell.fill", color: "#4C8DFF" };

// ── Fleet IPC: file-based status signals between workers and orchestrator ──
// Workers write status files on lifecycle events. Orchestrator polls the directory.
// This replaces read-screen polling — ghostty surfaces take too long to initialize
// for programmatically created terminals, making read-screen unreliable.

interface FleetStatusFile {
  agentId: string;
  status: "running" | "idle" | "needs-input";
  timestamp: number;
  turnCount?: number;
}

interface CmuxIdentifyPayload {
  caller?: {
    workspace_ref?: string;
    pane_ref?: string;
  };
  focused?: {
    workspace_ref?: string;
    pane_ref?: string;
  };
}

interface CmuxListPanesPayload {
  panes?: Array<{
    ref: string;
    index: number;
    focused: boolean;
    surface_count: number;
    selected_surface_ref?: string;
    surface_refs?: string[];
  }>;
}

interface CmuxListPaneSurfacesPayload {
  surfaces?: Array<{
    ref: string;
    index: number;
    title?: string;
    type?: string;
    selected?: boolean;
  }>;
}

interface SidebarStatusEntry {
  key: string;
  value: string;
  icon?: string;
  color?: string;
  priority?: number;
}

function writeFleetStatus(agentId: string, status: FleetStatusFile["status"], extra?: Partial<FleetStatusFile>): void {
  try {
    mkdirSync(FLEET_IPC_DIR, { recursive: true });
    const data: FleetStatusFile = { agentId, status, timestamp: Date.now(), ...extra };
    writeFileSync(path.join(FLEET_IPC_DIR, `${agentId}.json`), JSON.stringify(data) + "\n");
  } catch { /* best-effort */ }
}

function clearFleetStatus(agentId: string): void {
  try { unlinkSync(path.join(FLEET_IPC_DIR, `${agentId}.json`)); } catch { /* ok */ }
}

// Fleet tracker and tools are in pi-cmux-subagents (separate extension).
// This extension provides worker-side IPC writes and base cmux integration.

// ── cmux CLI wrapper ───────────────────────────────────

function isRunningInsideCmux(): boolean {
  return Boolean(
    process.env.CMUX_WORKSPACE_ID
    || process.env.CMUX_SURFACE_ID
    || process.env.CMUX_TAB_ID
    || process.env.CMUX_PANEL_ID,
  );
}

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

let _currentPaneStatus: { value: string; icon: string; color: string } = STATUS_IDLE;

function setStatus(status: { value: string; icon: string; color: string }): void {
  _currentPaneStatus = status;
  cmuxSafe("clear-status", STATUS_KEY);
  clearBuiltinStatus();
  schedulePaneStackRefresh();
}

function clearStatus(): void {
  cmuxSafe("clear-status", STATUS_KEY);
  // cmux has a built-in claude_code status key that conflicts with ours — always clear it
  cmuxSafe("clear-status", "claude_code");
}

function clearBuiltinStatus(): void {
  cmuxSafe("clear-status", "claude_code");
}

function setSidebarEntry(entry: SidebarStatusEntry): void {
  const args = ["set-status", entry.key, entry.value];
  if (entry.icon) args.push("--icon", entry.icon);
  if (entry.color) args.push("--color", entry.color);
  if (entry.priority !== undefined) args.push("--priority", String(entry.priority));
  cmuxSafe(...args);
}

function paneStackKeys(): string[] {
  return [
    PANE_STACK_HEADER_KEY,
    ...Array.from({ length: PANE_STACK_MAX_ITEMS }, (_, i) => `${PANE_STACK_ITEM_KEY_PREFIX}${String(i).padStart(2, "0")}`),
  ];
}

function paneTypeIcon(type?: string): string {
  switch (type) {
    case "browser":
      return "globe";
    case "terminal":
      return "terminal";
    default:
      return "square.on.square";
  }
}

function shortenLabel(text: string, max = 52): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "Untitled";
  if (clean.length <= max) return clean;
  return clean.slice(0, Math.max(1, max - 1)).trimEnd() + "…";
}

function currentCmuxInfo(): CmuxIdentifyPayload | null {
  try {
    return JSON.parse(cmux("identify")) as CmuxIdentifyPayload;
  } catch {
    return null;
  }
}

function buildPaneStackEntries(): SidebarStatusEntry[] | null {
  try {
    const info = currentCmuxInfo();
    const workspaceRef = info?.caller?.workspace_ref || info?.focused?.workspace_ref || null;
    const currentPaneRef = info?.caller?.pane_ref || null;
    if (!workspaceRef) return null;

    const panesPayload = JSON.parse(cmux("--json", "list-panes", "--workspace", workspaceRef)) as CmuxListPanesPayload;
    const panes = panesPayload.panes || [];
    if (panes.length === 0) return [];

    const orderedPanes = [...panes].sort((a, b) => a.index - b.index);
    const entries: SidebarStatusEntry[] = [];

    const overflow = Math.max(0, orderedPanes.length - PANE_STACK_MAX_ITEMS);
    const visiblePanes = overflow > 0 ? orderedPanes.slice(0, PANE_STACK_MAX_ITEMS - 1) : orderedPanes.slice(0, PANE_STACK_MAX_ITEMS);

    for (const [itemIndex, pane] of visiblePanes.entries()) {
      const surfacesPayload = JSON.parse(
        cmux("--json", "list-pane-surfaces", "--workspace", workspaceRef, "--pane", pane.ref),
      ) as CmuxListPaneSurfacesPayload;
      const surfaces = surfacesPayload.surfaces || [];
      const selected = surfaces.find((surface) => surface.selected) || surfaces[0];
      const title = shortenLabel(selected?.title || (selected?.type === "browser" ? "Browser" : "Terminal"));
      const suffix = pane.surface_count > 1 ? ` · ${pane.surface_count} tabs` : "";
      const key = `${PANE_STACK_ITEM_KEY_PREFIX}${String(itemIndex).padStart(2, "0")}`;
      const isCurrentPane = pane.ref === currentPaneRef;
      entries.push({
        key,
        value: isCurrentPane ? `${_currentPaneStatus.value} · ${title}${suffix}` : `${title}${suffix}`,
        icon: isCurrentPane ? _currentPaneStatus.icon : paneTypeIcon(selected?.type),
        color: isCurrentPane ? _currentPaneStatus.color : pane.focused ? "#4C8DFF" : "#8E8E93",
        priority: PANE_STACK_PRIORITY,
      });
    }

    if (overflow > 0) {
      entries.push({
        key: `${PANE_STACK_ITEM_KEY_PREFIX}${String(entries.length).padStart(2, "0")}`,
        value: `+${overflow} more panes`,
        icon: "ellipsis.circle",
        color: "#8E8E93",
        priority: PANE_STACK_PRIORITY,
      });
    }

    return entries;
  } catch {
    return null;
  }
}

let _paneStackTimer: ReturnType<typeof setInterval> | null = null;
let _paneStackRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let _paneStackKeys: string[] = [];
let _paneStackSignature: string | null = null;

function renderPaneStack(): void {
  cmuxSafe("clear-status", STATUS_KEY);
  clearBuiltinStatus();

  const entries = buildPaneStackEntries();
  if (entries === null) return;

  const nextKeys = entries.map((entry) => entry.key);
  const signature = JSON.stringify(entries);
  if (signature === _paneStackSignature) return;

  for (const key of _paneStackKeys) {
    if (!nextKeys.includes(key)) cmuxSafe("clear-status", key);
  }
  for (const entry of entries) setSidebarEntry(entry);

  _paneStackKeys = nextKeys;
  _paneStackSignature = signature;
}

function schedulePaneStackRefresh(delay = 150): void {
  if (_paneStackRefreshTimer) clearTimeout(_paneStackRefreshTimer);
  _paneStackRefreshTimer = setTimeout(() => {
    _paneStackRefreshTimer = null;
    renderPaneStack();
  }, delay);
}

function startPaneStackReporter(): void {
  stopPaneStackReporter();
  renderPaneStack();
  _paneStackTimer = setInterval(() => {
    renderPaneStack();
  }, PANE_STACK_POLL_MS);
}

function stopPaneStackReporter(): void {
  if (_paneStackTimer) {
    clearInterval(_paneStackTimer);
    _paneStackTimer = null;
  }
  if (_paneStackRefreshTimer) {
    clearTimeout(_paneStackRefreshTimer);
    _paneStackRefreshTimer = null;
  }
  for (const key of (_paneStackKeys.length ? _paneStackKeys : paneStackKeys())) {
    cmuxSafe("clear-status", key);
  }
  _paneStackKeys = [];
  _paneStackSignature = null;
}

// ── Pi metadata helpers ────────────────────────────────

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatTokenCount(value: number): string {
  const n = Math.max(0, Math.round(value));
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}m`;
}

function formatCost(value: number): string {
  if (value <= 0) return "";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function collectUsage(ctx: any): { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number } {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  try {
    const entries = ctx?.sessionManager?.getBranch?.() || [];
    for (const entry of entries) {
      const message = entry?.type === "message" ? entry.message : null;
      if (message?.role !== "assistant" || !message.usage) continue;
      totals.input += finiteNumber(message.usage.input);
      totals.output += finiteNumber(message.usage.output);
      totals.cacheRead += finiteNumber(message.usage.cacheRead);
      totals.cacheWrite += finiteNumber(message.usage.cacheWrite);
      totals.cost += finiteNumber(message.usage.cost?.total);
      totals.turns++;
    }
  } catch { /* best-effort */ }
  return totals;
}

function updatePiMetadata(pi: ExtensionAPI, ctx: any): void {
  try {
    const model = ctx?.model;
    const provider = model?.provider ? `${model.provider}/` : "";
    const modelId = model?.id || "model unknown";
    const thinking = pi.getThinkingLevel?.();
    const thinkingSuffix = thinking && thinking !== "off" ? `:${thinking}` : "";
    setSidebarEntry({
      key: PI_MODEL_KEY,
      value: shortenLabel(`${provider}${modelId}${thinkingSuffix}`, 58),
      icon: "brain.head.profile",
      color: "#8E8E93",
      priority: PI_METADATA_PRIORITY,
    });

    const usage = collectUsage(ctx);
    const contextUsage = ctx?.getContextUsage?.();
    const parts: string[] = [];
    if (contextUsage?.tokens !== null && contextUsage?.tokens !== undefined && contextUsage?.contextWindow) {
      parts.push(`ctx ${formatTokenCount(contextUsage.tokens)}/${formatTokenCount(contextUsage.contextWindow)}`);
    }
    if (usage.input || usage.output || usage.cacheRead || usage.cacheWrite) {
      parts.push(`↑${formatTokenCount(usage.input + usage.cacheRead + usage.cacheWrite)} ↓${formatTokenCount(usage.output)}`);
    }
    const cost = formatCost(usage.cost);
    if (cost) parts.push(cost);

    if (parts.length > 0) {
      setSidebarEntry({
        key: PI_USAGE_KEY,
        value: parts.join(" · "),
        icon: "chart.bar",
        color: "#8E8E93",
        priority: PI_METADATA_PRIORITY - 1,
      });
    } else {
      cmuxSafe("clear-status", PI_USAGE_KEY);
    }
  } catch { /* best-effort */ }
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

  // Truncate to keep the helper model call cheap
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
        setStatus({ value: summary, icon: "bell.fill", color: "#4C8DFF" });
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
    case "mcq":
      return `Waiting for input`;
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
let _waitingForHuman = false;

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
    if (_waitingForHuman) return; // don't overwrite "Needs input" during MCQ etc.
    const elapsed = formatElapsed(Date.now() - _agentStartedAt);
    const label = _lastToolDesc || "Thinking";
    setStatus({ value: `${label} · ${elapsed}`, icon: "bolt.fill", color: "#4C8DFF" });
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
  if (!hasCmux()) return;
  if (!isRunningInsideCmux()) return; // zellij/plain shells/SSH should no-op cleanly

  // Detect peon-ping on load
  peonPath = detectPeonPing();

  // ── Lifecycle: session start — clean slate ──
  pi.on("session_start", async (_event, ctx) => {
    _pendingSessionName = null;
    _turnCount = 0;
    _currentPaneStatus = STATUS_IDLE;
    const existingName = pi.getSessionName();
    if (!ENABLE_SESSION_NAMING && existingName) {
      pi.setSessionName("");
    }
    _hasNamedSession = ENABLE_SESSION_NAMING && Boolean(existingName);
    // Clear stale state from previous sessions
    cmuxSafe("clear-notifications");
    cmuxSafe("clear-log");
    setStatus(STATUS_IDLE);
    startPaneStackReporter();
    updatePiMetadata(pi, ctx);
    if (ENABLE_SESSION_NAMING && existingName) {
      setSidebarEntry({
        key: SESSION_NAME_KEY,
        value: existingName,
        icon: "text.bubble",
        color: "#8E8E93",
        priority: SESSION_STATUS_PRIORITY,
      });
    }
  });

  // ── Lifecycle: user types → instantly clear attention state ──
  pi.on("input", async () => {
    setStatus(STATUS_IDLE);
    cmuxSafe("clear-notifications");
    cmuxSafe("workspace-action", "--action", "mark-read");
    cmuxSafe("claude-hook", "prompt-submit");
    schedulePaneStackRefresh();
  });

  pi.on("model_select", async (_event, ctx) => {
    updatePiMetadata(pi, ctx);
  });

  (pi as any).on("thinking_level_select", async (_event: any, ctx: any) => {
    updatePiMetadata(pi, ctx);
  });

  // ── Lifecycle: first prompt → auto-name session ──
  pi.on("before_agent_start", async (event, ctx) => {
    // Name the session from the first user prompt
    if (ENABLE_SESSION_NAMING && !_hasNamedSession && event.prompt) {
      _hasNamedSession = true;

      // If session already has a name (e.g. from /continue), skip
      const existing = pi.getSessionName();
      if (!existing && !IS_WORKER) {
        generateSessionName(event.prompt, ctx.cwd);
      }
    }
  });

  // ── Lifecycle: agent running — clear attention state, start heartbeat ──
  pi.on("agent_start", async (_event, ctx) => {
    cmuxSafe("clear-notifications");
    _waitingForHuman = false;
    setStatus(STATUS_RUNNING);
    updatePiMetadata(pi, ctx);
    startHeartbeat();
    schedulePaneStackRefresh();

    // Worker IPC: signal orchestrator that we're running
    if (IS_WORKER && WORKER_AGENT_ID) writeFleetStatus(WORKER_AGENT_ID, "running");

    // Apply pending session name from async helper model call
    if (ENABLE_SESSION_NAMING && _pendingSessionName) {
      pi.setSessionName(_pendingSessionName);
      setSidebarEntry({
        key: SESSION_NAME_KEY,
        value: _pendingSessionName,
        icon: "text.bubble",
        color: "#8E8E93",
        priority: SESSION_STATUS_PRIORITY,
      });
      _pendingSessionName = null;
    }
  });

  // Tools that block waiting for human input — treat like agent_end for attention purposes
  const HUMAN_BLOCKING_TOOLS = new Set(["mcq"]);

  // ── Lifecycle: tool execution — live status updates (visible from other workspaces) ──
  pi.on("tool_execution_start", async (event) => {
    const desc = describeToolUse(event.toolName, event.args);
    _lastToolDesc = desc;
    if (event.toolName === "cmux") schedulePaneStackRefresh();

    if (HUMAN_BLOCKING_TOOLS.has(event.toolName)) {
      // Human-blocking tool: flip to "Needs input" and notify
      _waitingForHuman = true;
      setStatus(STATUS_NEEDS_INPUT);
      cmuxSafe("workspace-action", "--action", "mark-unread");
      if (IS_WORKER && WORKER_AGENT_ID) writeFleetStatus(WORKER_AGENT_ID, "needs-input");
      if (!isFocused()) {
        const sessionName = pi.getSessionName();
        notify("pi", sessionName ? `${sessionName} — needs input (${event.toolName})` : `Needs input (${event.toolName})`);
        playPeonPing("stop");
      }
    } else {
      // Normal tool: clear human-waiting flag and show activity
      _waitingForHuman = false;
      const elapsed = _agentStartedAt ? formatElapsed(Date.now() - _agentStartedAt) : "";
      setStatus({ value: elapsed ? `${desc} · ${elapsed}` : desc, icon: "bolt.fill", color: "#4C8DFF" });
    }
  });

  // ── Lifecycle: agent done → idle + summary, peon-ping ──
  pi.on("agent_end", async (event, ctx) => {
    stopHeartbeat();
    _turnCount++;
    schedulePaneStackRefresh();
    // Set needs-input immediately (summary will overwrite async, keeping bell icon)
    setStatus(STATUS_NEEDS_INPUT);
    updatePiMetadata(pi, ctx);

    // Worker IPC: signal orchestrator that we're idle
    if (IS_WORKER && WORKER_AGENT_ID) writeFleetStatus(WORKER_AGENT_ID, "idle", { turnCount: _turnCount });

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
      if (ENABLE_SESSION_NAMING && _turnCount % RENAME_INTERVAL_TURNS === 0 && lastAssistantText) {
        reevaluateSessionName(lastAssistantText, pi.getSessionName(), ctx.cwd);
      }
    }

    // Mark workspace tab as unread (visual indicator) + notify if not focused.
    // Workers skip notifications: the orchestrator's completion detection handles fleet alerts.
    if (!isFocused()) {
      cmuxSafe("workspace-action", "--action", "mark-unread");
      if (!IS_WORKER) {
        const sessionName = pi.getSessionName();
        notify("pi", sessionName ? `${sessionName} — waiting for input` : "Waiting for input");
        playPeonPing("stop");
      }
    }
  });

  // ── Lifecycle: compaction — natural inflection point for rename ──
  pi.on("session_compact", async (event, ctx) => {
    if (IS_WORKER) return;
    const summary = (event as any).compactionEntry?.summary;
    if (ENABLE_SESSION_NAMING && summary) {
      reevaluateSessionName(summary, pi.getSessionName(), ctx.cwd);
    }
  });

  // ── Lifecycle: session shutdown ──
  pi.on("session_shutdown", async () => {
    stopHeartbeat();
    stopPaneStackReporter();
    _pendingSessionName = null;
    _hasNamedSession = false;
    _turnCount = 0;
    clearStatus();
    cmuxSafe("clear-status", SESSION_NAME_KEY);
    cmuxSafe("clear-status", PI_MODEL_KEY);
    cmuxSafe("clear-status", PI_USAGE_KEY);
    cmuxSafe("clear-notifications");
    cmuxSafe("clear-progress");
    // Worker IPC: clean up status file
    if (IS_WORKER && WORKER_AGENT_ID) clearFleetStatus(WORKER_AGENT_ID);
  });

  // ── Apply pending session name between turns ──
  pi.on("context", async (_event, ctx) => {
    updatePiMetadata(pi, ctx);
    if (ENABLE_SESSION_NAMING && _pendingSessionName) {
      pi.setSessionName(_pendingSessionName);
      setSidebarEntry({
        key: SESSION_NAME_KEY,
        value: _pendingSessionName,
        icon: "text.bubble",
        color: "#8E8E93",
        priority: SESSION_STATUS_PRIORITY,
      });
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
      "• tree / identify — show topology and caller workspace/pane/surface refs",
      "• list-windows / list-workspaces / list-panes / list-pane-surfaces — inspect topology",
      "• read-screen — read terminal content from any surface (--surface, --lines, --scrollback)",
      "• send / send-key — send text or keys to a surface",
      "• new-window / new-workspace / new-split / new-surface / new-pane — create topology",
      "• focus-window / select-workspace / focus-pane / focus-panel — focus topology",
      "• move-surface / split-off / reorder-surface / reorder-workspace / move-workspace-to-window — rearrange topology",
      "• close-window / close-workspace / close-surface — close topology",
      "• trigger-flash / surface-health — attention and health checks",
      "Use refs like surface:1, workspace:2, pane:3. Run 'identify' or 'tree' first to discover refs.",
    ].join("\n"),
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("tree"),
        Type.Literal("identify"),
        Type.Literal("list-windows"),
        Type.Literal("current-window"),
        Type.Literal("list-workspaces"),
        Type.Literal("current-workspace"),
        Type.Literal("read-screen"),
        Type.Literal("send"),
        Type.Literal("send-key"),
        Type.Literal("new-window"),
        Type.Literal("new-workspace"),
        Type.Literal("new-split"),
        Type.Literal("new-pane"),
        Type.Literal("new-surface"),
        Type.Literal("focus-window"),
        Type.Literal("select-workspace"),
        Type.Literal("focus-pane"),
        Type.Literal("focus-panel"),
        Type.Literal("close-window"),
        Type.Literal("close-workspace"),
        Type.Literal("close-surface"),
        Type.Literal("list-panes"),
        Type.Literal("list-pane-surfaces"),
        Type.Literal("move-surface"),
        Type.Literal("split-off"),
        Type.Literal("reorder-surface"),
        Type.Literal("reorder-workspace"),
        Type.Literal("move-workspace-to-window"),
        Type.Literal("surface-health"),
        Type.Literal("trigger-flash"),
      ], { description: "Allowed cmux CLI command" }),
      args: Type.Optional(Type.Array(Type.String(), { description: "Additional arguments for the command" })),
    }),

    async execute(_id, params): Promise<any> {
      const action = params.action;
      const args = params.args || [];

      // Allowlist of safe commands
      const allowed = new Set([
        "tree", "identify",
        "list-windows", "current-window", "list-workspaces", "current-workspace",
        "read-screen", "send", "send-key",
        "new-window", "new-workspace", "new-split", "new-pane", "new-surface",
        "focus-window", "select-workspace", "focus-pane", "focus-panel",
        "close-window", "close-surface", "close-workspace",
        "list-panes", "list-pane-surfaces",
        "move-surface", "split-off", "reorder-surface", "reorder-workspace", "move-workspace-to-window",
        "rename-workspace",
        "surface-health", "trigger-flash",
      ]);

      if (!allowed.has(action)) {
        return {
          content: [{ type: "text", text: `Unknown or disallowed action: ${action}\nAllowed: ${[...allowed].join(", ")}` }],
          isError: true,
        };
      }

      try {
        const result = cmux(action, ...args);
        schedulePaneStackRefresh();
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

    renderResult(result: any, _opts, theme) {
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
      "• set-status <key> <value> — set a status entry (optional: icon, color, priority)",
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
      priority: Type.Optional(Type.Number({ description: "Sidebar ordering priority (higher appears first)" })),
      level: Type.Optional(Type.Union([
        Type.Literal("info"),
        Type.Literal("warn"),
        Type.Literal("error"),
      ], { description: "Log level" })),
      label: Type.Optional(Type.String({ description: "Progress bar label" })),
    }),

    async execute(_id, params): Promise<any> {
      try {
        switch (params.action) {
          case "set-status": {
            if (!params.key || !params.value)
              return { content: [{ type: "text", text: "set-status requires key and value" }], isError: true };
            const args = ["set-status", params.key, params.value];
            if (params.icon) args.push("--icon", params.icon);
            if (params.color) args.push("--color", params.color);
            if (params.priority !== undefined) args.push("--priority", String(params.priority));
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
      const parts: string[] = [args.action];
      if (args.key) parts.push(args.key);
      if (args.value) parts.push(args.value);
      return new Text(
        theme.fg("toolTitle", theme.bold("cmux_status")) + " " + theme.fg("dim", parts.join(" ")),
        0, 0,
      );
    },

    renderResult(result: any, _opts, theme) {
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

    async execute(_id, params): Promise<any> {
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

    renderResult(result: any, _opts, theme) {
      const txt = result.content[0];
      const text = txt?.type === "text" ? txt.text : "";
      const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "🔔");
      return new Text(`${icon} ${text}`, 0, 0);
    },
  });

  // Fleet tools (spawn_pi, read_agent, etc.) are in pi-cmux-subagents.
}

