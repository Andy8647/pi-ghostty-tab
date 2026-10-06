# pi-ghostty-tab

A [pi](https://github.com/earendil-works/pi) extension that puts a fully configurable title in your Ghostty tab — pick exactly which slots you want, in the order you want them. Comes with a braille spinner while the agent works, an LLM-generated session summary (Claude Code style), live tool tracking, and Ghostty's native OSC 9;4 progress bar.

Inspired by [HazAT/pi-ghostty](https://github.com/HazAT/pi-ghostty); rewritten from scratch around the slot system.

```
⠹ π my-project · bash           ← working: spinner + active tool
π my-project · Agents.md docs     ← idle: LLM summary instead of the model
```

## Install

```
pi install npm:pi-ghostty-tab
```

Or try it without installing:

```
pi -e npm:pi-ghostty-tab
```

## Slots

The title is a list of **slots** joined by a separator. Configure the list in `~/.pi/agent/settings.json` under the `ghosttyTab` key:

```json
{
  "ghosttyTab": {
    "slots": ["spinner", "summary"],
    "separator": " · "
  }
}
```

| Slot | Shows | When |
| --- | --- | --- |
| `spinner` | Animated braille frame | Only while the agent is working |
| `icon` | `π` | Always |
| `dir` | Working directory basename | Always |
| `session` | pi session name | When one is set |
| `summary` | LLM session summary | Once generated or set |
| `model` | Current model id | Always |
| `tool` | Name of the executing tool | Only while a tool runs |

Rules:

- Order is exactly the order of your array.
- Empty slots are skipped — no dangling separators. `summary` before it exists simply disappears, so `["spinner", "summary", "model"]` gracefully degrades to spinner + model at session start.
- Unknown slot names warn at session start and are ignored.

Default (no config): `["spinner", "icon", "dir", "session", "summary", "tool", "model"]` — roughly the original pi-ghostty layout.

## Session summary

Three ways the `summary` slot gets filled, in priority order:

1. **You**: `/tab set <text>` (also `/tab clear`, `/tab regen`, plain `/tab` for status).
2. **The LLM**: a `set_session_summary` tool it can call once it understands your task, and again if the topic changes.
3. **Automatic**: after the first agent turn, the extension fires a small nested model call (your current model, off the main conversation) with a strict prompt — 2–6 words, ≤40 characters, no quotes/emoji/punctuation, your language. The result is sanitized again before it ever reaches your tab.

The summary is persisted into the session file (`pi.appendEntry`), so it survives `/resume`.

Config:

```json
{
  "ghosttyTab": {
    "autoSummary": true,
    "summaryMaxLength": 40
  }
}
```

## Progress bar

Ghostty 1.2+ renders a native tab/progress indicator for OSC 9;4: an indeterminate pulse while the agent works, a green 100% flash when it finishes.

pi core already has this via `terminal.showTerminalProgress`, and both writers would fight over the same protocol. So:

```json
{
  "ghosttyTab": {
    "progress": "auto"
  }
}
```

- `"auto"` (default): drive the bar only when core's `terminal.showTerminalProgress` is off.
- `"on"`: always drive it (turn core's off yourself).
- `"off"`: never touch it.

## Full config reference

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Master switch for the title |
| `slots` | string[] | see above | Title slots in display order |
| `separator` | string | `" · "` | Join string |
| `progress` | `"auto"\|"on"\|"off"` | `"auto"` | OSC 9;4 progress bar |
| `autoSummary` | boolean | `true` | Generate a summary after the first turn |
| `summaryMaxLength` | number (10–120) | `40` | Hard cap for summaries |

## Requirements

- [Ghostty](https://ghostty.org) 1.2+ for the native progress bar (the title works in any terminal)
- [pi](https://github.com/earendil-works/pi) coding agent

## How it works

The extension hooks pi's lifecycle events. The title goes through pi's `ctx.ui.setTitle`; the progress bar is written as OSC escape sequences directly to `/dev/tty`, bypassing pi's TUI to avoid rendering interference. The summary call uses `ctx.modelRegistry.streamSimple`, so it never touches your main conversation.

| pi event | Effect |
| --- | --- |
| `session_start` | Read config, restore persisted summary, set title |
| `session_info_changed` | Update session-name slot |
| `model_select` | Update model slot |
| `agent_start` | Start spinner, indeterminate progress |
| `tool_execution_start` / `end` | Show / clear the tool slot |
| `agent_end` | Stop spinner, green 100% flash, maybe generate summary |
| `session_shutdown` | Clear progress bar |

## License

MIT
