# pi-cmux — cmux ↔ pi integration extension

## What this repo is

The cmux extension for pi. Standalone package — runs in orchestrator sessions (full control) and worker agents (visibility only). Currently Layer 2 of a 5-layer orchestration stack.

## Related repos

| Repo | Path | Purpose |
|------|------|---------|
| **course-the-hive** | `~/Code/badass-courses/course-the-hive-multi-agent-orchestration/` | Course project — explores + documents building the orchestration rig on top of this extension |
| **course-the-claw** | `~/Code/badass-courses/course-the-claw-minions-of-toil/` | Sibling course — single-agent architecture. The Hive extends where the-claw's operator paradigm leaves off |
| **swarm-tools** | `~/Code/joelhooks/swarm-tools/` | Prior art — event-sourced multi-agent coordination, hive/cell tasks, file reservations, learning |
| **joelclaw** | `~/Code/joelhooks/joelclaw/` | Prior art — hexagonal infra monorepo, sandboxed execution, Restate workflows, system-bus |
| **atproto-agent-network** | `~/Code/joelhooks/atproto-agent-network/` | Prior art — decentralized Pi-powered agents on Cloudflare, alarm-driven loops, fleet dashboard |
| **gremlin-course-authoring** | `~/Code/badass-courses/gremlin-course-authoring/` | Shared course authoring infra — the course project symlinks skills/extensions from here |

## Architecture: The 5-Layer Stack

```
Layer 4: Orchestrator          ← the human's pi session (opus) — BUILD THIS
Layer 3: pi-tasks              ← task DAG, shared stores, dependencies — EXTEND
Layer 2: cmux Extension        ← pi ↔ cmux bridge — THIS REPO ✅
Layer 1: Pi Agent Runtime      ← independent pi processes per workspace
Layer 0: cmux Terminal Fabric  ← workspaces, panes, surfaces, sidebar
```

Layer 2 is solid. The course project builds Layers 3-4 through explorations that prototype features, then proven patterns merge back into this extension.

## The spec

The full orchestration rig spec lives in the course project's `research/` directory (8 files from a gist):

```
~/Code/badass-courses/course-the-hive-multi-agent-orchestration/research/
  00-OVERVIEW.md          # Vision — orchestrator spawns visible workers
  01-ARCHITECTURE.md      # 5-layer stack, component map, data flow
  02-SPAWN-PI.md          # spawn_pi / read_agent / send_agent / kill_agent tools
  03-FLEET-DASHBOARD.md   # Live TUI widget for agent fleet status
  04-RPC-BRIDGE.md        # Headless pi --mode rpc worker pool
  05-CROSS-SESSION.md     # Cross-workspace communication
  06-TASK-INTEGRATION.md  # pi-tasks as orchestration backbone
  07-PATTERNS-STOLEN.md   # Patterns from dmux, pi-coordination, boomerang, jido_symphony
```

Read `00-OVERVIEW.md` and `01-ARCHITECTURE.md` first to understand the full vision.

## What's built (Layer 2)

The extension at `cmux.ts` (~500 lines) handles:

- **Sidebar status** — Running/Idle/Needs input with heartbeat elapsed time
- **Live tool activity** — every tool execution updates sidebar (visible from other workspaces)
- **Session naming** — async haiku call on first prompt, re-evaluates every 8 turns
- **Turn summaries** — async haiku call after agent_end, updates sidebar
- **Notifications** — native macOS notify + peon-ping on agent_end
- **Attention cycle** — needs-input on agent_end, clears instantly on user input
- **3 tools** — `cmux`, `cmux_status`, `cmux_notify`
- **Worker mode** — `PI_CMUX_ROLE=worker` keeps visibility, disables subprocess spawns
- **Fork-bomb prevention** — three-layer defense (--no-extensions, PI_CMUX_CHILD env, state resets)

## What's next (from the spec)

### Phase 1: spawn-pi tools (highest leverage)

New tools for the orchestrator:
- `spawn_pi` — launch a worker pi session in a cmux workspace
- `read_agent` — read a worker's terminal output
- `send_agent` — steer a worker mid-flight
- `kill_agent` — abort a worker

Fleet tracker: in-memory `Map<string, AgentInfo>` keyed by short UUID.

### Phase 2: Fleet dashboard

TUI widget (`ctx.ui.setWidget("fleet", ...)`) showing all agent status, tasks, elapsed time. Adaptive polling (3s active, 15s idle). cmux sidebar sync for cross-workspace visibility.

### Phase 3: pi-tasks integration

Task DAGs with dependency resolution. Shared file-backed stores. cmux-aware task execution. Worker claim protocol.

### Phase 4: RPC worker pool

Headless `pi --mode rpc` workers for high-throughput parallel tasks (lint, format, simple fixes). JSON-over-stdin control.

### Phase 5: Cross-session coordination

Shared task store protocol. Structured completion signals. Supervisor loop (nudge → restart → abandon).

## Development workflow

1. **Explore** in `~/Code/badass-courses/course-the-hive-multi-agent-orchestration/explorations/`
2. **Prototype** features as standalone scripts in exploration workspaces
3. **Prove** the pattern works end-to-end
4. **Merge** proven code into `cmux.ts` in this repo
5. **Document** decisions in the course project's `lat.md/build-log.md`

## Key patterns to follow

### Worker extension loading

Workers are real pi sessions with curated extensions — NOT lobotomized `--no-extensions` drones:

```bash
# Standard worker (most tasks)
PI_CMUX_ROLE=worker pi -e /path/to/pi-cmux/cmux.ts \
  --model openai-codex/gpt-5.5 "refactor the auth middleware"

# Lightweight worker (lint, format)
# Use the current global Pi model policy unless Joel explicitly approves a cheaper worker model.
PI_CMUX_ROLE=worker pi -e /path/to/pi-cmux/cmux.ts \
  --tools read,bash --model openai-codex/gpt-5.5 "lint src/"
```

### Agent identity

Each spawned agent gets a short UUID that traces through all layers:

```
cmux workspace → pi session → task store → fleet dashboard → completion handler
```

### Safety constraints

- Max concurrent agents: 5 (configurable)
- `PI_CMUX_ROLE=worker` disables subprocess spawns (no fork bombs)
- `PI_CMUX_CHILD=1` env guard for helper subprocesses
- Cleanup all spawned workspaces on `session_shutdown`

## Prior art patterns stolen

| Pattern | Source | Use |
|---------|--------|-----|
| LLM-based pane state detection | dmux `PaneAnalyzer` | Fleet monitoring — screen → cheap model → structured state |
| Smart attention service | dmux `DmuxAttentionService` | Armed/fingerprint/focus-aware notifications |
| Task queue + dependencies | pi-coordination | Priority-aware task scheduling with file reservations |
| Supervisor loop | pi-coordination | Nudge 3min → restart 5min → abandon after 2 restarts |
| Execute-and-collapse | pi-boomerang | Token efficiency — workers collapse context on completion |
| Polling/dispatch/monitor | jido_symphony | Battle-tested OTP GenServer pattern translated to TypeScript |
| Event-sourced coordination | swarm-tools | Append-only event log, file reservations, learning loop |
| Sandboxed execution contracts | joelclaw | Request/result types, lifecycle states, artifact export |
| Pi agent loops | atproto-agent-network | Observe→think→act→reflect, per-agent config, goal stacks |
