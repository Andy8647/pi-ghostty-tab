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
import { loadConfig, progressEnabled, type LoadedConfig } from "./config.ts";
import { createTtyWriter, ProgressState, progressSequence, type WriteFn } from "./progress.ts";
import { assistantText, buildSummaryUserPrompt, sanitizeSummary, SUMMARY_SYSTEM_PROMPT } from "./summary.ts";
import { composeTitle, type TitleState } from "./title.ts";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
const COMPLETION_FLASH_MS = 800;
const SUMMARY_ENTRY_TYPE = "pi-ghostty-tab:summary";
/** How many opening user messages (and how much of each) feed the summary call. */
const SUMMARY_MAX_MESSAGES = 5;
const SUMMARY_CHARS_PER_MESSAGE = 800;
const SUMMARY_MAX_ATTEMPTS = 3;

export default function (pi: ExtensionAPI, write: WriteFn = createTtyWriter()) {
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

	// ---- title rendering ------------------------------------------------

	function titleState(): TitleState {
		return {
			spinnerFrame: isWorking ? BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length] : undefined,
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
		ctx.ui.setTitle(currentTitle());
	}

	// ---- spinner + progress ----------------------------------------------

	function startSpinner(ctx: ExtensionContext): void {
		if (spinnerTimer) clearInterval(spinnerTimer);
		if (completionTimer) {
			clearTimeout(completionTimer);
			completionTimer = undefined;
		}
		isWorking = true;
		currentTool = undefined;
		frameIndex = 0;
		if (progressOn) write(progressSequence(ProgressState.Indeterminate));
		spinnerTimer = setInterval(() => {
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
		if (progressOn) {
			write(progressSequence(ProgressState.Set, 100));
			completionTimer = setTimeout(() => {
				write(progressSequence(ProgressState.Clear));
				completionTimer = undefined;
			}, COMPLETION_FLASH_MS);
		}
		renderTitle(ctx);
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

	function collectUserTexts(ctx: ExtensionContext): string[] {
		const texts: string[] = [];
		for (const entry of ctx.sessionManager.getEntries()) {
			if (texts.length >= SUMMARY_MAX_MESSAGES) break;
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role !== "user") continue;
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((block) => block.type === "text")
							.map((block) => (block as { text: string }).text)
							.join("\n");
			const trimmed = text.trim();
			if (trimmed) texts.push(trimmed.slice(0, SUMMARY_CHARS_PER_MESSAGE));
		}
		return texts;
	}

	/** Fire-and-forget nested model call; never throws, never blocks the agent. */
	async function generateSummary(ctx: ExtensionContext): Promise<void> {
		if (!config.autoSummary || summary !== undefined || summaryInFlight) return;
		if (summaryAttempts >= SUMMARY_MAX_ATTEMPTS) return;
		const model = ctx.model;
		if (!model) return;
		const userTexts = collectUserTexts(ctx);
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
		description: "Terminal tab title: /tab shows status, /tab set <text> sets the summary, /tab clear, /tab regen",
		getArgumentCompletions: (prefix) => {
			const args = [
				{ value: "set", label: "set <text>", description: "Set the tab summary manually" },
				{ value: "clear", label: "clear", description: "Remove the summary (slot falls back away)" },
				{ value: "regen", label: "regen", description: "Regenerate the summary with the current model" },
			];
			return args.filter((a) => a.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const input = args.trim();
			if (!input) {
				ctx.ui.notify(
					`title: "${currentTitle() || "(empty)"}"\nslots: ${config.slots.join(", ")}\nsummary: ${summary ?? "(none)"}\nprogress: ${config.progress}${config.progress === "auto" ? (progressOn ? " (auto: ours)" : " (auto: pi core)") : ""}`,
					"info",
				);
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
		restoreSummary(ctx);
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
		startSpinner(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		lastCtx = ctx;
		if (!ctx.hasUI) return;
		stopSpinner(ctx);
		void generateSummary(ctx);
	});

	pi.on("tool_execution_start", async (event, _ctx) => {
		currentTool = event.toolName;
	});

	pi.on("tool_execution_end", async (_event, _ctx) => {
		currentTool = undefined;
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		if (spinnerTimer) clearInterval(spinnerTimer);
		if (completionTimer) clearTimeout(completionTimer);
		spinnerTimer = undefined;
		completionTimer = undefined;
		if (progressOn) write(progressSequence(ProgressState.Clear));
	});
}
