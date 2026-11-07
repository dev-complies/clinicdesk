/**
 * tests/chat-client.test.ts
 *
 * Unit tests for src/lib/chat-client.ts.
 * Runs in pure Vitest with fake Response / ReadableStream objects.
 * Zero real model calls, zero database calls, zero browser dependencies.
 */

import { describe, expect, it, vi } from "vitest";
import {
  EXPIRED_CONVERSATION_MESSAGE,
  GENERIC_ERROR_MESSAGE,
  MID_STREAM_CUTOFF_MESSAGE,
  sendMessageStream,
} from "../src/lib/chat-client";

// Helper to create a streaming Response from an array of string or Uint8Array chunks
function createMockStreamResponse(
  chunks: Array<string | Uint8Array>,
  init: ResponseInit = {}
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        if (typeof chunk === "string") {
          controller.enqueue(encoder.encode(chunk));
        } else {
          controller.enqueue(chunk);
        }
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...(init.headers || {}) },
    ...init,
  });
}

describe("chat-client (sendMessageStream)", () => {
  it("rejects empty or whitespace-only messages without calling fetch", async () => {
    const mockFetch = vi.fn();
    const result = await sendMessageStream({ message: "   " }, mockFetch as any);
    expect(result.ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("assembles streamed chunks in order and invokes onChunk for each", async () => {
    const chunks = ["Namaste, ", "how can ", "I help you ", "today?"];
    const mockRes = createMockStreamResponse(chunks, {
      headers: { "x-conversation-id": "conv-123" },
    });
    const mockFetch = vi.fn().mockResolvedValue(mockRes);

    const receivedChunks: string[] = [];
    let receivedConvId: string | null = null;

    const result = await sendMessageStream(
      {
        message: "hello",
        onChunk: (delta) => receivedChunks.push(delta),
        onConversationId: (id) => (receivedConvId = id),
      },
      mockFetch as any
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fullText).toBe("Namaste, how can I help you today?");
      expect(result.conversationId).toBe("conv-123");
    }
    expect(receivedChunks).toEqual(chunks);
    expect(receivedConvId).toBe("conv-123");

    // Assert payload had message and did NOT have clinic_id
    const fetchArgs = mockFetch.mock.calls[0];
    const payload = JSON.parse(fetchArgs[1].body);
    expect(payload.message).toBe("hello");
    expect(payload.clinic_id).toBeUndefined();
    expect(payload.conversation_id).toBeUndefined();
  });

  it("passes conversation_id if provided, but never sends clinic_id", async () => {
    const mockRes = createMockStreamResponse(["OK"]);
    const mockFetch = vi.fn().mockResolvedValue(mockRes);

    await sendMessageStream(
      { message: "check timing", conversationId: "c-456" },
      mockFetch as any
    );

    const payload = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(payload.message).toBe("check timing");
    expect(payload.conversation_id).toBe("c-456");
    expect(payload.clinic_id).toBeUndefined();
  });

  it("splits a Devanagari string across chunks at a byte boundary and decodes the exact text", async () => {
    // "नमस्ते" in UTF-8 is 18 bytes:
    // न: [0xE0, 0xA4, 0xA8]
    // म: [0xE0, 0xA4, 0xAE]
    // स: [0xE0, 0xA4, 0xB8]
    // ् (halant): [0xE0, 0xA5, 0x8D]
    // त: [0xE0, 0xA4, 0xA4]
    // े (matra): [0xE0, 0xA5, 0x87]
    const fullText = "नमस्ते, आपका स्वागत है।";
    const fullBytes = new TextEncoder().encode(fullText);

    // Split arbitrarily at 4-byte boundaries, which cuts multi-byte UTF-8 sequences in the middle
    const chunk1 = fullBytes.subarray(0, 4);  // cuts inside second char
    const chunk2 = fullBytes.subarray(4, 11); // cuts inside another char
    const chunk3 = fullBytes.subarray(11);

    const mockRes = createMockStreamResponse([chunk1, chunk2, chunk3]);
    const mockFetch = vi.fn().mockResolvedValue(mockRes);

    const receivedChunks: string[] = [];
    const result = await sendMessageStream(
      {
        message: "namaste",
        onChunk: (delta) => receivedChunks.push(delta),
      },
      mockFetch as any
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fullText).toBe(fullText);
    }
    // Assembled text must match the exact Devanagari input
    expect(receivedChunks.join("")).toBe(fullText);
  });

  it("maps 404 to expired_conversation error", async () => {
    const mockRes = new Response("Not found", { status: 404 });
    const mockFetch = vi.fn().mockResolvedValue(mockRes);

    const result = await sendMessageStream(
      { message: "hello", conversationId: "expired-id" },
      mockFetch as any
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorKind).toBe("expired_conversation");
      expect(result.errorMessage).toBe(EXPIRED_CONVERSATION_MESSAGE);
    }
  });

  it("maps 429 to rate_limited with server plain text", async () => {
    const serverMessage =
      "You have sent too many messages. Please wait a moment before trying again. If this is an emergency, call 112 immediately.";
    const mockRes = new Response(serverMessage, {
      status: 429,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
    const mockFetch = vi.fn().mockResolvedValue(mockRes);

    const result = await sendMessageStream({ message: "burst" }, mockFetch as any);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorKind).toBe("rate_limited");
      expect(result.errorMessage).toBe(serverMessage);
    }
  });

  it("maps 503 to busy with canRetry: true and server text", async () => {
    const serverText = "We're very busy, please try again in a minute";
    const mockRes = new Response(serverText, {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
    const mockFetch = vi.fn().mockResolvedValue(mockRes);

    const result = await sendMessageStream({ message: "book slot" }, mockFetch as any);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorKind).toBe("busy");
      expect(result.errorMessage).toBe(serverText);
      expect(result.canRetry).toBe(true);
    }
  });

  it("uses generic fallback for 503 with HTML body", async () => {
    const htmlBody = "<html><body>503 Service Unavailable Cloudflare</body></html>";
    const mockRes = new Response(htmlBody, {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
    const mockFetch = vi.fn().mockResolvedValue(mockRes);

    const result = await sendMessageStream({ message: "hello" }, mockFetch as any);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorKind).toBe("busy");
      // Must not leak the HTML tags
      expect(result.errorMessage).toBe("We're very busy, please try again in a minute");
      expect(result.errorMessage).not.toContain("<html");
      expect(result.canRetry).toBe(true);
    }
  });

  it("caps oversized 429/503 error text at 300 characters", async () => {
    const longText = "A".repeat(500);
    const mockRes = new Response(longText, {
      status: 429,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
    const mockFetch = vi.fn().mockResolvedValue(mockRes);

    const result = await sendMessageStream({ message: "hello" }, mockFetch as any);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorMessage.length).toBe(300);
      expect(result.errorMessage).toBe("A".repeat(300));
    }
  });

  it("keeps partial text and reports cutoff if stream errors mid-way", async () => {
    const encoder = new TextEncoder();
    let readCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        readCount++;
        if (readCount === 1) {
          controller.enqueue(encoder.encode("Partial start... "));
        } else {
          controller.error(new Error("Connection terminated by server"));
        }
      },
    });

    const mockRes = new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
    const mockFetch = vi.fn().mockResolvedValue(mockRes);

    const receivedChunks: string[] = [];
    const result = await sendMessageStream(
      {
        message: "hello",
        onChunk: (delta) => receivedChunks.push(delta),
      },
      mockFetch as any
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorKind).toBe("mid_stream_cutoff");
      expect(result.errorMessage).toBe(MID_STREAM_CUTOFF_MESSAGE);
      expect(result.partialText).toBe("Partial start... ");
      expect(result.canRetry).toBe(false); // No auto-retry for mid-stream cutoff per requirement
    }
    expect(receivedChunks).toEqual(["Partial start... "]);
  });

  it("maps network failure (fetch throws) to generic error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Failed to fetch"));

    const result = await sendMessageStream({ message: "hello" }, mockFetch as any);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorKind).toBe("generic");
      expect(result.errorMessage).toBe(GENERIC_ERROR_MESSAGE);
    }
  });

  it("rethrows AbortError when signal is cancelled", async () => {
    const abortErr = new Error("The user aborted a request.");
    abortErr.name = "AbortError";
    const mockFetch = vi.fn().mockRejectedValue(abortErr);

    await expect(
      sendMessageStream({ message: "hello" }, mockFetch as any)
    ).rejects.toThrow("The user aborted a request.");
  });
});

