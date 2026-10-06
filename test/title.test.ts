import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeTitle, slotValue, type TitleState } from "../title.ts";

const FULL_STATE: TitleState = {
	spinnerFrame: "⠹",
	icon: "π",
	dir: "pi",
	session: "my-session",
	summary: "Agents.md documentation",
	model: "k3-256k",
	tool: "bash",
};

describe("slotValue", () => {
	it("maps every slot to its state field", () => {
		assert.equal(slotValue("spinner", FULL_STATE), "⠹");
		assert.equal(slotValue("icon", FULL_STATE), "π");
		assert.equal(slotValue("dir", FULL_STATE), "pi");
		assert.equal(slotValue("session", FULL_STATE), "my-session");
		assert.equal(slotValue("summary", FULL_STATE), "Agents.md documentation");
		assert.equal(slotValue("model", FULL_STATE), "k3-256k");
		assert.equal(slotValue("tool", FULL_STATE), "bash");
	});
});

describe("composeTitle", () => {
	it("joins slots in user-given order with the separator", () => {
		const title = composeTitle(["dir", "model"], " · ", { dir: "pi", model: "k3-256k" });
		assert.equal(title, "pi · k3-256k");
	});

	it("skips empty slots without leaving dangling separators", () => {
		const title = composeTitle(["icon", "summary", "dir"], " · ", { icon: "π", dir: "pi" });
		assert.equal(title, "π · pi");
	});

	it("renders 'spinner · summary' while working", () => {
		const title = composeTitle(["spinner", "summary"], " · ", {
			spinnerFrame: "⠹",
			summary: "MWAC 房间数据布局",
		});
		assert.equal(title, "⠹ · MWAC 房间数据布局");
	});

	it("drops the spinner slot entirely when idle", () => {
		const title = composeTitle(["spinner", "summary"], " · ", { summary: "MWAC 房间数据布局" });
		assert.equal(title, "MWAC 房间数据布局");
	});

	it("shows the tool only while a tool is set", () => {
		const state: TitleState = { icon: "π", dir: "pi", tool: "bash" };
		assert.equal(composeTitle(["icon", "dir", "tool", "model"], " · ", state), "π · pi · bash");
		state.tool = undefined;
		state.model = "k3-256k";
		assert.equal(composeTitle(["icon", "dir", "tool", "model"], " · ", state), "π · pi · k3-256k");
	});

	it("returns an empty string when every slot is empty", () => {
		assert.equal(composeTitle(["spinner", "summary"], " · ", {}), "");
	});

	it("trims whitespace-only values", () => {
		assert.equal(composeTitle(["icon", "summary"], " · ", { icon: "π", summary: "   " }), "π");
	});

	it("honours a custom separator", () => {
		assert.equal(composeTitle(["dir", "model"], " | ", { dir: "pi", model: "k3" }), "pi | k3");
	});
});
