/**
 * Ghostty's native progress bar: OSC 9;4 (ConEmu's progress subcommand,
 * also supported by Windows Terminal). Bytes are written to /dev/tty
 * directly, bypassing pi's TUI to avoid rendering interference.
 *
 * Sequence form: ESC ] 9 ; 4 ; <state> [ ; <value> ] BEL
 *   0 = clear, 1 = set value (0-100), 2 = error, 3 = indeterminate, 4 = paused
 */

import { writeFileSync } from "node:fs";

export const ProgressState = {
	Clear: 0,
	Set: 1,
	Error: 2,
	Indeterminate: 3,
	Paused: 4,
} as const;

export type WriteFn = (seq: string) => void;

export function progressSequence(state: number, value?: number): string {
	const args = value !== undefined ? `${state};${value}` : `${state}`;
	return `\x1b]9;4;${args}\x07`;
}

/** Writes to /dev/tty; silently no-ops where /dev/tty is unavailable (e.g. subagents). */
export function createTtyWriter(): WriteFn {
	return (seq) => {
		try {
			writeFileSync("/dev/tty", seq);
		} catch {
			// /dev/tty unavailable
		}
	};
}
