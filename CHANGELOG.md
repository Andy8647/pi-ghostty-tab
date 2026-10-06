# Changelog

## [Unreleased]

## [0.1.0] - 2026-10-06

Initial release.

- Slot-configurable Ghostty tab title: `spinner`, `icon`, `dir`, `session`, `summary`, `model`, `tool` in any order, empty slots skipped (`ghosttyTab.slots` / `ghosttyTab.separator` in settings.json)
- Braille spinner while the agent works; live tool-name slot
- Session summary three ways: automatic nested model call after the first turn (strict 2–6 word / ≤40 char prompt + sanitizing), the `set_session_summary` tool for the LLM, and `/tab set|clear|regen` for the user; persisted via `pi.appendEntry` so it survives resume
- OSC 9;4 native progress bar with `progress: "auto" | "on" | "off"` — auto yields to pi core's `terminal.showTerminalProgress`

[Unreleased]: https://github.com/Andy8647/pi-ghostty-tab/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Andy8647/pi-ghostty-tab/releases/tag/v0.1.0
