import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	FOCUS_IN,
	FOCUS_OUT,
	formatDuration,
	lastFocusEvent,
	notificationBody,
	notifySequence,
	oscText,
	runOutcome,
	settleDecision,
	statusGlyph,
} from "../attention.ts";

describe("lastFocusEvent", () => {
	it("reads a lone focus event", () => {
		assert.equal(lastFocusEvent(FOCUS_IN), true);
		assert.equal(lastFocusEvent(FOCUS_OUT), false);
	});

	it("ignores chunks without focus events", () => {
		assert.equal(lastFocusEvent("hello"), undefined);
		assert.equal(lastFocusEvent("\x1b[<35;10;5M"), undefined);
		assert.equal(lastFocusEvent("\x1bOA"), undefined);
	});

	it("takes the last event when several arrive in one chunk", () => {
		assert.equal(lastFocusEvent(`${FOCUS_OUT}${FOCUS_IN}`), true);
		assert.equal(lastFocusEvent(`${FOCUS_IN}x${FOCUS_OUT}`), false);
	});
});

describe("runOutcome", () => {
	it("uses the last assistant message", () => {
		assert.equal(runOutcome([{ role: "user" }, { role: "assistant", stopReason: "stop" }]), "completed");
		assert.equal(runOutcome([{ role: "assistant", stopReason: "error" }, { role: "toolResult" }]), "error");
		assert.equal(
			runOutcome([{ role: "assistant", stopReason: "error" }, { role: "assistant", stopReason: "aborted" }]),
			"aborted",
		);
	});

	it("trusts the run's abort signal over an error stop reason", () => {
		const escMidTool = [
			{ role: "toolResult", isError: true },
			{ role: "assistant", stopReason: "error", errorMessage: "This operation was aborted" },
		];
		assert.equal(runOutcome(escMidTool), "error");
		assert.equal(runOutcome(escMidTool, true), "aborted");
	});

	it("defaults to completed", () => {
		assert.equal(runOutcome([]), "completed");
		assert.equal(runOutcome([{ role: "user" }]), "completed");
	});
});

describe("formatDuration", () => {
	it("picks the two largest units", () => {
		assert.equal(formatDuration(8_000), "8s");
		assert.equal(formatDuration(192_000), "3m 12s");
		assert.equal(formatDuration(3_900_000), "1h 5m");
		assert.equal(formatDuration(-5), "0s");
	});
});

describe("notifySequence", () => {
	it("emits OSC 777 notify with BEL terminator", () => {
		assert.equal(notifySequence("MWAC 数据", "Done in 3m 12s"), "\x1b]777;notify;MWAC 数据;Done in 3m 12s\x07");
	});

	it("neutralizes field separators and control characters", () => {
		assert.equal(oscText("a;b\x07c\x1b]0;x\nd"), "a,b c ]0,x d");
		const seq = notifySequence("t;i", "b\x07");
		assert.equal(seq, "\x1b]777;notify;t,i;b\x07");
		// exactly one BEL — the terminator
		assert.equal(seq.split("\x07").length, 2);
	});

	it("caps long text", () => {
		assert.equal(oscText("x".repeat(300)).length, 200);
	});
});

describe("settleDecision", () => {
	const T = 20_000;

	it("flags nothing while focused", () => {
		for (const outcome of ["completed", "error", "aborted"] as const) {
			assert.deepEqual(settleDecision(outcome, true, 999_999, T), { attention: undefined, signal: false });
		}
	});

	it("never flags an abort", () => {
		assert.deepEqual(settleDecision("aborted", false, 999_999, T), { attention: undefined, signal: false });
	});

	it("marks a finished run but rings only past the threshold", () => {
		assert.deepEqual(settleDecision("completed", false, 5_000, T), { attention: "done", signal: false });
		assert.deepEqual(settleDecision("completed", false, 20_000, T), { attention: "done", signal: true });
	});

	it("always rings on error", () => {
		assert.deepEqual(settleDecision("error", false, 1_000, T), { attention: "error", signal: true });
	});
});

describe("status glyphs and bodies", () => {
	it("maps attention to glyphs", () => {
		assert.equal(statusGlyph("waiting"), "⏸");
		assert.equal(statusGlyph("done"), "✓");
		assert.equal(statusGlyph("error"), "✗");
		assert.equal(statusGlyph(undefined), undefined);
	});

	it("words the notification body", () => {
		assert.equal(notificationBody("waiting", { promptTitle: "Auto mode permission ask" }), "Waiting for you: Auto mode permission ask");
		assert.equal(notificationBody("waiting", {}), "Waiting for you");
		assert.equal(notificationBody("done", { elapsedMs: 45_000 }), "Done in 45s");
		assert.equal(notificationBody("error", { elapsedMs: 2_000 }), "Failed after 2s");
	});
});
