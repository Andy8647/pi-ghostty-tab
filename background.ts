/**
 * Background work reported by other extensions on `pi.events`.
 *
 * pi core has no activity API yet, so a run that ends while a background job is
 * still alive reports "done" (upstream: earendil-works/pi#10451, #10664, #11702).
 * The tab can only be honest about that if someone tells it, and the producer we
 * know is `@aliou/pi-processes`: it broadcasts `processes:changed` after every
 * start, end and clear, and answers `processes:request:list` synchronously with
 * every process it knows about. Both channels are that extension's private
 * protocol; if it is not installed we simply never learn about background work,
 * which is the old behaviour.
 *
 * `changed` + `list` instead of the start/end deltas: the list is authoritative,
 * so a missed event can never leave a stale "still running" behind.
 */

export interface EventBusLike {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

/** `@aliou/pi-processes` channels (extensions/shared/protocol/channels.ts). */
export const PROCESS_CHANNELS = {
	changed: "processes:changed",
	requestList: "processes:request:list",
} as const;

/** The producer's live statuses; anything else means the process is gone. */
const LIVE_STATUSES = new Set(["running", "terminating", "terminate_timeout"]);

function idOf(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const id = (value as { id?: unknown }).id;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** Which background jobs are still alive, keyed by the producer's process id. */
export class BackgroundTasks {
	private readonly ids = new Set<string>();

	get count(): number {
		return this.ids.size;
	}

	/** Replace the set from the producer's own list. Returns true when the count changed. */
	reset(list: unknown): boolean {
		if (!Array.isArray(list)) return false;
		const next = new Set<string>();
		for (const entry of list) {
			const id = idOf(entry);
			const status = (entry as { status?: unknown } | null)?.status;
			// A list holds finished processes too; only live ones keep the tab spinning.
			if (id && typeof status === "string" && LIVE_STATUSES.has(status)) next.add(id);
		}
		if (next.size === this.ids.size && [...next].every((id) => this.ids.has(id))) return false;
		this.ids.clear();
		for (const id of next) this.ids.add(id);
		return true;
	}
}

export interface BackgroundTracker {
	readonly tasks: BackgroundTasks;
	/** Ask the producer for the authoritative live list. Silent when nothing answers. */
	refresh(): void;
	dispose(): void;
}

/**
 * Follow the producer's list. `onChange` fires only when the live count changed,
 * so the caller can re-render; a producer that is not installed produces nothing.
 */
export function trackBackgroundWork(bus: EventBusLike, onChange: () => void): BackgroundTracker {
	const tasks = new BackgroundTasks();
	let disposed = false;

	function notify(): void {
		if (!disposed) onChange();
	}

	function refresh(): void {
		if (disposed) return;
		bus.emit(PROCESS_CHANNELS.requestList, {
			reply: (list: unknown) => {
				if (tasks.reset(list)) notify();
			},
		});
	}

	const off = bus.on(PROCESS_CHANNELS.changed, () => refresh());
	refresh();

	return {
		tasks,
		refresh,
		dispose() {
			disposed = true;
			off();
		},
	};
}
