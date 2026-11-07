/**
 * src/lib/chat-client.ts
 *
 * Core fetch, streaming, and error mapping logic for POST /api/chat.
 * Pure TypeScript, zero React dependencies so it can be tested in Vitest without jsdom.
 */

export interface SendMessageOptions {
  message: string;
  conversationId?: string | null;
  signal?: AbortSignal;
  onConversationId?: (id: string) => void;
  onChunk?: (textDelta: string) => void;
}

export type SendMessageResult =
  | {
      ok: true;
      fullText: string;
      conversationId?: string;
    }
  | {
      ok: false;
      errorKind: "expired_conversation" | "rate_limited" | "busy" | "mid_stream_cutoff" | "generic";
      errorMessage: string;
      partialText?: string;
      canRetry?: boolean;
    };

export const MID_STREAM_CUTOFF_MESSAGE =
  "The reply was cut off. If you were booking or cancelling, ask me to check my appointments before trying again.";

export const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

export const EXPIRED_CONVERSATION_MESSAGE = "This chat expired, starting a new one.";

/**
 * Extracts friendly error text from response body only if Content-Type is text/plain.
 * Caps at 300 characters. If HTML or non-text/plain, returns defaultMessage.
 */
async function extractErrorText(res: Response, defaultMessage: string): Promise<string> {
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("text/plain")) {
    return defaultMessage;
  }
  try {
    const rawText = await res.text();
    const trimmed = rawText.trim();
    if (!trimmed) return defaultMessage;
    // Cap at 300 characters
    return trimmed.length > 300 ? trimmed.slice(0, 300) : trimmed;
  } catch {
    return defaultMessage;
  }
}

/**
 * Sends a chat message to /api/chat and streams the plain-text response.
 * Uses TextDecoder with { stream: true } and flushes at the end to ensure
 * multi-byte UTF-8 sequences (e.g. Hindi Devanagari) split across chunk boundaries
 * are decoded seamlessly.
 */
export async function sendMessageStream(
  options: SendMessageOptions,
  customFetch: typeof fetch = fetch
): Promise<SendMessageResult> {
  const trimmed = options.message.trim();
  if (!trimmed) {
    return {
      ok: false,
      errorKind: "generic",
      errorMessage: "Message must not be empty.",
    };
  }

  // Request payload: message and optional conversation_id ONLY.
  // Never sends clinic_id.
  const payload: { message: string; conversation_id?: string } = {
    message: trimmed,
  };
  if (options.conversationId) {
    payload.conversation_id = options.conversationId;
  }

  let response: Response;
  try {
    response = await customFetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify(payload),
      signal: options.signal,
    });
  } catch (err: unknown) {
    // If explicitly aborted, rethrow so callers know it was cancelled
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    return {
      ok: false,
      errorKind: "generic",
      errorMessage: GENERIC_ERROR_MESSAGE,
    };
  }

  // Read X-Conversation-Id header if returned
  const returnedConvId = response.headers.get("x-conversation-id") || undefined;
  if (returnedConvId && options.onConversationId) {
    options.onConversationId(returnedConvId);
  }

  // Status mapping
  if (response.status === 404) {
    return {
      ok: false,
      errorKind: "expired_conversation",
      errorMessage: EXPIRED_CONVERSATION_MESSAGE,
    };
  }

  if (response.status === 429) {
    const errorText = await extractErrorText(
      response,
      "You have sent too many messages. Please wait a moment before trying again. If this is an emergency, call 112 immediately."
    );
    return {
      ok: false,
      errorKind: "rate_limited",
      errorMessage: errorText,
    };
  }

  if (response.status === 503) {
    const errorText = await extractErrorText(
      response,
      "We're very busy, please try again in a minute"
    );
    return {
      ok: false,
      errorKind: "busy",
      errorMessage: errorText,
      canRetry: true,
    };
  }

  if (!response.ok || !response.body) {
    return {
      ok: false,
      errorKind: "generic",
      errorMessage: GENERIC_ERROR_MESSAGE,
    };
  }

  // Read response stream
  let accumulatedText = "";
  const decoder = new TextDecoder("utf-8");
  const reader = response.body.getReader();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        // Flush any remaining trailing bytes
        const finalChunk = decoder.decode();
        if (finalChunk) {
          accumulatedText += finalChunk;
          if (options.onChunk) {
            options.onChunk(finalChunk);
          }
        }
        break;
      }
      if (value) {
        const textChunk = decoder.decode(value, { stream: true });
        if (textChunk) {
          accumulatedText += textChunk;
          if (options.onChunk) {
            options.onChunk(textChunk);
          }
        }
      }
    }

    return {
      ok: true,
      fullText: accumulatedText,
      conversationId: returnedConvId,
    };
  } catch (streamErr: unknown) {
    if (streamErr instanceof Error && streamErr.name === "AbortError") {
      throw streamErr;
    }
    // Mid-stream interruption: return whatever partial text was accumulated
    return {
      ok: false,
      errorKind: "mid_stream_cutoff",
      errorMessage: MID_STREAM_CUTOFF_MESSAGE,
      partialText: accumulatedText,
      canRetry: false,
    };
  }
}

