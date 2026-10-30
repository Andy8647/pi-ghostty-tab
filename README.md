# pi-ghostty-tab

A [pi](https://github.com/earendil-works/pi) extension that puts a fully configurable title in your Ghostty tab — pick exactly which slots you want, in the order you want them. Comes with a braille spinner while the agent works, an LLM-generated session summary (Claude Code style), live tool tracking, Ghostty's native OSC 9;4 progress bar, and attention signals that tell you which tab finished, failed, or is waiting on you.

Inspired by [HazAT/pi-ghostty](https://github.com/HazAT/pi-ghostty); rewritten from scratch around the slot system.

```
⠹ π my-project · bash           ← working: spinner + active tool
π my-project · Agents.md docs     ← idle: LLM summary instead of the model
⏸ π my-project · Agents.md docs   ← a permission prompt is waiting on you
✓ π my-project · Agents.md docs   ← finished while you were in another tab
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
| `status` | `⏸` / `✓` / `✗` | Prompt waiting / finished or failed while you were away (see [Attention](#attention)) |
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

Default (no config): `["status", "spinner", "icon", "dir", "session", "summary", "tool", "model"]` — roughly the original pi-ghostty layout.

If every slot is empty, the title is not touched until something shows up; once a title of ours has been set and then empties again (a `✓` clearing on a status-only layout), pi's own `π - <dir>` title is put back.

## Session summary

Three ways the `summary` slot gets filled, in priority order:

1. **You**: `/tab set <text>` (also `/tab clear`, `/tab regen`, `/tab test`, plain `/tab` for status).
2. **The LLM**: a `set_session_summary` tool it can call once it understands your task, and again if the topic changes.
3. **Automatic**: after the first agent turn, the extension fires a small nested model call (your current model, off the main conversation) with a strict prompt — 2–6 words, ≤40 characters, no quotes/emoji/punctuation, your language. The result is sanitized again before it ever reaches your tab.

The summary is persisted into the session file (`pi.appendEntry`), so it survives `/resume`. pi core re-writes its own `π - <dir>` title right after extension startup and on every rename, so the extension watches terminal writes and takes its title back; that is also what keeps a resumed summary on screen instead of blinking away.

Config:

```json
{
  "ghosttyTab": {
    "autoSummary": true,
    "summaryMaxLength": 40
  }
}
```

## Attention

Run several pi tabs at once and the question is always which one needs you. The extension tracks whether its own tab is focused and signals only when it is not:

| What happened | Progress bar | `status` slot | Bell + notification |
| --- | --- | --- | --- |
| Run finished | brief full bar | `✓` until you focus the tab | if it ran at least `notifyAfterSeconds` (default 20) |
| Run failed | red, held until you focus the tab | `✗` until you focus the tab | always |
| A prompt is waiting (permission ask, select, input) | orange (paused) while it is open, during a run | `⏸` while it is open | always |
| You aborted it (Esc) | cleared | — | never |

Nothing is flagged or rung while the tab is focused — you watched it happen.

Colors are Ghostty's, not ours: it draws the error state red, the paused state orange, and everything else (working, finished) in the system accent color.

An abort is judged by the run's own abort signal, not just the stop reason: with some providers an Esc in the middle of a tool call is recorded as `stopReason: "error"` ("This operation was aborted"), and treating that as a failure would ring a false alarm.

- **Bell**: a plain BEL. With Ghostty's default `bell-features` (`attention,title`) it prefixes the tab title with 🔔 until you come back, and bounces the Dock icon once — the bounce only happens while Ghostty is not the frontmost app. The default is silent (`no-audio`); add `audio` to `bell-features` if you want a sound. Neither the bell nor the notification moves focus or switches tabs.
- **Notification**: OSC 777, titled with the session summary, e.g. `Agents.md docs — Done in 3m 12s` or `Waiting for you: Auto mode permission ask`. It shows even when you are only in another Ghostty tab (Ghostty presents it whenever the sending surface is not focused) and Ghostty withdraws it once you focus that tab. It plays the system notification sound.
- **Focus tracking** uses terminal focus reporting (DECSET 1004). In fullscreen mode pi already enables it; in regular mode the extension turns it on, swallows the focus sequences before the editor sees them, and turns it off on exit.
- Try it: `/tab test` opens a prompt after 5 seconds — switch to another tab and wait.

### Setup checklist (macOS)

Nothing arrives? Check, in order:

1. **System Settings → Notifications → Ghostty → Allow notifications.** Off by default until Ghostty has asked; while it is off, every notification is dropped silently. The 🔔 in the tab title still appears, since that is the bell, not a notification.
2. Focus / Do Not Disturb is not hiding them.
3. Ghostty's `desktop-notifications` is `true` (the default).

Ghostty's own `notify-on-command-finish` cannot do this for pi: it watches shell commands, and pi is one long-running command.

```json
{
  "ghosttyTab": {
    "bell": true,
    "notify": true,
    "notifyAfterSeconds": 20
  }
}
```

## Progress bar

Ghostty 1.2+ renders a native tab/progress indicator for OSC 9;4: an indeterminate pulse while the agent works, a brief full bar when it finishes, red on failure, orange while a prompt waits. Ghostty drops a progress state after 15 seconds without an update, so held states are re-sent every 5 seconds.

pi core already has this via `terminal.showTerminalProgress`, and both writers would fight over the same protocol. So:

```json
{
  "ghosttyTab": {
    "progress": "auto"
  }
}
```

- `"auto"` (default): drive the bar only when core's `terminal.showTerminalProgress` is off. Core only knows "working" and "idle", so with core in charge the red/orange attention states do not appear — turn core's off to get them.
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
| `bell` | boolean | `true` | Ring the bell when an unfocused tab needs you |
| `notify` | boolean | `true` | Post a desktop notification when an unfocused tab needs you |
| `notifyAfterSeconds` | number (0–3600) | `20` | Minimum run length before a finished run rings (errors and prompts always ring) |

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
| `agent_end` | Stop spinner, record the outcome, maybe generate summary |
| `agent_settled` | Run is really over (no retry/compaction left): progress flash, `✓`/`✗`, bell + notification |
| `ui_prompt_start` / `end` | `⏸` + paused bar while a prompt waits; bell + notification if unfocused |
| `session_shutdown` | Clear progress bar, detach focus tracking |

## License

MIT
