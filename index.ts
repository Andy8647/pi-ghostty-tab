/**
 * pi-ghostty-tab — slot-configurable Ghostty tab title + native progress bar.
 *
 * The window title is composed from user-configured slots
 * (spinner / icon / dir / session / summary / model / tool); empty slots are
 * skipped. A braille spinner animates while the agent works, and a short
 * session summary is generated once (nested model call) or set by the LLM
 * via the set_session_summary tool. OSC 9;4 drives Ghostty's native
 * progress bar, yielding to pi core's terminal.showTerminalProgress in
 * "auto" mode. Inspired by HazAT/pi-ghostty.
 */

import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type Attention,
	BEL,
	DISABLE_FOCUS_REPORTING,
	ENABLE_FOCUS_REPORTING,
	FOCUS_IN,
	FOCUS_OUT,
	lastFocusEvent,
	notificationBody,
	notifySequence,
	type RunOutcome,
	runOutcome,
	settleDecision,
	statusGlyph,
} from "./attention.ts";
import { loadConfig, progressEnabled, type LoadedConfig } from "./config.ts";
import { createTtyWriter, ProgressState, progressSequence, type WriteFn } from "./progress.ts";
import { assistantText, buildSummaryUserPrompt, sanitizeSummary, SUMMARY_SYSTEM_PROMPT } from "./summary.ts";
import { composeTitle, type TitleState } from "./title.ts";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
const COMPLETION_FLASH_MS = 800;
/** How long a red bar stays when the run failed while you were watching. */
const ERROR_FLASH_MS = 3000;
/** Re-send a held progress state so the terminal never times it out (pi core does the same, every 1s). */
const PROGRESS_KEEPALIVE_MS = 5000;
const TEST_DELAY_MS = 5000;
/** Process-wide guard: the exit hook must be installed once even across /reload. */
const EXIT_HOOK_KEY = Symbol.for("pi-ghostty-tab:focus-exit-hook");
const SUMMARY_ENTRY_TYPE = "pi-ghostty-tab:summary";
/** How many opening user messages (and how much of each) feed the summary call. */
const SUMMARY_MAX_MESSAGES = 5;
const SUMMARY_CHARS_PER_MESSAGE = 800;
const SUMMARY_MAX_ATTEMPTS = 3;

/** The slice of stdin the focus tap needs; injectable for tests. */
export type FocusInput = Pick<NodeJS.ReadStream, "isTTY" | "on" | "off">;

