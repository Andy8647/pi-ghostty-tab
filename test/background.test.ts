/**
 * The background-work tracker in isolation: it only knows the producer's list
 * and must never invent liveness when nobody answers.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { BackgroundTasks, PROCESS_CHANNELS, trackBackgroundWork, type EventBusLike } from "../background.ts";

const RUNNING = (id: string) => ({ id, status: "running", name: id });
const EXITED = (id: string) => ({ id, status: "exited", name: id });

function bus(): EventBusLike & { emitter: EventEmitter } {
	const emitter = new EventEmitter();
	return {
		emitter,
		emit: (channel, data) => void emitter.emit(channel, data),
		on: (channel, handler) => {
			emitter.on(channel, handler);
			return () => emitter.off(channel, handler);
		},
	};
}

describe("BackgroundTasks", () => {
	it("counts only the live entries of the producer's list", () => {
		const tasks = new BackgroundTasks();
		assert.equal(tasks.reset([RUNNING("a"), EXITED("b"), { id: "c" }]), true);
		assert.equal(tasks.count, 1, "exited and status-less entries do not keep the tab busy");
	});

	it("reports no change when the live set is identical", () => {
		const tasks = new BackgroundTasks();
		tasks.reset([RUNNING("a"), EXITED("b")]);
		assert.equal(tasks.reset([RUNNING("a"), EXITED("c")]), false);
		assert.equal(tasks.count, 1);
	});

	it("ignores a payload that is not a list", () => {
		const tasks = new BackgroundTasks();
		assert.equal(tasks.reset(undefined), false);
		assert.equal(tasks.reset({ reply: () => {} }), false);
		assert.equal(tasks.count, 0);
	});
});

describe("trackBackgroundWork", () => {
	function producer(list: { id: string; status: string }[], events: EventBusLike): void {
		events.on(PROCESS_CHANNELS.requestList, (payload) => {
			(payload as { reply: (value: unknown) => void }).reply(list);
		});
	}

	it("reads the list once on creation", () => {
		const events = bus();
		producer([RUNNING("a")], events);
		let changes = 0;
		const tracker = trackBackgroundWork(events, () => {
			changes++;
		});
		assert.equal(tracker.tasks.count, 1);
		assert.equal(changes, 1);
	});

	it("stays quiet when no producer is installed", () => {
		const tracker = trackBackgroundWork(bus(), () => {
			throw new Error("must not fire without a producer");
		});
		assert.equal(tracker.tasks.count, 0);
	});

	it("re-reads the list when the producer reports a change", () => {
		const events = bus();
		const list = [RUNNING("a")];
		producer(list, events);
		let changes = 0;
		const tracker = trackBackgroundWork(events, () => {
			changes++;
		});
		list.push(RUNNING("b"));
		events.emit(PROCESS_CHANNELS.changed, { reason: "started" });
		assert.equal(tracker.tasks.count, 2);
		assert.equal(changes, 2);

		list.pop();
		events.emit(PROCESS_CHANNELS.changed, { reason: "ended" });
		assert.equal(tracker.tasks.count, 1);
		assert.equal(changes, 3);
	});

	it("keeps a live job when the producer only clears finished entries", () => {
		const events = bus();
		const list = [RUNNING("a"), EXITED("b")];
		producer(list, events);
		const tracker = trackBackgroundWork(events, () => {});
		list.splice(1, 1);
		events.emit(PROCESS_CHANNELS.changed, { reason: "cleared" });
		assert.equal(tracker.tasks.count, 1);
	});

	it("stops following the producer once disposed", () => {
		const events = bus();
		const list = [RUNNING("a")];
		producer(list, events);
		const tracker = trackBackgroundWork(events, () => {});
		tracker.dispose();
		list.push(RUNNING("b"));
		events.emit(PROCESS_CHANNELS.changed, { reason: "started" });
		assert.equal(tracker.tasks.count, 1);
		assert.equal(events.emitter.listenerCount(PROCESS_CHANNELS.changed), 0);
	});
});
