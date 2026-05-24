# pi-cmux

cmux integration extension for [pi](https://pi.dev). Standalone package — load in orchestrator sessions for full control, or in worker agents for visibility.

## What It Does

This extension only activates for `pi` processes started inside a cmux terminal surface. In zellij, plain shells, or SSH sessions outside cmux, it cleanly no-ops.

- **Sidebar status** — Running/Idle/Needs input with live tool activity
- **Model + usage metadata** — current provider/model/thinking plus context, token, and cost totals in the cmux sidebar
- **Pane stack** — shows the active cmux pane/surface stack and marks the pane running pi
- **Session naming** — optional 2-4 word session names from the first prompt (`PI_CMUX_SESSION_NAMING=1`)
- **Notifications** — native macOS notifications on agent_end + mark-unread tab indicator
- **Attention cycle** — workspace tab lights up when agent needs input, clears when you type
- **3 tools** — `cmux` (workspace/pane/surface control), `cmux_status` (sidebar), `cmux_notify` (notifications)

## Install

```bash
pi install https://github.com/joelhooks/pi-cmux
```

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

## License

MIT
