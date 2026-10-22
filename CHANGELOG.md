# Changelog

## [Unreleased]

## [0.2.1] - 2026-10-22

### Fixed

- The automatic summary now fires when the first user message starts, instead of at `agent_start`. pi emits extension events before it appends the prompt to the session, so at `agent_start` there was no user text yet and the call returned without even counting an attempt; the title then only showed up at the `agent_end` fallback, i.e. once the first run was basically over. The prompt text is now passed to the summary call directly, and `agent_end` stays as the fallback for runs that start without a visible user message.

## [0.2.0] - 2026-10-07

### Added

- Attention signals for tabs you are not looking at. Focus is tracked via terminal focus reporting (DECSET 1004, read from stdin even in fullscreen mode, where pi consumes the events before extensions see them). When the tab is unfocused: a finished run rings the bell and posts an OSC 777 desktop notification (only past `notifyAfterSeconds`, default 20); a failed run always does; a blocking prompt (permission ask, select, input) always does. Nothing rings while the tab is focused, and nothing moves focus.
- `status` slot: `⏸` while a prompt waits, `✓` / `✗` for a run that finished / failed while you were away, cleared when you focus the tab. First in the default slot list.
- Progress bar states: red (held until focus) when a run fails in the background, red flash when it fails in front of you, orange (paused) while a prompt waits mid-run, plain clear on abort. Held states are re-sent every 5s — Ghostty drops a progress state after 15s without an update.
- Config: `bell`, `notify`, `notifyAfterSeconds`.
- An abort is judged by the run's own abort signal (captured at `agent_start`): an Esc mid-tool can be recorded as `stopReason: "error"` with "This operation was aborted" when the provider request was not wired to the run's signal, and must not ring as a failure.
- README setup checklist: Ghostty needs macOS notification permission (silently dropped otherwise); `bell-features` is silent by default.
- `/tab test`: opens a prompt after 5s so you can check the bell and notification from another tab. `/tab` now also reports focus and attention state.

### Changed

- The progress flash and "done" moment moved from `agent_end` to `agent_settled`, so a retry or auto-compaction no longer flashes "finished" mid-run.
- When a title of ours empties again (a status-only layout whose `✓` just cleared), pi's default `π - <dir>` title is restored instead of leaving the stale one up.

## [0.1.0] - 2026-10-06

Initial release.

- Slot-configurable Ghostty tab title: `spinner`, `icon`, `dir`, `session`, `summary`, `model`, `tool` in any order, empty slots skipped (`ghosttyTab.slots` / `ghosttyTab.separator` in settings.json)
- Braille spinner while the agent works; live tool-name slot
- Session summary three ways: automatic nested model call after the first turn (strict 2–6 word / ≤40 char prompt + sanitizing), the `set_session_summary` tool for the LLM, and `/tab set|clear|regen` for the user; persisted via `pi.appendEntry` so it survives resume
- OSC 9;4 native progress bar with `progress: "auto" | "on" | "off"` — auto yields to pi core's `terminal.showTerminalProgress`

[Unreleased]: https://github.com/Andy8647/pi-ghostty-tab/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/Andy8647/pi-ghostty-tab/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Andy8647/pi-ghostty-tab/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Andy8647/pi-ghostty-tab/releases/tag/v0.1.0
