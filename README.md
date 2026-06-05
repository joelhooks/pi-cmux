# pi-cmux

cmux integration extension for [pi](https://pi.dev). Standalone package — load in orchestrator sessions for full control, or in worker agents for visibility.

## What It Does

This extension activates for `pi` processes started inside a local cmux terminal surface **or** inside a `cmux ssh` remote relay. In zellij, plain shells, or ordinary SSH sessions outside cmux, it cleanly no-ops.

- **Sidebar status** — Running/Idle/Needs input with live tool activity
- **Model + usage metadata** — current provider/model/thinking plus context, token, and cost totals in the cmux sidebar
- **Pane stack** — shows the active cmux pane/surface stack and marks the pane running pi
- **Session naming** — optional 2-4 word session names from the first prompt (`PI_CMUX_SESSION_NAMING=1`)
- **Notifications** — native macOS notifications on agent_end + mark-unread tab indicator
- **Attention cycle** — workspace tab lights up when agent needs input, clears when you type
- **3 tools** — `cmux` (workspace/pane/surface control), `cmux_status` (sidebar), `cmux_notify` (notifications)
- **cmux ssh awareness** — discovers `~/.cmux/bin/cmux` when Pi subprocesses do not inherit cmux PATH/env, exposes `remote-status`, and degrades sidebar writes when the remote relay lacks those commands

## Install

```bash
pi install https://github.com/joelhooks/pi-cmux
```

## cmux SSH Mode

When running through `cmux ssh`, cmux installs a remote wrapper at `~/.cmux/bin/cmux`. Pi tool subprocesses may not inherit `CMUX_WORKSPACE_ID`, `CMUX_SOCKET_PATH`, or a PATH containing that wrapper, so the extension now discovers it directly.

Supported today:

- `cmux_notify` works through the remote relay and lights up the host cmux workspace.
- `cmux action="remote-status"` returns the host workspace's SSH relay state.
- `cmux action="identify"` falls back to `rpc system.identify` when the remote wrapper lacks the local `identify` command.
- `cmux_status action="sidebar-state"` falls back to the sidebar snapshot RPC.

Current stable cmux remote wrappers may not expose `set-status`, `set-progress`, or `log`. In that case lifecycle sidebar writes no-op cleanly, and `cmux_status` returns a clear unsupported-mode error instead of pretending it worked.

Use `PI_CMUX_BIN=/path/to/cmux` to force a specific cmux binary/wrapper.

## Worker Mode

For agents spawned by an orchestrator, set `PI_CMUX_ROLE=worker` to keep all visibility features while disabling subprocess spawns (session naming, turn summaries):

```bash
PI_CMUX_ROLE=worker pi --no-extensions -e /path/to/pi-cmux/cmux.ts \
  --model openai-codex/gpt-5.5 "fix the auth bug"
```

| Feature | Orchestrator | Worker |
|---------|-------------|--------|
| Sidebar status | ✅ | ✅ |
| Tool activity | ✅ | ✅ |
| Notifications | ✅ | ✅ |
| mark-read/unread | ✅ | ✅ |
| cmux tools | ✅ | ✅ |
| Session naming (subprocess) | ✅ | ❌ |
| Turn summary (subprocess) | ✅ | ❌ |

## Fork-Bomb Prevention

Three-layer defense against recursive subprocess spawns:

1. `--no-extensions` + `--no-session` on helper `pi -p` spawns
2. `PI_CMUX_CHILD=1` env guard — extension bails if set
3. Worker mode (`PI_CMUX_ROLE=worker`) — skips the features that spawn subprocesses entirely

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PI_CMUX_ROLE` | Set to `worker` for spawned agents |
| `PI_CMUX_AGENT_ID` | Worker fleet id for file-based status IPC |
| `PI_CMUX_SESSION_NAMING` | Set to `1` to enable helper-model session naming |
| `PI_CMUX_NAMING_MODEL` | Model for session naming (default: `openai-codex/gpt-5.5`) |
| `PI_CMUX_CHILD` | Set to `1` internally for helper subprocesses |
| `PI_CMUX_BIN` | Optional explicit cmux binary/wrapper path, useful for cmux ssh relay debugging |

## License

MIT
