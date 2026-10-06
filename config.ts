/**
 * Configuration for pi-ghostty-tab, read from the `ghosttyTab` key in
 * ~/.pi/agent/settings.json. Mirrors pi-toolbox's conventions: unknown keys
 * are ignored, invalid values fall back to defaults with a warning.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SLOT_NAMES = ["spinner", "icon", "dir", "session", "summary", "model", "tool"] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

export type ProgressMode = "auto" | "on" | "off";

export interface GhosttyTabConfig {
	enabled: boolean;
	/** Title slots in display order. Empty values are skipped, so no dangling separators. */
	slots: SlotName[];
	/** Join string between non-empty slots. */
	separator: string;
	/**
	 * OSC 9;4 progress bar. "auto" yields to pi core's terminal.showTerminalProgress
	 * when that is on (both write the same protocol and would fight).
	 */
	progress: ProgressMode;
	/** Generate a short session summary after the first agent turn. */
	autoSummary: boolean;
	/** Hard cap for generated/tool-set summaries. */
	summaryMaxLength: number;
}

export const DEFAULT_SLOTS: SlotName[] = ["spinner", "icon", "dir", "session", "summary", "tool", "model"];

const DEFAULTS: GhosttyTabConfig = {
	enabled: true,
	slots: DEFAULT_SLOTS,
	separator: " · ",
	progress: "auto",
	autoSummary: true,
	summaryMaxLength: 40,
};

const MIN_SUMMARY_LENGTH = 10;
const MAX_SUMMARY_LENGTH = 120;

export interface LoadedConfig {
	config: GhosttyTabConfig;
	warnings: string[];
	/** pi core's own terminal.showTerminalProgress setting (drives progress:"auto"). */
	coreShowTerminalProgress: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pure parser — takes the raw settings.json object (or undefined). */
export function parseConfig(settings: unknown): LoadedConfig {
	const warnings: string[] = [];
	const config: GhosttyTabConfig = { ...DEFAULTS, slots: [...DEFAULT_SLOTS] };

	const core = isRecord(settings) && isRecord(settings.terminal) ? settings.terminal : undefined;
	const coreShowTerminalProgress = core?.showTerminalProgress === true;

	if (!isRecord(settings)) return { config, warnings, coreShowTerminalProgress };
	const raw = settings.ghosttyTab;
	if (raw === undefined) return { config, warnings, coreShowTerminalProgress };
	if (!isRecord(raw)) {
		warnings.push(`ghosttyTab: expected an object, got ${Array.isArray(raw) ? "array" : typeof raw} — using defaults`);
		return { config, warnings, coreShowTerminalProgress };
	}

	if (raw.enabled !== undefined) {
		if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
		else warnings.push(`ghosttyTab.enabled: expected boolean, got ${typeof raw.enabled} — using ${DEFAULTS.enabled}`);
	}

	if (raw.slots !== undefined) {
		if (Array.isArray(raw.slots)) {
			const known: SlotName[] = [];
			for (const entry of raw.slots) {
				if (typeof entry === "string" && (SLOT_NAMES as readonly string[]).includes(entry)) {
					known.push(entry as SlotName);
				} else {
					warnings.push(
						`ghosttyTab.slots: unknown slot ${JSON.stringify(entry)} — expected one of ${SLOT_NAMES.join(", ")}`,
					);
				}
			}
			if (known.length > 0) {
				config.slots = known;
			} else {
				warnings.push("ghosttyTab.slots: no valid slots — using defaults");
			}
		} else {
			warnings.push(`ghosttyTab.slots: expected array, got ${typeof raw.slots} — using defaults`);
		}
	}

	if (raw.separator !== undefined) {
		if (typeof raw.separator === "string") config.separator = raw.separator;
		else warnings.push(`ghosttyTab.separator: expected string, got ${typeof raw.separator} — using default`);
	}

	if (raw.progress !== undefined) {
		if (raw.progress === "auto" || raw.progress === "on" || raw.progress === "off") {
			config.progress = raw.progress;
		} else {
			warnings.push(`ghosttyTab.progress: expected "auto" | "on" | "off", got ${JSON.stringify(raw.progress)} — using "auto"`);
		}
	}

	if (raw.autoSummary !== undefined) {
		if (typeof raw.autoSummary === "boolean") config.autoSummary = raw.autoSummary;
		else warnings.push(`ghosttyTab.autoSummary: expected boolean, got ${typeof raw.autoSummary} — using ${DEFAULTS.autoSummary}`);
	}

	if (raw.summaryMaxLength !== undefined) {
		if (typeof raw.summaryMaxLength === "number" && Number.isFinite(raw.summaryMaxLength)) {
			const clamped = Math.round(raw.summaryMaxLength);
			if (clamped >= MIN_SUMMARY_LENGTH && clamped <= MAX_SUMMARY_LENGTH) {
				config.summaryMaxLength = clamped;
			} else {
				warnings.push(
					`ghosttyTab.summaryMaxLength: ${clamped} out of range ${MIN_SUMMARY_LENGTH}..${MAX_SUMMARY_LENGTH} — using ${DEFAULTS.summaryMaxLength}`,
				);
			}
		} else {
			warnings.push(`ghosttyTab.summaryMaxLength: expected number, got ${typeof raw.summaryMaxLength} — using ${DEFAULTS.summaryMaxLength}`);
		}
	}

	return { config, warnings, coreShowTerminalProgress };
}

/** Read settings.json and parse. Never throws — unreadable settings mean defaults. */
export function loadConfig(): LoadedConfig {
	const agentDir = process.env.PI_CODING_AGENT_DIR || `${process.env.HOME || "/tmp"}/.pi/agent`;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
	} catch {
		raw = undefined;
	}
	return parseConfig(raw);
}

/** Whether this extension should drive the OSC 9;4 progress bar. */
export function progressEnabled(loaded: LoadedConfig): boolean {
	if (loaded.config.progress === "on") return true;
	if (loaded.config.progress === "off") return false;
	return !loaded.coreShowTerminalProgress;
}
