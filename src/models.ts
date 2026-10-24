import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Every thinking level Pi knows, lowest first (docs/protocol.md, Model). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** One of [THINKING_LEVELS]; the same values as Pi's own `ThinkingLevel`. */
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** A model as clients see it: who serves it, what to call it, and which thinking levels it takes. */
export interface ModelInfo {
	provider: string;
	id: string;
	name: string;
	thinkingLevels: ThinkingLevel[];
}

/** The session's model and thinking level, as in the snapshot, the `model` event and the model endpoints. */
export interface ModelState {
	/** Missing when Pi has no model yet. */
	model?: ModelInfo;
	thinkingLevel: ThinkingLevel;
}

/** [model] as clients see it, with the thinking levels Pi lets it take. */
export function toModelInfo(model: Model<Api>): ModelInfo {
	return { provider: model.provider, id: model.id, name: model.name || model.id, thinkingLevels: getSupportedThinkingLevels(model) };
}

/** Whether a value from a client names one of the thinking levels. */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	// SAFETY: includes() only compares; a non-level value just returns false.
	return THINKING_LEVELS.includes(value as ThinkingLevel);
}

/**
 * The models a client may switch to: the session's scope (`enabledModels` or `--models`) when one is set, as the
 * terminal cycles through, otherwise every model with credentials.
 */
export function offeredModels(ctx: ExtensionContext): Model<Api>[] {
	return ctx.scopedModels.length > 0 ? ctx.scopedModels.map((scoped) => scoped.model) : ctx.modelRegistry.getAvailable();
}
