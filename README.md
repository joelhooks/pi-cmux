# pi-cmux

cmux integration extension for [pi](https://pi.dev). Standalone package — load in orchestrator sessions for full control, or in worker agents for visibility.

## What It Does

- **Sidebar status** — Running/Idle/Needs input with live tool activity
- **Session naming** — auto-generates 2-4 word session name from first prompt
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
  --model claude-sonnet-4 "fix the auth bug"
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
| `PI_CMUX_NAMING_MODEL` | Model for session naming (default: `claude-haiku-4-5`) |
| `PI_CMUX_CHILD` | Set to `1` internally for helper subprocesses |

## License

MIT