export default function (pi: ExtensionAPI, write: WriteFn = createTtyWriter(), input: FocusInput = process.stdin) {
	const loaded: LoadedConfig = loadConfig();
	const { config } = loaded;
	const progressOn = progressEnabled(loaded);

	let currentModel: string | undefined;
	let sessionName: string | undefined;
	let summary: string | undefined;
	let cwd = process.cwd();
	let isWorking = false;
	let currentTool: string | undefined;
	let frameIndex = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	let completionTimer: ReturnType<typeof setTimeout> | undefined;
	let lastCtx: ExtensionContext | undefined;
	let warningsNotified = false;
	let summaryAttempts = 0;
	let summaryInFlight = false;

	// Attention state. `focused` starts true: pi was just launched from this tab.
	let focused = true;
	let attention: Attention | undefined;
	let promptTitle: string | undefined;
	/** Spans agent_start → agent_settled, i.e. across retries and auto-compaction. */
	let runActive = false;
	let runStartedAt = 0;
	let lastOutcome: RunOutcome = "completed";
	/** The current agent run's abort signal, captured at agent_start (each retry gets a new one). */
	let runSignal: AbortSignal | undefined;
	let progressKeepalive: ReturnType<typeof setInterval> | undefined;
	/** The red bar is held until the tab is focused. */
	let errorHeld = false;
	let detachFocus: (() => void) | undefined;
	/** Whether the tab currently shows a title we composed (vs. pi's own). */
	let titlePushed = false;

	// ---- title rendering ------------------------------------------------

	function titleState(): TitleState {
		return {
			status: statusGlyph(attention),
			spinnerFrame: isWorking && attention !== "waiting" ? BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length] : undefined,
			icon: "π",
			dir: path.basename(cwd),
			session: sessionName,
			summary,
			model: currentModel,
			tool: currentTool,
		};
	}

	function currentTitle(): string {
		return composeTitle(config.slots, config.separator, titleState());
	}

	function renderTitle(ctx: ExtensionContext): void {
		if (!config.enabled || !ctx.hasUI) return;
		const title = currentTitle();
		if (title) {
			titlePushed = true;
			ctx.ui.setTitle(title);
			return;
		}
		// Never blank the tab. Before our first title, pi's own title stays put;
		// after it (a ✓ that just cleared, say), put pi's default back so the
		// stale one does not linger.
		if (titlePushed) {
			titlePushed = false;
			ctx.ui.setTitle(sessionName ? `π - ${sessionName} - ${path.basename(cwd)}` : `π - ${path.basename(cwd)}`);
		}
	}

	// ---- progress bar ------------------------------------------------------

	function clearProgressTimers(): void {
		if (progressKeepalive) clearInterval(progressKeepalive);
		if (completionTimer) clearTimeout(completionTimer);
		progressKeepalive = undefined;
		completionTimer = undefined;
		errorHeld = false;
	}

	/** Every progress write goes through here, so a newer state always cancels pending flashes. */
	function setProgress(state: number, value?: number): void {
		if (!progressOn) return;
		clearProgressTimers();
		const seq = progressSequence(state, value);
		write(seq);
		if (state !== ProgressState.Clear) {
			progressKeepalive = setInterval(() => write(seq), PROGRESS_KEEPALIVE_MS);
		}
	}

	function flashProgress(state: number, durationMs: number): void {
		if (!progressOn) return;
		setProgress(state, 100);
		completionTimer = setTimeout(() => setProgress(ProgressState.Clear), durationMs);
	}

	// ---- spinner -----------------------------------------------------------

	function startSpinner(ctx: ExtensionContext): void {
		if (spinnerTimer) clearInterval(spinnerTimer);
		isWorking = true;
		currentTool = undefined;
		frameIndex = 0;
		spinnerTimer = setInterval(() => {
			// A waiting tab shows ⏸ instead of a spinner; nothing to animate.
			if (attention === "waiting") return;
			frameIndex++;
			renderTitle(ctx);
		}, SPINNER_INTERVAL_MS);
	}

	function stopSpinner(ctx: ExtensionContext): void {
		isWorking = false;
		currentTool = undefined;
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = undefined;
		}
		renderTitle(ctx);
	}

	// ---- attention ---------------------------------------------------------

	function notifyTitle(): string {
		return summary || sessionName || `pi · ${path.basename(cwd)}`;
	}

	/** Bell + desktop notification. Neither moves focus: the bell bounces the Dock icon and marks the tab with 🔔. */
	function ring(kind: Attention, detail: { elapsedMs?: number; promptTitle?: string }): void {
		if (config.bell) write(BEL);
		if (config.notify) write(notifySequence(notifyTitle(), notificationBody(kind, detail)));
	}

	function onRunSettled(ctx: ExtensionContext): void {
		const elapsedMs = Date.now() - runStartedAt;
		const decision = settleDecision(lastOutcome, focused, elapsedMs, config.notifyAfterSeconds * 1000);
		attention = decision.attention;
		if (decision.signal && attention) ring(attention, { elapsedMs });

		if (lastOutcome === "completed") {
			flashProgress(ProgressState.Set, COMPLETION_FLASH_MS);
		} else if (lastOutcome === "error") {
			if (focused) {
				flashProgress(ProgressState.Error, ERROR_FLASH_MS);
			} else {
				setProgress(ProgressState.Error, 100);
				errorHeld = true;
			}
		} else {
			setProgress(ProgressState.Clear);
		}
		renderTitle(ctx);
	}

	function onFocusChange(isFocused: boolean): void {
		if (focused === isFocused) return;
		focused = isFocused;
		if (!isFocused) return;
		// Coming back to the tab is what "seen" means.
		if (errorHeld) setProgress(ProgressState.Clear);
		if (attention === "done" || attention === "error") {
			attention = undefined;
			if (lastCtx) renderTitle(lastCtx);
		}
	}

	/**
	 * Focus events are read by tapping stdin directly: in fullscreen mode pi's
	 * own viewport listener is registered before any extension and consumes
	 * FOCUS_IN/FOCUS_OUT, so `onTerminalInput` never sees them. The tap only
	 * listens; pi keeps reading stdin as before.
	 *
	 * Regular mode does not enable focus reporting, so we turn it on and
	 * swallow the two sequences before they reach the editor.
	 */
	function attachFocus(ctx: ExtensionContext): void {
		detachFocus?.();
		if (!input.isTTY) return;
		const tap = (chunk: string | Buffer) => {
			const event = lastFocusEvent(typeof chunk === "string" ? chunk : chunk.toString("latin1"));
			if (event !== undefined) onFocusChange(event);
		};
		input.on("data", tap);
		const unsubscribe = ctx.ui.onTerminalInput((data) =>
			data === FOCUS_IN || data === FOCUS_OUT ? { consume: true } : undefined,
		);
		write(ENABLE_FOCUS_REPORTING);
		const globals = globalThis as Record<symbol, unknown>;
		if (!globals[EXIT_HOOK_KEY]) {
			globals[EXIT_HOOK_KEY] = true;
			// Leave the shell as we found it. Harmless in fullscreen mode, where
			// pi has already turned it off along with mouse tracking.
			process.once("exit", () => write(DISABLE_FOCUS_REPORTING));
		}
		detachFocus = () => {
			input.off("data", tap);
			unsubscribe();
			detachFocus = undefined;
		};
	}

	// ---- summary ----------------------------------------------------------

	function applySummary(text: string, ctx: ExtensionContext): string | undefined {
		const clean = sanitizeSummary(text, config.summaryMaxLength);
		if (!clean) return undefined;
		summary = clean;
		pi.appendEntry(SUMMARY_ENTRY_TYPE, { summary: clean });
		renderTitle(ctx);
		return clean;
	}

	function restoreSummary(ctx: ExtensionContext): void {
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === SUMMARY_ENTRY_TYPE) {
				const data = entry.data as { summary?: unknown } | undefined;
				if (typeof data?.summary === "string" && data.summary.trim()) {
					summary = data.summary;
				}
			}
		}
	}

	/** Flatten a user message's content into prompt-ready text. */
	function userMessageText(content: unknown): string {
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.filter((block) => block?.type === "text" && typeof block.text === "string")
							.map((block) => block.text as string)
							.join("\n")
					: "";
		return text.trim();
	}

	/**
	 * Opening user messages already persisted in the session.
	 * `pending` is the message being appended right now: pi emits extension events
	 * *before* it appends the entry, so at message_start it is not in here yet.
	 */
	function collectUserTexts(ctx: ExtensionContext, pending?: string): string[] {
		const texts: string[] = [];
		for (const entry of ctx.sessionManager.getEntries()) {
			if (texts.length >= SUMMARY_MAX_MESSAGES) break;
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role !== "user") continue;
			const trimmed = userMessageText(message.content);
			if (trimmed) texts.push(trimmed.slice(0, SUMMARY_CHARS_PER_MESSAGE));
		}
		const trimmedPending = pending?.trim();
		if (trimmedPending && !texts.includes(trimmedPending.slice(0, SUMMARY_CHARS_PER_MESSAGE))) {
			texts.push(trimmedPending.slice(0, SUMMARY_CHARS_PER_MESSAGE));
		}
		return texts;
	}

	/** Fire-and-forget nested model call; never throws, never blocks the agent. */
	async function generateSummary(ctx: ExtensionContext, pending?: string): Promise<void> {
		if (!config.autoSummary || summary !== undefined || summaryInFlight) return;
		if (summaryAttempts >= SUMMARY_MAX_ATTEMPTS) return;
		const model = ctx.model;
		if (!model) return;
		const userTexts = collectUserTexts(ctx, pending);
		if (userTexts.length === 0) return;

		summaryAttempts++;
		summaryInFlight = true;
		const sessionFile = ctx.sessionManager.getSessionFile();
		try {
			const stream = ctx.modelRegistry.streamSimple(model, {
				systemPrompt: SUMMARY_SYSTEM_PROMPT,
				messages: [{ role: "user", content: buildSummaryUserPrompt(userTexts), timestamp: Date.now() }],
			});
			const message = await stream.result();
			if (message.stopReason === "error") return;
			// The user may have switched sessions while the call was in flight;
			// only apply when we are still in the same session.
			if (!lastCtx || lastCtx.sessionManager.getSessionFile() !== sessionFile) return;
			const clean = sanitizeSummary(assistantText(message.content), config.summaryMaxLength);
			if (clean) applySummary(clean, lastCtx);
		} catch {
			// summary is best-effort
		} finally {
			summaryInFlight = false;
		}
	}

	const setSummaryTool = defineTool({
		name: "set_session_summary",
		label: "Set Session Summary",
		description:
			"Set the short title of this session, shown in the user's terminal tab. Call this once as soon as you understand the user's task, and again whenever the topic changes significantly. The summary MUST be 2-6 words and at most 40 characters: plain text only, no quotes, no emoji, no trailing punctuation, in the user's language.",
		parameters: Type.Object({
			summary: Type.String({ description: "2-6 words, <=40 characters, plain text" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const clean = applySummary(params.summary, ctx);
			if (!clean) {
				return { content: [{ type: "text", text: "Summary rejected: empty after sanitizing. Keep it 2-6 plain words." }], details: {} };
			}
			return { content: [{ type: "text", text: `Session tab title set to "${clean}".` }], details: { summary: clean } };
		},
	});

	pi.registerTool(setSummaryTool);

	// ---- /tab command -----------------------------------------------------

	pi.registerCommand("tab", {
		description: "Terminal tab title: /tab shows status, /tab set <text> sets the summary, /tab clear, /tab regen, /tab test",
		getArgumentCompletions: (prefix) => {
			const args = [
				{ value: "set", label: "set <text>", description: "Set the tab summary manually" },
				{ value: "clear", label: "clear", description: "Remove the summary (slot falls back away)" },
				{ value: "regen", label: "regen", description: "Regenerate the summary with the current model" },
				{ value: "test", label: "test", description: "Open a prompt in 5s — switch tabs to see the bell and notification" },
			];
			return args.filter((a) => a.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const input = args.trim();
			if (!input) {
				ctx.ui.notify(
					[
						`title: "${currentTitle() || "(empty)"}"`,
						`slots: ${config.slots.join(", ")}`,
						`summary: ${summary ?? "(none)"}`,
						`progress: ${config.progress}${config.progress === "auto" ? (progressOn ? " (auto: ours)" : " (auto: pi core)") : ""}`,
						`attention: ${attention ?? "(none)"} · focused: ${focused} · tracking: ${detachFocus ? "on" : "off"}`,
						`bell: ${config.bell} · notify: ${config.notify} · notifyAfterSeconds: ${config.notifyAfterSeconds}`,
					].join("\n"),
					"info",
				);
				return;
			}
			if (input === "test") {
				ctx.ui.notify(`Switch to another tab now — a prompt opens in ${TEST_DELAY_MS / 1000}s.`, "info");
				const sessionFile = ctx.sessionManager.getSessionFile();
				setTimeout(() => {
					if (!lastCtx || lastCtx.sessionManager.getSessionFile() !== sessionFile) return;
					const testCtx = lastCtx;
					void testCtx.ui
						.confirm("pi-ghostty-tab test", "This prompt is the test. Did the bell and notification arrive while you were away?")
						.then((ok) => testCtx.ui.notify(ok ? "Attention signals work." : "Check Ghostty's notification permission and bell-features.", ok ? "info" : "warning"))
						.catch(() => {});
				}, TEST_DELAY_MS);
				return;
			}
			if (input === "clear") {
				summary = undefined;
				pi.appendEntry(SUMMARY_ENTRY_TYPE, { summary: "" });
				renderTitle(ctx);
				ctx.ui.notify("Tab summary cleared.", "info");
				return;
			}
			if (input === "regen") {
				summary = undefined;
				summaryAttempts = 0;
				await generateSummary(ctx);
				ctx.ui.notify(summary ? `Tab summary regenerated: "${summary}"` : "Summary regeneration failed (no model or empty result).", summary ? "info" : "warning");
				return;
			}
			if (input === "set" || input.startsWith("set ")) {
				const text = input === "set" ? "" : input.slice(4).trim();
				if (!text) {
					ctx.ui.notify("Usage: /tab set <text>", "warning");
					return;
				}
				const clean = applySummary(text, ctx);
				ctx.ui.notify(clean ? `Tab summary set to "${clean}".` : "Summary rejected: empty after sanitizing.", clean ? "info" : "warning");
				return;
			}
			ctx.ui.notify("Usage: /tab [set <text> | clear | regen]", "warning");
		},
	});

	// ---- lifecycle events ---------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		if (!ctx.hasUI) return;
		currentModel = ctx.model?.id;
		sessionName = pi.getSessionName();
		cwd = ctx.cwd;
		summary = undefined;
		summaryAttempts = 0;
		attention = undefined;
		restoreSummary(ctx);
		attachFocus(ctx);
		renderTitle(ctx);
		if (!warningsNotified && loaded.warnings.length > 0) {
			warningsNotified = true;
			ctx.ui.notify(`pi-ghostty-tab config:\n${loaded.warnings.join("\n")}`, "warning");
		}
	});

	pi.on("session_info_changed", async (event, ctx) => {
		sessionName = event.name;
		if (!isWorking) renderTitle(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		lastCtx = ctx;
		currentModel = event.model.id;
		if (!isWorking) renderTitle(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		lastCtx = ctx;
		if (!ctx.hasUI) return;
		// agent_start repeats within one run (retries, auto-compaction); only
		// the first one starts the clock.
		if (!runActive) {
			runActive = true;
			runStartedAt = Date.now();
			lastOutcome = "completed";
		}
		runSignal = ctx.signal;
		// A new run makes old ✓/✗ marks stale; a still-open prompt keeps ⏸.
		if (attention !== "waiting") attention = undefined;
		// An external editor or ctrl+z may have reset focus reporting.
		if (detachFocus) write(ENABLE_FOCUS_REPORTING);
		if (attention !== "waiting") setProgress(ProgressState.Indeterminate);
		startSpinner(ctx);
	});

	// The first user message is the earliest point where the task text exists.
	// agent_start is *too early*: pi emits extension events before it appends the
	// prompt entry, so at agent_start the session has no user message yet and the
	// summary call used to bail out silently. The title then only appeared at
	// agent_end, i.e. once the first run was basically over. Hence: kick off here,
	// with the prompt text passed in explicitly, in parallel with the agent's work.
	pi.on("message_start", async (event, ctx) => {
		if (event.message.role !== "user") return;
		lastCtx = ctx;
		if (!ctx.hasUI) return;
		void generateSummary(ctx, userMessageText(event.message.content));
	});

	pi.on("agent_end", async (event, ctx) => {
		lastCtx = ctx;
		if (!ctx.hasUI) return;
		lastOutcome = runOutcome(event.messages, runSignal?.aborted === true);
		stopSpinner(ctx);
		// Fallback: retry here if the message_start attempt failed or the run
		// started without a visible user message.
		void generateSummary(ctx);
	});

	// Fired once no retry, compaction or queued message will continue the
	// run — the only point where "done" is actually done.
	pi.on("agent_settled", async (_event, ctx) => {
		lastCtx = ctx;
		if (!ctx.hasUI || !runActive) return;
		runActive = false;
		onRunSettled(ctx);
	});

	// Any blocking extension prompt (permission asks, selects, inputs). pi
	// emits these for the outermost prompt only.
	pi.on("ui_prompt_start", async (event, ctx) => {
		lastCtx = ctx;
		if (!ctx.hasUI) return;
		attention = "waiting";
		promptTitle = event.title;
		if (runActive) setProgress(ProgressState.Paused);
		if (!focused) ring("waiting", { promptTitle });
		renderTitle(ctx);
	});

	pi.on("ui_prompt_end", async (_event, ctx) => {
		lastCtx = ctx;
		if (!ctx.hasUI || attention !== "waiting") return;
		attention = undefined;
		promptTitle = undefined;
		if (runActive) setProgress(ProgressState.Indeterminate);
		renderTitle(ctx);
	});

	pi.on("tool_execution_start", async (event, _ctx) => {
		currentTool = event.toolName;
	});

	pi.on("tool_execution_end", async (_event, _ctx) => {
		currentTool = undefined;
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		if (spinnerTimer) clearInterval(spinnerTimer);
		spinnerTimer = undefined;
		detachFocus?.();
		if (progressOn) setProgress(ProgressState.Clear);
		runActive = false;
		attention = undefined;
	});
}
