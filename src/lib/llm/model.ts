import { createGoogleGenerativeAI } from "@ai-sdk/google";

export type ChatLanguageModel = any;

let modelOverride: ChatLanguageModel | ChatLanguageModel[] | null = null;

/**
 * Overrides the active LLM model or list of models.
 * Used in tests to inject MockLanguageModel instances without calling real APIs.
 */
export function setModelOverride(
  model: ChatLanguageModel | ChatLanguageModel[] | null
): void {
  modelOverride = model;
}

/**
 * Resolves the ordered list of model IDs from environment variables:
 * LLM_MODEL (primary, required) and LLM_FALLBACK_MODELS (optional, comma-separated).
 * Throws a clear error if LLM_MODEL is not defined.
 */
export function getModelIds(): string[] {
  if (Array.isArray(modelOverride)) {
    return modelOverride.map((_, i) => `mock-model-${i}`);
  }
  if (modelOverride) {
    return ["mock-model-0"];
  }

  const primary = process.env.LLM_MODEL?.trim();
  if (!primary) {
    throw new Error("Missing required environment variable: LLM_MODEL");
  }

  const fallbacksRaw = process.env.LLM_FALLBACK_MODELS?.trim();
  const fallbacks = fallbacksRaw
    ? fallbacksRaw
        .split(",")
        .map((m) => m.trim())
        .filter((m) => m.length > 0 && m !== primary)
    : [];

  return [primary, ...fallbacks];
}

/**
 * Returns the configured LLM model provider instance for a model ID or attempt index.
 * Provider selection is kept in this single file.
 */
export function getChatModel(modelId?: string, attemptIndex: number = 0): ChatLanguageModel {
  if (modelOverride) {
    if (Array.isArray(modelOverride)) {
      return modelOverride[attemptIndex] ?? modelOverride[modelOverride.length - 1];
    }
    return modelOverride;
  }

  const resolvedModelId = modelId ?? getModelIds()[attemptIndex] ?? getModelIds()[0];
  const apiKey = process.env.LLM_API_KEY?.trim() || "";

  const google = createGoogleGenerativeAI({
    apiKey,
  });

  return google(resolvedModelId);
}
