/**
 * Pure title composition. Slots whose value is empty are skipped entirely,
 * so a missing summary never leaves a dangling separator.
 */

import type { SlotName } from "./config.ts";

export interface TitleState {
	/** Attention glyph (⏸ waiting / ✓ done unseen / ✗ failed unseen); undefined when nothing is flagged. */
	status?: string;
	/** Current braille frame; undefined when the agent is idle. */
	spinnerFrame?: string;
	/** Static prefix icon ("π"). */
	icon?: string;
	/** Working-directory basename. */
	dir?: string;
	/** pi session name, when set. */
	session?: string;
	/** LLM-generated (or manually set) session summary. */
	summary?: string;
	/** Current model id. */
	model?: string;
	/** Name of the tool currently executing; undefined when no tool runs. */
	tool?: string;
}

export function slotValue(slot: SlotName, state: TitleState): string | undefined {
	switch (slot) {
		case "status":
			return state.status;
		case "spinner":
			return state.spinnerFrame;
		case "icon":
			return state.icon;
		case "dir":
			return state.dir;
		case "session":
			return state.session;
		case "summary":
			return state.summary;
		case "model":
			return state.model;
		case "tool":
			return state.tool;
	}
}

export function composeTitle(slots: readonly SlotName[], separator: string, state: TitleState): string {
	const parts: string[] = [];
	for (const slot of slots) {
		const value = slotValue(slot, state)?.trim();
		if (value) parts.push(value);
	}
	return parts.join(separator);
}
