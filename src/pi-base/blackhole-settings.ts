/**
 * Blackhole settings modal — replaces the hand-rolled configure overlay
 * with pi-base's `openSettingsModal`.
 *
 * Keeps the existing config path, field set, validation, and save behavior.
 * The only change is the UI: scope-aware modal instead of inline overlay.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openSettingsModal, type Field } from "./settings/index.js";
import { getPiAgentDir } from "./paths.js";
import {
	DEFAULTS,
	loadUnifiedConfig,
	saveUnifiedConfigScoped,
} from "../core/unified-config.js";
import type { UnifiedConfig } from "../core/unified-config.js";

const CONFIG_FILENAME = "pi-blackhole-config.json";

function getGlobalConfigDir(): string {
	return join(getPiAgentDir(), "pi-blackhole");
}

function buildFields(config: UnifiedConfig): Field[] {
	return [
		// ── Compaction ──
		{
			key: "compaction",
			type: "enum",
			label: "Compaction mode",
			description: "auto=trigger on threshold, manual=only /blackhole, off=auto:Pi handles, /blackhole:blackhole pipeline",
			value: config.compaction,
			options: ["auto", "manual", "off"],
			optionLabels: {
				auto: "auto — trigger on threshold",
				manual: "manual — only /blackhole",
				off: "off — auto:Pi handles, /blackhole:blackhole pipeline",
			},
		},
		{
			key: "compactionEngine",
			type: "enum",
			label: "Compaction engine",
			description: "blackhole=structured summary+OM, pi-default=built-in Pi summarization",
			value: config.compactionEngine,
			options: ["blackhole", "pi-default"],
			optionLabels: {
				blackhole: "blackhole — structured summary + OM",
				"pi-default": "pi-default — built-in Pi summarization",
			},
		},
		{
			key: "tailBehavior",
			type: "enum",
			label: "Visible tail",
			description: "minimal=keep last user message only (default), pi-default=keep Pi's preserved visible context",
			value: config.tailBehavior,
			options: ["minimal", "pi-default"],
			optionLabels: {
				minimal: "minimal — keep last user message only (default)",
				"pi-default": "pi-default — keep Pi's preserved visible context",
			},
		},
		{
			key: "midRunCompaction",
			type: "enum",
			label: "Mid-run compaction",
			description: "resume=compact at threshold during tool loops and continue (default), pause=compact and stop, off=only check when run ends",
			value: config.midRunCompaction,
			options: ["resume", "pause", "off"],
			optionLabels: {
				resume: "resume — compact and continue (default)",
				pause: "pause — compact and stop",
				off: "off — only check when run ends",
			},
		},
		{
			key: "compactAfterTokens",
			type: "number",
			label: "Auto-compact threshold",
			description: "Token count that triggers auto-compaction when reached",
			value: config.compactAfterTokens,
			min: 1000,
			max: 500_000,
			step: 1000,
		},

		// ── Observational Memory ──
		{
			key: "memory",
			type: "boolean",
			label: "Observational memory",
			description: "Enable OM workers (observer, reflector, dropper) and content injection",
			value: config.memory,
			valueDescriptions: {
				on: "Active — OM workers + content injection enabled",
				off: "Suspended — OM disabled",
			},
		},
		{
			key: "sessionFallback",
			type: "boolean",
			label: "Session model fallback",
			description: "off=skip stage when all OM models fail, instead of falling back to the main coding model",
			value: config.sessionFallback ?? true,
		},
		{
			key: "observeAfterTokens",
			type: "number",
			label: "Observer threshold",
			description: "Tokens accumulated since last observer run before triggering next observe",
			value: config.observeAfterTokens,
			min: 1000,
			max: 200_000,
			step: 1000,
		},
		{
			key: "reflectAfterTokens",
			type: "number",
			label: "Reflect + dropper threshold",
			description: "Tokens accumulated since last reflect before triggering reflector and dropper",
			value: config.reflectAfterTokens,
			min: 1000,
			max: 200_000,
			step: 1000,
		},
		{
			key: "observationsPoolMaxTokens",
			type: "number",
			label: "Observation pool max",
			description: "Max tokens in observation pool before dropper prunes (fold pressure)",
			value: config.observationsPoolMaxTokens,
			min: 1000,
			max: 200_000,
			step: 1000,
		},
		{
			key: "observationsPoolTargetTokens",
			type: "number",
			label: "Observation pool target",
			description: "Target tokens after dropper prunes (defaults to half of pool max)",
			value: config.observationsPoolTargetTokens,
			min: 500,
			max: 200_000,
			step: 500,
		},
		{
			key: "reflectorInputMaxTokens",
			type: "number",
			label: "Reflector input max",
			description: "Max prompt tokens for reflector model input (rolling window cap)",
			value: config.reflectorInputMaxTokens,
			min: 1000,
			max: 500_000,
			step: 1000,
		},
		{
			key: "dropperInputMaxTokens",
			type: "number",
			label: "Dropper input max",
			description: "Max prompt tokens for dropper model input (rolling window cap)",
			value: config.dropperInputMaxTokens,
			min: 1000,
			max: 500_000,
			step: 1000,
		},
		{
			key: "observerChunkMaxTokens",
			type: "number",
			label: "Observer chunk max",
			description: "Max source entry tokens sent to observer per chunk",
			value: config.observerChunkMaxTokens,
			min: 1000,
			max: 200_000,
			step: 1000,
		},
		{
			key: "observerPreambleMaxTokens",
			type: "number",
			label: "Observer preamble max",
			description: "Preamble budget in manual compaction mode (0=auto-compute 30% of chunk)",
			value: config.observerPreambleMaxTokens,
			min: 0,
			max: 100_000,
			step: 500,
		},
		{
			key: "dropperPressureThreshold",
			type: "number",
			label: "Dropper pressure threshold",
			description: "Fraction of reflectorInputMaxTokens that triggers pressure-driven dropper (0-1, default 0.70)",
			value: config.dropperPressureThreshold,
			min: 0.01,
			max: 1,
			step: 0.01,
		},
		{
			key: "agentMaxTurns",
			type: "number",
			label: "Max turns per agent",
			description: "Shared turn cap for background memory agents",
			value: config.agentMaxTurns,
			min: 1,
			max: 100,
			step: 1,
		},
		{
			key: "fullFoldAlways",
			type: "boolean",
			label: "Preserve OM on first compaction",
			description: "When true, early reflections/drops survive the first compaction in a fresh session",
			value: config.fullFoldAlways,
		},

		// ── Debug ──
		{
			key: "debug",
			type: "boolean",
			label: "Debug snapshots",
			description: "Write detailed debug snapshots to /tmp/pi-blackhole-debug.json",
			value: config.debug,
		},
		{
			key: "debugLog",
			type: "boolean",
			label: "Debug JSONL logging",
			description: "Write structured JSONL debug logs to agent directory",
			value: config.debugLog,
		},
	];
}

export async function openBlackholeSettings(ctx: ExtensionContext): Promise<void> {
	const config = loadUnifiedConfig(ctx.cwd);
	const fields = buildFields(config);

	await openSettingsModal(ctx, {
		title: "pi-blackhole",
		configFilename: CONFIG_FILENAME,
		mode: "buffered",
		defaults: DEFAULTS as unknown as Record<string, unknown>,
		globalConfigDir: getGlobalConfigDir(),
		inferDefaultScope: () =>
			existsSync(join(ctx.cwd, ".pi", CONFIG_FILENAME)) ? "project" : "global",
		fields,
		onSave: async (values, scope) => {
			const updated = { ...config, ...values } as UnifiedConfig;
			const saved = saveUnifiedConfigScoped(updated, scope, ctx.cwd);
			if (!saved) {
				ctx.ui.notify("Failed to save config — the config file may be read-only (e.g., managed by Nix).", "warning");
			}
		},
	});
}
