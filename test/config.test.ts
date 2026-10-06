import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SLOTS, parseConfig, progressEnabled } from "../config.ts";

describe("parseConfig", () => {
	it("returns defaults when settings are missing or unreadable", () => {
		for (const raw of [undefined, null, 42, "nope", []]) {
			const { config } = parseConfig(raw);
			assert.deepEqual(config.slots, DEFAULT_SLOTS);
			assert.equal(config.separator, " · ");
			assert.equal(config.progress, "auto");
			assert.equal(config.autoSummary, true);
			assert.equal(config.summaryMaxLength, 40);
			assert.equal(config.enabled, true);
		}
	});

	it("returns defaults when ghosttyTab key is absent", () => {
		const { config, warnings } = parseConfig({ theme: "catppuccin-mocha" });
		assert.deepEqual(config.slots, DEFAULT_SLOTS);
		assert.equal(warnings.length, 0);
	});

	it("warns and defaults when ghosttyTab is not an object", () => {
		const { config, warnings } = parseConfig({ ghosttyTab: "yes" });
		assert.deepEqual(config.slots, DEFAULT_SLOTS);
		assert.equal(warnings.length, 1);
	});

	it("accepts a minimal slots-only config", () => {
		const { config, warnings } = parseConfig({ ghosttyTab: { slots: ["spinner", "summary"] } });
		assert.deepEqual(config.slots, ["spinner", "summary"]);
		assert.equal(warnings.length, 0);
	});

	it("filters unknown slots with a warning per entry", () => {
		const { config, warnings } = parseConfig({ ghosttyTab: { slots: ["spinner", "cwd", "summary", 42] } });
		assert.deepEqual(config.slots, ["spinner", "summary"]);
		assert.equal(warnings.length, 2);
	});

	it("falls back to default slots when none are valid", () => {
		const { config, warnings } = parseConfig({ ghosttyTab: { slots: ["bogus"] } });
		assert.deepEqual(config.slots, DEFAULT_SLOTS);
		assert.ok(warnings.some((w) => w.includes("no valid slots")));
	});

	it("accepts an empty separator and rejects non-strings", () => {
		assert.equal(parseConfig({ ghosttyTab: { separator: "" } }).config.separator, "");
		const { config, warnings } = parseConfig({ ghosttyTab: { separator: 7 } });
		assert.equal(config.separator, " · ");
		assert.equal(warnings.length, 1);
	});

	it("validates progress mode", () => {
		assert.equal(parseConfig({ ghosttyTab: { progress: "on" } }).config.progress, "on");
		assert.equal(parseConfig({ ghosttyTab: { progress: "off" } }).config.progress, "off");
		const { config, warnings } = parseConfig({ ghosttyTab: { progress: true } });
		assert.equal(config.progress, "auto");
		assert.equal(warnings.length, 1);
	});

	it("clamps summaryMaxLength to 10..120", () => {
		assert.equal(parseConfig({ ghosttyTab: { summaryMaxLength: 20 } }).config.summaryMaxLength, 20);
		assert.equal(parseConfig({ ghosttyTab: { summaryMaxLength: 5 } }).config.summaryMaxLength, 40);
		assert.equal(parseConfig({ ghosttyTab: { summaryMaxLength: 500 } }).config.summaryMaxLength, 40);
		assert.equal(parseConfig({ ghosttyTab: { summaryMaxLength: Number.NaN } }).config.summaryMaxLength, 40);
	});

	it("reads pi core's terminal.showTerminalProgress", () => {
		assert.equal(parseConfig({ terminal: { showTerminalProgress: true } }).coreShowTerminalProgress, true);
		assert.equal(parseConfig({ terminal: { showTerminalProgress: false } }).coreShowTerminalProgress, false);
		assert.equal(parseConfig({}).coreShowTerminalProgress, false);
	});
});

describe("progressEnabled", () => {
	it("on always wins, off always loses", () => {
		assert.equal(progressEnabled(parseConfig({ ghosttyTab: { progress: "on" }, terminal: { showTerminalProgress: true } })), true);
		assert.equal(progressEnabled(parseConfig({ ghosttyTab: { progress: "off" } })), false);
	});

	it("auto yields to pi core's showTerminalProgress", () => {
		assert.equal(progressEnabled(parseConfig({ terminal: { showTerminalProgress: true } })), false);
		assert.equal(progressEnabled(parseConfig({ terminal: { showTerminalProgress: false } })), true);
		assert.equal(progressEnabled(parseConfig({})), true);
	});
});
