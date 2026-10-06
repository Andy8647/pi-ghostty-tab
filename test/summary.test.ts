import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assistantText, buildSummaryUserPrompt, sanitizeSummary, SUMMARY_SYSTEM_PROMPT } from "../summary.ts";

describe("sanitizeSummary", () => {
	it("passes a clean short title through", () => {
		assert.equal(sanitizeSummary("Agents.md documentation", 40), "Agents.md documentation");
	});

	it("keeps CJK titles", () => {
		assert.equal(sanitizeSummary("MWAC 房间数据布局与导出", 40), "MWAC 房间数据布局与导出");
	});

	it("takes only the first line of a chatty answer", () => {
		assert.equal(sanitizeSummary("Fix login bug\nHere is why this title works...", 40), "Fix login bug");
	});

	it("strips surrounding quotes, backticks and bullets", () => {
		assert.equal(sanitizeSummary('"Fix login bug"', 40), "Fix login bug");
		assert.equal(sanitizeSummary("`Fix login bug`", 40), "Fix login bug");
		assert.equal(sanitizeSummary("- Fix login bug", 40), "Fix login bug");
		assert.equal(sanitizeSummary("“修复登录问题”", 40), "修复登录问题");
		assert.equal(sanitizeSummary("Task: Fix login bug", 40), "Fix login bug");
	});

	it("collapses inner whitespace", () => {
		assert.equal(sanitizeSummary("Fix   login\t\tbug", 40), "Fix login bug");
	});

	it("truncates at a word boundary when over the limit", () => {
		const long = "Refactor the entire session manager and all of its tests";
		const result = sanitizeSummary(long, 30);
		assert.ok(result !== undefined && result.length <= 30, `got: ${result}`);
		assert.equal(result, "Refactor the entire session");
	});

	it("hard-truncates when no good word boundary exists (CJK)", () => {
		const long = "这是一个非常非常长的中文标题它没有任何空格所以必须硬截断才行啊";
		const result = sanitizeSummary(long, 20);
		assert.ok(result !== undefined && result.length <= 20, `got: ${result}`);
		assert.equal(result, "这是一个非常非常长的中文标题它没有任何空格".slice(0, 20));
	});

	it("returns undefined for empty or junk-only input", () => {
		assert.equal(sanitizeSummary("", 40), undefined);
		assert.equal(sanitizeSummary('  \n "``" ', 40), undefined);
	});
});

describe("assistantText", () => {
	it("joins text blocks and ignores other block types", () => {
		assert.equal(
			assistantText([
				{ type: "thinking", text: "hmm" },
				{ type: "text", text: "Fix login bug" },
			]),
			"Fix login bug",
		);
	});
});

describe("summary prompt", () => {
	it("enforces the hard length limit in the system prompt", () => {
		assert.ok(SUMMARY_SYSTEM_PROMPT.includes("40 characters"));
		assert.ok(SUMMARY_SYSTEM_PROMPT.includes("ONLY the title"));
	});

	it("embeds every user message", () => {
		const prompt = buildSummaryUserPrompt(["first question", "second question"]);
		assert.ok(prompt.includes("first question"));
		assert.ok(prompt.includes("second question"));
		assert.ok(prompt.includes("<user_message_1>"));
		assert.ok(prompt.includes("<user_message_2>"));
	});
});
