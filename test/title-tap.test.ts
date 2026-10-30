import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { announcedTitles, installTitleTap, restoreTitleAfter } from "../title-tap.ts";

const titled = (title: string) => `\x1b]0;${title}\x07`;

describe("announcedTitles", () => {
	it("finds every title in a chunk, in order", () => {
		assert.deepEqual(announcedTitles(`${titled("π - proj")}body${titled("mine")}`), ["π - proj", "mine"]);
	});

	it("returns nothing for chunks without a title", () => {
		assert.deepEqual(announcedTitles("\x1b]9;4;3\x07⠋ working"), []);
	});
});

describe("restoreTitleAfter", () => {
	it("takes the title back when core writes its own", () => {
		assert.equal(restoreTitleAfter(titled("π - proj"), "Resume probe"), titled("Resume probe"));
	});

	it("leaves our own write alone", () => {
		assert.equal(restoreTitleAfter(titled("Resume probe"), "Resume probe"), undefined);
	});

	it("does not defend a title we no longer own", () => {
		assert.equal(restoreTitleAfter(titled("π - proj"), undefined), undefined);
	});

	it("restores once per chunk even with several foreign titles", () => {
		assert.equal(restoreTitleAfter(`${titled("π - a")}${titled("π - b")}`, "mine"), titled("mine"));
	});

	it("restores once when a chunk mixes our title with a foreign one", () => {
		assert.equal(restoreTitleAfter(`${titled("mine")}${titled("π - a")}`, "mine"), titled("mine"));
	});

	it("ignores chunks whose escape prefix never completes", () => {
		assert.equal(restoreTitleAfter("\x1b]0;π - proj", "mine"), undefined);
	});

	it("reads Buffer writes too", () => {
		assert.equal(restoreTitleAfter(Buffer.from(titled("π - proj"), "utf8"), "mine"), titled("mine"));
	});

	it("ignores non-text writes", () => {
		assert.equal(restoreTitleAfter(42, "mine"), undefined);
	});

	it("ignores progress-bar sequences that share the OSC introducer", () => {
		assert.equal(restoreTitleAfter("\x1b]9;4;1;100\x07", "mine"), undefined);
	});
});

describe("installTitleTap", () => {
	it("forwards writes and re-asserts the owned title right after a foreign one", () => {
		const written: string[] = [];
		const stdout = { write: (chunk: unknown) => (written.push(String(chunk)), true) } as Pick<NodeJS.WriteStream, "write">;
		const state = installTitleTap(stdout);

		state.owned = "mine";
		stdout.write(titled("π - proj"));
		assert.deepEqual(written, [titled("π - proj"), titled("mine")]);

		written.length = 0;
		stdout.write(titled("mine"));
		assert.deepEqual(written, [titled("mine")], "our own write is not doubled");

		state.owned = undefined;
		written.length = 0;
		stdout.write(titled("π - proj"));
		assert.deepEqual(written, [titled("π - proj")], "hands off once we stopped owning the title");

		state.owned = "mine";
		const again = installTitleTap({ write: () => true } as Pick<NodeJS.WriteStream, "write">);
		assert.equal(again, state, "installed once per process, reloads reuse it");
	});
});
