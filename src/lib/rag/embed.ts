/**
 * src/lib/rag/embed.ts
 *
 * Embeds text strings into 1536-dimensional vectors using Google Generative AI embeddings.
 * Features:
 * - Batches texts (default BATCH_SIZE = 16), concurrency 1 (sequential).
 * - Configurable delay between batches (default 250ms).
 * - Retry with exponential backoff on 429/503 (max 3 attempts).
 * - 30-second per-call abort timeout.
 * - Enforces dimension === 1536 (fails fast on mismatch).
 * - Dimension passed in one place only (via providerOptions.google.outputDimensionality).
 * - Normalizes only when vector L2 norm differs from 1.0 by more than EPSILON (1e-4).
 * - Never logs text content, API keys, or raw vector arrays.
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { embedMany } from "ai";

export type EmbeddingKind = "document" | "query";

export const EXPECTED_EMBEDDING_DIMENSIONS = 1536;
export const EMBEDDING_BATCH_SIZE = 16;
export const EMBEDDING_MAX_ATTEMPTS = 3;
export const EMBEDDING_CALL_TIMEOUT_MS = 30_000;
const NORM_TOLERANCE = 1e-4;

/**
 * Computes Euclidean norm (L2) of a number array.
 */
export function vectorNorm(v: number[]): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i] * v[i];
  }
  return Math.sqrt(sum);
}

/**
 * L2-normalizes vector if its norm differs from 1.0 by more than tolerance.
 */
export function maybeNormalize(v: number[], tolerance = NORM_TOLERANCE): number[] {
  const norm = vectorNorm(v);
  if (Math.abs(norm - 1.0) <= tolerance || norm === 0) {
    return v;
  }
  const normalized = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) {
    normalized[i] = v[i] / norm;
  }
  return normalized;
}

/**
 * Checks if an error is considered retryable (429 or 503).
 */
export function isRetryableEmbeddingError(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as any;
  const status = anyErr.statusCode ?? anyErr.status;
  if (status === 429 || status === 503) return true;

  const msg = String(anyErr.message || "").toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("503") ||
    msg.includes("resource_exhausted") ||
    msg.includes("unavailable") ||
    msg.includes("rate limit") ||
    msg.includes("quota")
  );
}

export interface EmbedTextsOptions {
  batchSize?: number;
  batchDelayMs?: number;
  maxAttempts?: number;
  customEmbedder?: (batch: string[], kind: EmbeddingKind) => Promise<number[][]>;
}

/**
 * Embeds an array of texts with batching, concurrency 1, delay, and backoff.
 */
export async function embedTexts(
  texts: string[],
  kind: EmbeddingKind,
  options: EmbedTextsOptions = {}
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const batchSize = options.batchSize ?? EMBEDDING_BATCH_SIZE;
  const batchDelayMs = options.batchDelayMs ?? 250;
  const maxAttempts = options.maxAttempts ?? EMBEDDING_MAX_ATTEMPTS;

  // Split texts into batches
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    batches.push(texts.slice(i, i + batchSize));
  }

  const allEmbeddings: number[][] = [];

  for (let b = 0; b < batches.length; b++) {
    if (b > 0 && batchDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
    }

    const currentBatch = batches[b];
    let batchVectors: number[][] | null = null;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (options.customEmbedder) {
          batchVectors = await options.customEmbedder(currentBatch, kind);
        } else {
          batchVectors = await callGoogleEmbedding(currentBatch, kind);
        }
        break; // Batch succeeded
      } catch (err: unknown) {
        lastError = err;
        const retryable = isRetryableEmbeddingError(err);
        if (retryable && attempt < maxAttempts) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 8000) + Math.random() * 200;
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }
        break;
      }
    }

    if (!batchVectors) {
      const sanitizedMsg =
        lastError instanceof Error ? lastError.message : "Unknown embedding error";
      throw new Error(
        `Failed to embed batch ${b + 1}/${batches.length} after attempts: ${sanitizedMsg}`
      );
    }

    // Validate dimensions and normalize
    for (let i = 0; i < batchVectors.length; i++) {
      const v = batchVectors[i];
      if (!Array.isArray(v) || v.length !== EXPECTED_EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Invalid embedding dimension: expected ${EXPECTED_EMBEDDING_DIMENSIONS}, got ${v?.length ?? 0}`
        );
      }
      allEmbeddings.push(maybeNormalize(v));
    }
  }

  return allEmbeddings;
}

/**
 * Calls Google embedding model using AI SDK `embedMany`.
 * Dimension is configured in one place only: providerOptions.google.outputDimensionality.
 */
async function callGoogleEmbedding(values: string[], kind: EmbeddingKind): Promise<number[][]> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error("Missing LLM_API_KEY environment variable for embeddings.");
  }
  const modelId = process.env.EMBEDDING_MODEL || "gemini-embedding-2";

  const google = createGoogleGenerativeAI({ apiKey });
  const model = google.textEmbeddingModel(modelId);

  const taskType = kind === "document" ? "RETRIEVAL_DOCUMENT" : "RETRIEVAL_QUERY";

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort(new Error(`Embedding call timed out after ${EMBEDDING_CALL_TIMEOUT_MS}ms`));
  }, EMBEDDING_CALL_TIMEOUT_MS);

  try {
    const result = await embedMany({
      model,
      values,
      maxRetries: 0,
      abortSignal: abortController.signal,
      providerOptions: {
        google: {
          outputDimensionality: EXPECTED_EMBEDDING_DIMENSIONS,
          taskType,
        },
      },
    });

    return result.embeddings;
  } finally {
    clearTimeout(timeoutId);
  }
}

