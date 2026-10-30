/**
 * Keep our title on the terminal when something else overwrites it.
 *
 * pi core writes its own title (`π - <dir>`) right after it finishes binding
 * extensions — a few milliseconds *after* our session_start handler restored
 * the summary — and again on every rename. Nothing in core lets an extension
 * claim the title, so the only way to keep a restored summary visible is to
 * watch stdout and take the title back.
 */

const TITLE_PREFIX = "\x1b]0;";
const TITLE_TERMINATOR = "\x07";
const TITLE_PATTERN = /\x1b\]0;([\s\S]*?)\x07/g;
const TITLE_PREFIX_BYTES = Buffer.from(TITLE_PREFIX, "utf8");

/** Process-wide guard: the stdout hook must be installed once even across /reload. */
const TITLE_TAP_KEY = Symbol.for("pi-ghostty-tab:title-tap");

export interface TitleTapState {
	/** The title we want on screen; undefined means the tab title is not ours to defend. */
	owned: string | undefined;
}

/** Titles announced by this chunk, in order. */
export function announcedTitles(text: string): string[] {
	const titles: string[] = [];
	for (const match of text.matchAll(TITLE_PATTERN)) titles.push(match[1] ?? "");
	return titles;
}

function mayAnnounceTitle(chunk: unknown): boolean {
	if (typeof chunk === "string") return chunk.includes(TITLE_PREFIX);
	if (chunk instanceof Uint8Array) {
		// No copy: scan the view the writer handed us.
		return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).indexOf(TITLE_PREFIX_BYTES) !== -1;
	}
	return false;
}

function chunkText(chunk: unknown): string {
	if (typeof chunk === "string") return chunk;
	if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("utf8");
	return "";
}

/**
 * The title sequence to re-emit after this chunk, or undefined when the chunk
 * either announces nothing or announces exactly the title we own.
 */
export function restoreTitleAfter(chunk: unknown, owned: string | undefined): string | undefined {
	if (!owned || !mayAnnounceTitle(chunk)) return undefined;
	const overwritten = announcedTitles(chunkText(chunk)).some((title) => title !== owned);
	return overwritten ? `${TITLE_PREFIX}${owned}${TITLE_TERMINATOR}` : undefined;
}

/**
 * Watch stdout and immediately take the title back whenever another writer
 * announces a different one. Installed at most once per process: a reload
 * reuses the same hook and only swaps the object it reads `owned` from.
 */
export function installTitleTap(stdout: Pick<NodeJS.WriteStream, "write"> = process.stdout): TitleTapState {
	const globals = globalThis as Record<symbol, unknown>;
	const existing = globals[TITLE_TAP_KEY] as TitleTapState | undefined;
	if (existing) return existing;

	const state: TitleTapState = { owned: undefined };
	const write = stdout.write.bind(stdout) as (chunk: unknown, ...rest: unknown[]) => boolean;
	stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
		const result = write(chunk, ...rest);
		const restore = restoreTitleAfter(chunk, state.owned);
		// Straight to the unwrapped writer: the restore must not re-enter the hook.
		if (restore) write(restore);
		return result;
	}) as unknown as typeof stdout.write;

	globals[TITLE_TAP_KEY] = state;
	return state;
}
