import { APICallError, isStepCount, streamText } from "ai";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getChatModel, getModelIds } from "../../../lib/llm/model";
import { resolveClinicId } from "../../../lib/llm/resolve-clinic";
import { buildSystemPrompt } from "../../../lib/llm/system-prompt";
import { createChatTools } from "../../../lib/llm/tools";
import { getAdminClient } from "../../../lib/supabase/admin";

// 1. Request body schema: conversation_id is optional UUID, message is 1-1000 trimmed chars.
// Extra properties like clinic_id are silently ignored and never parsed into application state.
const chatRequestSchema = z.object({
  conversation_id: z.string().uuid().optional(),
  message: z
    .string()
    .trim()
    .min(1, { message: "Message must not be empty" })
    .max(1000, { message: "Message must not exceed 1000 characters" }),
});

/**
 * Strips phone numbers, API keys, and sensitive tokens from server logs.
 */
function sanitizeForLogs(value: unknown): string {
  const str =
    typeof value === "string"
      ? value
      : value instanceof Error
      ? value.stack || value.message
      : JSON.stringify(value);

  return str
    .replace(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, "[PHONE_REDACTED]")
    .replace(/\b\d{10}\b/g, "[PHONE_REDACTED]")
    .replace(
      /(?:key|secret|token|password|auth|bearer)[\w-]*\s*[:=]\s*["']?[\w.-]+["']?/gi,
      "[SECRET_REDACTED]"
    );
}

/**
 * Checks if an error is considered retryable on a fallback model
 * (503, 429, or timeout/abort).
 */
function isRetryableError(err: unknown): boolean {
  if (!err) return false;
  if (APICallError.isInstance(err)) {
    return err.statusCode === 503 || err.statusCode === 429;
  }
  const errorObj = err as any;
  const status = errorObj.statusCode ?? errorObj.status;
  if (status === 503 || status === 429) return true;

  const name = errorObj.name;
  if (name === "AbortError" || name === "TimeoutError") return true;

  const msg = String(errorObj.message || "").toLowerCase();
  return (
    msg.includes("503") ||
    msg.includes("429") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("rate limit") ||
    msg.includes("resource exhausted") ||
    msg.includes("busy") ||
    msg.includes("abort")
  );
}

export async function POST(req: NextRequest | Request): Promise<Response> {
  const startTime = Date.now();
  const TOTAL_BUDGET_MS = 25_000;

  try {
    // A. Parse and validate JSON body
    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON in request body" }, { status: 400 });
    }

    const parsed = chatRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues.map((i) => i.message).join(", ") },
        { status: 400 }
      );
    }

    const { conversation_id, message } = parsed.data;

    // B. Resolve tenant clinic ID strictly from server environment
    const clinicId = await resolveClinicId();
    const supabase = getAdminClient();

    // C. Fetch clinic settings (name, timezone, handoff_phone)
    const { data: clinic, error: clinicErr } = await supabase
      .from("clinics")
      .select("id, name, timezone, handoff_phone")
      .eq("id", clinicId)
      .single();

    if (clinicErr || !clinic) {
      console.error("[Chat API Error] Clinic not found:", sanitizeForLogs(clinicErr));
      return NextResponse.json({ error: "Clinic not found" }, { status: 404 });
    }

    // D. Validate or create conversation
    let conversationId: string;
    let conversationStatus = "active";

    if (conversation_id) {
      const { data: conv, error: convErr } = await supabase
        .from("conversations")
        .select("id, clinic_id, status")
        .eq("id", conversation_id)
        .single();

      if (convErr || !conv || conv.clinic_id !== clinicId) {
        return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
      }

      conversationId = conv.id;
      conversationStatus = conv.status;
    } else {
      const { data: newConv, error: createConvErr } = await supabase
        .from("conversations")
        .insert({ clinic_id: clinicId, status: "active" })
        .select("id, status")
        .single();

      if (createConvErr || !newConv) {
        console.error(
          "[Chat API Error] Failed to create conversation:",
          sanitizeForLogs(createConvErr)
        );
        return NextResponse.json({ error: "Failed to create conversation" }, { status: 500 });
      }

      conversationId = newConv.id;
      conversationStatus = newConv.status;
    }

    // E. Persist incoming user message
    const { error: userMsgErr } = await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: "user",
      content: message,
    });

    if (userMsgErr) {
      console.error(
        "[Chat API Error] Failed to persist user message:",
        sanitizeForLogs(userMsgErr)
      );
      return NextResponse.json({ error: "Failed to record message" }, { status: 500 });
    }

    // F. If conversation is handed_off or closed, return fixed message without calling LLM
    if (conversationStatus === "handed_off" || conversationStatus === "closed") {
      const handoffReply = clinic.handoff_phone
        ? `A member of our clinic team will contact you shortly. If urgent, you can reach us at ${clinic.handoff_phone}.`
        : `A member of our clinic team will contact you shortly.`;

      return new Response(handoffReply, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "X-Conversation-Id": conversationId,
        },
      });
    }

    // G. Load conversation history (last 20 messages, chronological order)
    const { data: recentMsgs, error: histErr } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(20);

    if (histErr) {
      console.error("[Chat API Error] Failed to load history:", sanitizeForLogs(histErr));
    }

    // DECISIONS.md: History replays message text only, not tool results.
    const historyRows = (recentMsgs || []).reverse();
    const modelMessages = historyRows
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content || "",
      }));

    // H. Configure system prompt and tools
    const systemPrompt = buildSystemPrompt({
      clinicName: clinic.name,
      timezone: clinic.timezone,
    });

    const tools = createChatTools(clinicId, conversationId);

    // Provider options: only configure thinking budget if LLM_THINKING_BUDGET is defined
    let providerOptions: Record<string, any> | undefined = undefined;
    if (
      process.env.LLM_THINKING_BUDGET !== undefined &&
      process.env.LLM_THINKING_BUDGET.trim() !== ""
    ) {
      const budget = parseInt(process.env.LLM_THINKING_BUDGET, 10);
      if (!isNaN(budget)) {
        providerOptions = {
          google: {
            thinkingConfig: {
              thinkingBudget: budget,
            },
          },
        };
      }
    }

    // I. Model Fallback Execution Loop
    const modelIds = getModelIds();
    let successfulStreamResult: any = null;
    let successfulReader: any = null;
    let successfulFirstChunk: any = null;

    for (let attempt = 0; attempt < modelIds.length; attempt++) {
      const currentModelId = modelIds[attempt];
      const elapsedTotal = Date.now() - startTime;
      if (elapsedTotal >= TOTAL_BUDGET_MS) {
        console.error(
          `[Chat API] Total timeout (${TOTAL_BUDGET_MS}ms) reached before attempt ${attempt + 1}`
        );
        break;
      }

      const remainingBudgetMs = TOTAL_BUDGET_MS - elapsedTotal;
      // Per-attempt timeout applies to time-to-first-output only
      const firstOutputTimeoutMs = Math.min(10_000, Math.max(1_000, remainingBudgetMs));
      const attemptAbortController = new AbortController();

      let hasProducedOutput = false;
      let toolCallExecuted = false;
      let streamError: unknown = null;

      const firstOutputTimer = setTimeout(() => {
        if (!hasProducedOutput) {
          attemptAbortController.abort(new Error("Timeout waiting for first output"));
        }
      }, firstOutputTimeoutMs);

      let streamResult: any;
      try {
        const model = getChatModel(currentModelId, attempt);

        streamResult = streamText({
          model,
          system: systemPrompt,
          messages: modelMessages,
          tools,
          stopWhen: isStepCount(5),
          maxRetries: 0,
          abortSignal: attemptAbortController.signal,
          ...(providerOptions ? { providerOptions } : {}),
          onToolExecutionStart: () => {
            hasProducedOutput = true;
            toolCallExecuted = true;
            clearTimeout(firstOutputTimer);
          },
          onError: ({ error }) => {
            streamError = streamError || error;
          },
          onEnd: async ({ text, steps, usage }) => {
            try {
              const latencyMs = Date.now() - startTime;
              const inputTokens = usage?.inputTokens ?? null;
              const outputTokens = usage?.outputTokens ?? null;

              const toolCallsData =
                steps?.flatMap((s) =>
                  (s.toolCalls || []).map((tc: any) => {
                    const resultObj: any = (s.toolResults || []).find(
                      (tr: any) => tr.toolCallId === tc.toolCallId
                    );
                    return {
                      toolCallId: tc.toolCallId,
                      toolName: tc.toolName,
                      args: tc.input ?? tc.args,
                      result: resultObj?.output ?? resultObj?.result,
                    };
                  })
                ) || [];

              await supabase.from("messages").insert({
                conversation_id: conversationId,
                role: "assistant",
                content: text,
                tool_calls: toolCallsData.length > 0 ? toolCallsData : null,
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                latency_ms: latencyMs,
              });
            } catch (persistErr) {
              console.error(
                "[Chat API Error] Failed to persist assistant turn:",
                sanitizeForLogs(persistErr)
              );
            }
          },
        });

        const reader = streamResult.textStream.getReader();
        let firstChunk: any;
        try {
          firstChunk = await reader.read();
          if (firstChunk?.value && firstChunk.value.length > 0) {
            hasProducedOutput = true;
          }
        } catch (readErr) {
          streamError = streamError || readErr;
        } finally {
          clearTimeout(firstOutputTimer);
        }

        if (attemptAbortController.signal.aborted) {
          streamError =
            streamError ||
            attemptAbortController.signal.reason ||
            new Error("Attempt timed out waiting for first output");
        }

        if (streamError) {
          console.error(
            `[Chat API Model Error on attempt ${attempt + 1}/${modelIds.length} (${currentModelId})]:`,
            sanitizeForLogs(streamError)
          );

          // Rule 1: Fail over to the next model only if the failed attempt has produced NO output of any kind
          // (no text and no tool call executed). Once any tool call has executed, never retry on another model.
          if (toolCallExecuted || hasProducedOutput) {
            break;
          }

          if (isRetryableError(streamError) && attempt < modelIds.length - 1) {
            continue;
          }

          break;
        }

        // Attempt succeeded with first output!
        successfulStreamResult = streamResult;
        successfulReader = reader;
        successfulFirstChunk = firstChunk;
        break;
      } catch (err: unknown) {
        clearTimeout(firstOutputTimer);
        console.error(
          `[Chat API Model Exception on attempt ${attempt + 1}/${modelIds.length} (${currentModelId})]:`,
          sanitizeForLogs(err)
        );

        if (toolCallExecuted || hasProducedOutput) {
          break;
        }

        if (isRetryableError(err) && attempt < modelIds.length - 1) {
          continue;
        }

        break;
      }
    }

    // J. If all models failed or execution failed after output/tool execution:
    if (!successfulStreamResult) {
      const friendly503 = "We're very busy, please try again in a minute";
      try {
        await supabase.from("messages").insert({
          conversation_id: conversationId,
          role: "assistant",
          content: friendly503,
          tool_calls: null,
          input_tokens: null,
          output_tokens: null,
          latency_ms: Date.now() - startTime,
        });
      } catch (persistFallbackErr) {
        console.error(
          "[Chat API Error] Failed to persist fallback message:",
          sanitizeForLogs(persistFallbackErr)
        );
      }

      return new Response(friendly503, {
        status: 503,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "X-Conversation-Id": conversationId,
        },
      });
    }

    // K. Keep consuming the stream in the background even if client disconnects
    if (typeof successfulStreamResult.consumeStream === "function") {
      Promise.resolve(successfulStreamResult.consumeStream()).catch((consumeErr: unknown) => {
        console.error("[Chat API Background Stream Error]:", sanitizeForLogs(consumeErr));
      });
    }

    // L. Stream response to client starting from the peeked first chunk
    const textEncoder = new TextEncoder();
    const responseStream = new ReadableStream({
      async start(controller) {
        if (successfulFirstChunk?.value) {
          controller.enqueue(textEncoder.encode(successfulFirstChunk.value));
        }
        if (successfulFirstChunk?.done) {
          controller.close();
          return;
        }
        try {
          while (true) {
            const { value, done } = await successfulReader.read();
            if (done) break;
            if (value) {
              controller.enqueue(textEncoder.encode(value));
            }
          }
          controller.close();
        } catch (streamPipeErr) {
          controller.error(streamPipeErr);
        }
      },
      cancel() {
        successfulReader.cancel();
      },
    });

    return new Response(responseStream, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Conversation-Id": conversationId,
      },
    });
  } catch (err: unknown) {
    console.error("[Chat API Fatal Error]:", sanitizeForLogs(err));
    return new Response("We're very busy, please try again in a minute", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
