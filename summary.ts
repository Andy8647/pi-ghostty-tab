/**
 * Session-summary generation: prompt construction and output sanitizing.
 * Pure module (no pi imports) so it is fully unit-testable.
 */

/**
 * System prompt for the nested summary call. The length constraint is the
 * whole point — a tab title must stay short, so the rules are deliberately
 * rigid and repeated in the tool description as well.
 */
export const SUMMARY_SYSTEM_PROMPT = `You write extremely short titles for terminal tabs, summarizing what the user is working on.

Hard rules:
- Output ONLY the title text. No explanation, no quotes, no trailing punctuation.
- 2 to 6 words, NEVER more than 40 characters.
- No emoji, no prefixes like "Task:" or "Session:".
- Use the same language as the user's messages (e.g. Chinese in, Chinese out).
- Name the user's actual task or topic, not the assistant and not generic words like "coding help".`;

export function buildSummaryUserPrompt(userTexts: readonly string[]): string {
	const parts = userTexts.map((text, i) => `<user_message_${i + 1}>\n${text}\n</user_message_${i + 1}>`);
	return `Here are the user's opening messages from this session. Write the tab title.\n\n${parts.join("\n\n")}`;
}

/** Characters stripped from both ends of a candidate summary. */
const EDGE_JUNK = /^[\s"'`“”‘’*_#~\-•·:：,，.。!！?？]+|[\s"'`“”‘’*_#~:：,，.。!！?？]+$/g;

/** Verbose prefixes models love to add despite the prompt ("Title: ..."). */
const PREFIX_LABEL = /^(title|task|session|tab|topic|标题|任务|会话|话题)\s*[:：]\s*/i;

/**
 * Normalize raw model output into a safe one-line tab title.
 * Returns undefined when nothing usable remains.
 */
export function sanitizeSummary(raw: string, maxLength: number): string | undefined {
	// First line only — models sometimes append an explanation.
	let s = (raw.split(/\r?\n/, 1)[0] ?? "").replace(EDGE_JUNK, "").replace(PREFIX_LABEL, "").replace(/\s+/g, " ").trim();
	if (!s) return undefined;

	if (s.length > maxLength) {
		s = s.slice(0, maxLength);
		// Prefer a word boundary, but only if it does not butcher the text.
		const lastSpace = s.lastIndexOf(" ");
		if (lastSpace >= maxLength / 2) s = s.slice(0, lastSpace);
		s = s.replace(EDGE_JUNK, "").trim();
	}
	return s || undefined;
}

/** Extract the text of an assistant message produced by the summary call. */
export function assistantText(content: readonly { type: string; text?: string }[]): string {
	return content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
}
