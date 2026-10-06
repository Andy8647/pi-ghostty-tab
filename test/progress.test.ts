import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProgressState, progressSequence } from "../progress.ts";

describe("progressSequence", () => {
	it("emits OSC 9;4 with BEL terminator", () => {
		assert.equal(progressSequence(ProgressState.Indeterminate), "\x1b]9;4;3\x07");
		assert.equal(progressSequence(ProgressState.Set, 100), "\x1b]9;4;1;100\x07");
		assert.equal(progressSequence(ProgressState.Clear), "\x1b]9;4;0\x07");
	});
});
