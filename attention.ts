/**
 * "Needs your attention" signals: focus tracking, BEL, OSC 777 desktop
 * notifications, and the status glyphs shown in the tab title.
 * Pure module (no pi imports) so it is fully unit-testable.
 *
 * Ghostty handles the rest on its own: a BEL bounces the Dock icon once and
 * prefixes the tab title with 🔔 until the surface is focused again
 * (`bell-features = attention,title`, both on by default). Neither BEL nor a
 * notification ever moves focus.
 */

export const BEL = "\x07";

/** DECSET 1004 focus reporting: the terminal sends FOCUS_IN / FOCUS_OUT on stdin. */
export const ENABLE_FOCUS_REPORTING = "\x1b[?1004h";
export const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";
export const FOCUS_IN = "\x1b[I";
export const FOCUS_OUT = "\x1b[O";

export type RunOutcome = "completed" | "aborted" | "error";

/** What the tab is flagging. `waiting` lasts while a prompt is open; `done`/`error` until the tab is focused. */
export type Attention = "waiting" | "done" | "error";

const STATUS_GLYPHS: Record<Attention, string> = {
	waiting: "⏸",
	done: "✓",
	error: "✗",
};

export function statusGlyph(attention: Attention | undefined): string | undefined {
	return attention ? STATUS_GLYPHS[attention] : undefined;
}

/**
 * Latest focus change in a raw stdin chunk: true = focused, false = blurred,
 * undefined = the chunk carries no focus event. A chunk can hold several
 * events (fast tab switching); the last one wins.
 */
export function lastFocusEvent(chunk: string): boolean | undefined {
	const lastIn = chunk.lastIndexOf(FOCUS_IN);
	const lastOut = chunk.lastIndexOf(FOCUS_OUT);
	if (lastIn === -1 && lastOut === -1) return undefined;
	return lastIn > lastOut;
}

/**
 * Outcome of an agent run. `aborted` is the run's own abort signal and wins:
 * an Esc can surface as `stopReason: "error"` ("This operation was aborted")
 * when the provider request was not wired to that signal. Otherwise the last
 * assistant message's stop reason decides.
 */
export function runOutcome(messages: readonly unknown[], aborted = false): RunOutcome {
	if (aborted) return "aborted";
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: unknown; stopReason?: unknown } | undefined;
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "error") return "error";
		if (message.stopReason === "aborted") return "aborted";
		return "completed";
	}
	return "completed";
}

/** "8s", "3m 12s", "1h 5m". */
export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

/**
 * OSC fields cannot carry control characters, and `;` separates the
 * title from the body in OSC 777, so both are neutralized.
 */
export function oscText(text: string, maxLength = 200): string {
	const clean = text
		.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ")
		.replace(/;/g, ",")
		.replace(/\s+/g, " ")
		.trim();
	return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
}

/** OSC 777 desktop notification (rxvt form, supported by Ghostty): ESC ] 777 ; notify ; title ; body BEL */
export function notifySequence(title: string, body: string): string {
	return `\x1b]777;notify;${oscText(title, 80)};${oscText(body)}\x07`;
}

export interface SignalDecision {
	attention: Attention | undefined;
	/** Ring the bell / post a notification. */
	signal: boolean;
}

/**
 * What to do when a run settles. Nothing is flagged while the tab is
 * focused — you watched it happen. A completed run only rings when it ran
 * long enough to have been worth walking away from; an error always rings.
 * An abort is your own doing and flags nothing.
 */
export function settleDecision(outcome: RunOutcome, focused: boolean, elapsedMs: number, thresholdMs: number): SignalDecision {
	if (focused || outcome === "aborted") return { attention: undefined, signal: false };
	if (outcome === "error") return { attention: "error", signal: true };
	return { attention: "done", signal: elapsedMs >= thresholdMs };
}

export function notificationBody(attention: Attention, detail: { elapsedMs?: number; promptTitle?: string }): string {
	switch (attention) {
		case "waiting":
			return detail.promptTitle ? `Waiting for you: ${detail.promptTitle}` : "Waiting for you";
		case "done":
			return detail.elapsedMs !== undefined ? `Done in ${formatDuration(detail.elapsedMs)}` : "Done";
		case "error":
			return detail.elapsedMs !== undefined ? `Failed after ${formatDuration(detail.elapsedMs)}` : "Failed";
	}
}
