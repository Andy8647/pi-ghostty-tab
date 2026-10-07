/**
 * Drives the extension through pi's lifecycle with a fake API and asserts on
 * the bytes it writes to the terminal and the titles it sets.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BEL, ENABLE_FOCUS_REPORTING, FOCUS_IN, FOCUS_OUT } from "../attention.ts";

type Handler = (event: any, ctx: any) => Promise<unknown> | unknown;

const PROGRESS_INDETERMINATE = "\x1b]9;4;3\x07";
const PROGRESS_PAUSED = "\x1b]9;4;4\x07";
const PROGRESS_ERROR = "\x1b]9;4;2;100\x07";
const PROGRESS_DONE = "\x1b]9;4;1;100\x07";
const PROGRESS_CLEAR = "\x1b]9;4;0\x07";

function useSettings(settings: unknown): void {
	const dir = mkdtempSync(join(tmpdir(), "pi-ghostty-tab-"));
	writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
	process.env.PI_CODING_AGENT_DIR = dir;
}

async function harness(settings: unknown = {}) {
	useSettings(settings);
	const { default: extension } = await import("../index.ts");
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const writes: string[] = [];
	const titles: string[] = [];
	const notices: string[] = [];
	const inputListeners: ((data: string) => unknown)[] = [];
	const stdin = Object.assign(new EventEmitter(), { isTTY: true });

	const pi = {
		on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
		registerTool: () => {},
		registerCommand: (name: string, def: any) => commands.set(name, def),
		appendEntry: () => {},
		getSessionName: () => undefined,
	};
	const ctx = {
		hasUI: true,
		cwd: "/work/proj",
		model: undefined,
		signal: undefined as AbortSignal | undefined,
		ui: {
			setTitle: (t: string) => titles.push(t),
			notify: (m: string) => notices.push(m),
			onTerminalInput: (l: (data: string) => unknown) => {
				inputListeners.push(l);
				return () => inputListeners.splice(inputListeners.indexOf(l), 1);
			},
		},
		sessionManager: { getEntries: () => [], getSessionFile: () => "/s.jsonl" },
	};

	extension(pi as any, (seq: string) => writes.push(seq), stdin as any);

	const emit = async (name: string, event: object = {}) => {
		for (const h of handlers.get(name) ?? []) await h({ type: name, ...event }, ctx);
	};
	const run = async (outcome: "stop" | "error" | "aborted" = "stop") => {
		await emit("agent_start");
		await emit("agent_end", { messages: [{ role: "assistant", stopReason: outcome }] });
		await emit("agent_settled");
	};
	const lastTitle = () => titles.at(-1);
	return { emit, run, writes, titles, lastTitle, stdin, inputListeners, commands, notices, ctx };
}

const BASE = { ghosttyTab: { slots: ["status", "spinner", "dir"], progress: "on", notifyAfterSeconds: 0 } };

describe("extension lifecycle", () => {
	let h: Awaited<ReturnType<typeof harness>>;
	beforeEach(async () => {
		h = await harness(BASE);
		await h.emit("session_start");
	});
	afterEach(async () => {
		await h.emit("session_shutdown");
	});

	it("enables focus reporting and swallows focus events before the editor", () => {
		assert.ok(h.writes.includes(ENABLE_FOCUS_REPORTING));
		assert.equal(h.inputListeners.length, 1);
		assert.deepEqual(h.inputListeners[0](FOCUS_IN), { consume: true });
		assert.equal(h.inputListeners[0]("a"), undefined);
	});

	it("does nothing attention-wise when a run finishes while focused", async () => {
		await h.run();
		assert.ok(!h.writes.includes(BEL));
		assert.ok(!h.writes.some((w) => w.includes("777;notify")));
		assert.ok(h.writes.includes(PROGRESS_DONE));
		assert.equal(h.lastTitle(), "proj");
	});

	it("rings, notifies and marks ✓ when a run finishes in the background, cleared on focus", async () => {
		await h.emit("agent_start");
		h.stdin.emit("data", FOCUS_OUT);
		await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
		await h.emit("agent_settled");
		assert.ok(h.writes.includes(BEL));
		assert.ok(h.writes.some((w) => w.startsWith("\x1b]777;notify;pi · proj;Done in")));
		assert.equal(h.lastTitle(), "✓ · proj");

		h.stdin.emit("data", FOCUS_IN);
		assert.equal(h.lastTitle(), "proj");
	});

	it("holds a red bar and ✗ until focus when a background run fails", async () => {
		h.stdin.emit("data", FOCUS_OUT);
		await h.run("error");
		assert.equal(h.writes.filter((w) => w === PROGRESS_ERROR).length, 1);
		assert.ok(h.writes.some((w) => w.includes("Failed after")));
		assert.equal(h.lastTitle(), "✗ · proj");

		h.stdin.emit("data", FOCUS_IN);
		assert.equal(h.writes.at(-1), PROGRESS_CLEAR);
		assert.equal(h.lastTitle(), "proj");
	});

	it("flags nothing for an abort", async () => {
		h.stdin.emit("data", FOCUS_OUT);
		await h.run("aborted");
		assert.ok(!h.writes.includes(BEL));
		assert.equal(h.writes.at(-1), PROGRESS_CLEAR);
		assert.equal(h.lastTitle(), "proj");
	});

	it("treats an Esc that surfaces as stopReason error as an abort", async () => {
		// Real 1.0.4 + kimi-coding trace: bash returns "Command aborted", then an
		// empty assistant message with stopReason "error" / "This operation was aborted".
		const controller = new AbortController();
		h.ctx.signal = controller.signal;
		h.stdin.emit("data", FOCUS_OUT);
		await h.emit("agent_start");
		controller.abort();
		await h.emit("agent_end", {
			messages: [{ role: "assistant", stopReason: "error", errorMessage: "This operation was aborted" }],
		});
		await h.emit("agent_settled");
		assert.ok(!h.writes.includes(BEL));
		assert.ok(!h.writes.some((w) => w.includes("777;notify")));
		assert.ok(!h.writes.includes(PROGRESS_ERROR));
		assert.equal(h.writes.at(-1), PROGRESS_CLEAR);
		assert.equal(h.lastTitle(), "proj");
	});

	it("still reports a real error when the run was not aborted", async () => {
		h.ctx.signal = new AbortController().signal;
		h.stdin.emit("data", FOCUS_OUT);
		await h.run("error");
		assert.ok(h.writes.includes(PROGRESS_ERROR));
		assert.equal(h.lastTitle(), "✗ · proj");
	});

	it("shows ⏸ and a paused bar while a prompt waits, ringing only when unfocused", async () => {
		await h.emit("agent_start");
		await h.emit("ui_prompt_start", { kind: "confirm", title: "Auto mode permission ask" });
		assert.equal(h.writes.at(-1), PROGRESS_PAUSED);
		assert.equal(h.lastTitle(), "⏸ · proj");
		assert.ok(!h.writes.includes(BEL), "focused: no bell");
		await h.emit("ui_prompt_end", { kind: "confirm" });
		assert.equal(h.writes.at(-1), PROGRESS_INDETERMINATE);

		h.stdin.emit("data", FOCUS_OUT);
		await h.emit("ui_prompt_start", { kind: "confirm", title: "Auto mode permission ask" });
		assert.ok(h.writes.includes(BEL));
		assert.ok(h.writes.some((w) => w.endsWith(";Waiting for you: Auto mode permission ask\x07")));
		await h.emit("ui_prompt_end", { kind: "confirm" });
		await h.emit("agent_end", { messages: [] });
		await h.emit("agent_settled");
	});

	it("does not touch the bar for prompts outside a run", async () => {
		const before = h.writes.length;
		await h.emit("ui_prompt_start", { kind: "select" });
		await h.emit("ui_prompt_end", { kind: "select" });
		assert.ok(h.writes.slice(before).every((w) => !w.startsWith("\x1b]9;4")));
	});

	it("times one run across retries", async () => {
		h.stdin.emit("data", FOCUS_OUT);
		await h.emit("agent_start");
		await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] });
		await h.emit("agent_start");
		await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
		await h.emit("agent_settled");
		assert.equal(h.lastTitle(), "✓ · proj", "the retry's success is the outcome");
		assert.equal(h.writes.filter((w) => w.includes("777;notify")).length, 1);
	});

	it("restores pi's default title when a status-only title clears", async () => {
		const g = await harness({ ghosttyTab: { slots: ["status", "summary"], progress: "off" } });
		await g.emit("session_start");
		assert.equal(g.titles.length, 0, "nothing to show yet: pi's title stays");
		g.stdin.emit("data", FOCUS_OUT);
		await g.run();
		assert.equal(g.lastTitle(), "✓");
		g.stdin.emit("data", FOCUS_IN);
		assert.equal(g.lastTitle(), "π - proj");
		await g.emit("session_shutdown");
	});

	it("reports attention state in /tab", async () => {
		await h.commands.get("tab")!.handler("", h.ctx);
		assert.match(h.notices.at(-1)!, /attention: \(none\) · focused: true · tracking: on/);
	});
});

describe("attention config", () => {
	it("respects notifyAfterSeconds for finished runs", async () => {
		const h = await harness({ ghosttyTab: { ...BASE.ghosttyTab, notifyAfterSeconds: 60 } });
		await h.emit("session_start");
		h.stdin.emit("data", FOCUS_OUT);
		await h.run();
		assert.ok(!h.writes.includes(BEL), "short run: no bell");
		assert.equal(h.lastTitle(), "✓ · proj", "but still marked");
		await h.emit("session_shutdown");
	});

	it("bell: false and notify: false silence the signals but keep the marks", async () => {
		const h = await harness({ ghosttyTab: { ...BASE.ghosttyTab, bell: false, notify: false } });
		await h.emit("session_start");
		h.stdin.emit("data", FOCUS_OUT);
		await h.run("error");
		assert.ok(!h.writes.includes(BEL));
		assert.ok(!h.writes.some((w) => w.includes("777;notify")));
		assert.equal(h.lastTitle(), "✗ · proj");
		await h.emit("session_shutdown");
	});

	it("leaves the bar alone when pi core owns it", async () => {
		const h = await harness({ terminal: { showTerminalProgress: true }, ghosttyTab: { slots: ["status", "dir"] } });
		await h.emit("session_start");
		h.stdin.emit("data", FOCUS_OUT);
		await h.run("error");
		assert.ok(!h.writes.some((w) => w.startsWith("\x1b]9;4")));
		assert.ok(h.writes.includes(BEL), "signals do not depend on the bar");
		await h.emit("session_shutdown");
	});

	it("detaches the stdin tap on shutdown", async () => {
		const h = await harness(BASE);
		await h.emit("session_start");
		assert.equal(h.stdin.listenerCount("data"), 1);
		await h.emit("session_shutdown");
		assert.equal(h.stdin.listenerCount("data"), 0);
		assert.equal(h.inputListeners.length, 0);
	});
});
