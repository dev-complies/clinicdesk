import * as dotenv from "dotenv";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { POST } from "../src/app/api/chat/route";
import { setModelOverride } from "../src/lib/llm/model";
import { createChatTools } from "../src/lib/llm/tools";
import { getAdminClient } from "../src/lib/supabase/admin";
import { APICallError } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

function mockUsage(input: number = 10, output: number = 5): any {
  return {
    inputTokens: { total: input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: undefined, reasoning: undefined },
  };
}

describe("POST /api/chat - Core Chat Endpoint & Resiliency", () => {
  let clinicAId: string;
  let clinicBId: string;

  const createdConversationIds = new Set<string>();

  beforeAll(async () => {
    const supabase = getAdminClient();

    const { data: clinicA, error: errA } = await supabase
      .from("clinics")
      .select("id")
      .eq("name", "Demo Clinic A")
      .single();
    if (errA || !clinicA) throw new Error(`Demo Clinic A not found: ${errA?.message}`);
    clinicAId = clinicA.id;

    const { data: clinicB, error: errB } = await supabase
      .from("clinics")
      .select("id")
      .eq("name", "Demo Clinic B")
      .single();
    if (errB || !clinicB) throw new Error(`Demo Clinic B not found: ${errB?.message}`);
    clinicBId = clinicB.id;

    process.env.DEMO_CLINIC_ID = clinicAId;
    process.env.LLM_MODEL = "test-primary-model";
    process.env.LLM_FALLBACK_MODELS = "test-fallback-model";
  });

  afterEach(() => {
    setModelOverride(null);
  });

  afterAll(async () => {
    // Wait for any in-flight stream onEnd callbacks to finish inserting
    await new Promise((resolve) => setTimeout(resolve, 500));

    const supabase = getAdminClient();
    if (createdConversationIds.size > 0) {
      const { error: delErr } = await supabase
        .from("conversations")
        .delete()
        .in("id", Array.from(createdConversationIds));
      if (delErr) {
        console.error("Failed to delete test conversations:", delErr);
      }
    }

    // Safety sweep for any lingering test messages / conversations
    const { data: lingeringMsgs } = await supabase
      .from("messages")
      .select("conversation_id")
      .or(
        "content.ilike.%Hello when provider fails%,content.ilike.%Looping tool test%,content.ilike.%Hello mid-stream error%,content.ilike.%Hello when all fail%,content.ilike.%List doctors then fail%,content.ilike.%Hello clinic%,content.ilike.%Hello resiliency test%,content.ilike.%Please book an appointment%,content.ilike.%Which doctors do you have%"
      );

    if (lingeringMsgs && lingeringMsgs.length > 0) {
      const ids = Array.from(new Set(lingeringMsgs.map((m) => m.conversation_id)));
      await supabase.from("messages").delete().in("conversation_id", ids);
      await supabase.from("conversations").delete().in("id", ids);
    }
  });

  it("message longer than 1000 chars returns 400", async () => {
    const longMessage = "a".repeat(1001);
    const req = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: longMessage }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("1000");
  });

  it("empty message returns 400", async () => {
    const req = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "   " }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("clinic_id in request body is ignored and server clinicId is used", async () => {
    const mockModel = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "1" },
            { type: "text-delta", id: "1", delta: "Welcome to Clinic A!" },
            { type: "text-end", id: "1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: mockUsage(10, 5),
            },
          ] as any,
        }),
      }),
    });
    setModelOverride(mockModel);

    const req = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clinic_id: clinicBId,
        message: "Hello clinic",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const convId = res.headers.get("X-Conversation-Id");
    expect(convId).toBeTruthy();
    if (convId) createdConversationIds.add(convId);

    const supabase = getAdminClient();
    const { data: conv } = await supabase
      .from("conversations")
      .select("clinic_id")
      .eq("id", convId!)
      .single();

    expect(conv?.clinic_id).toBe(clinicAId);
    expect(conv?.clinic_id).not.toBe(clinicBId);
  });

  it("a conversation_id belonging to another clinic returns 404 and creates nothing", async () => {
    const supabase = getAdminClient();

    const { data: convB } = await supabase
      .from("conversations")
      .insert({ clinic_id: clinicBId, status: "active" })
      .select("id")
      .single();

    expect(convB).toBeTruthy();
    createdConversationIds.add(convB!.id);

    const req = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: convB!.id,
        message: "Attempting to access clinic B conversation",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("Conversation not found");

    const { data: msgs } = await supabase
      .from("messages")
      .select("id")
      .eq("conversation_id", convB!.id);

    expect(msgs?.length).toBe(0);
  });

  it("a handed_off conversation does not call the model and persists only user message", async () => {
    const supabase = getAdminClient();

    const { data: conv } = await supabase
      .from("conversations")
      .insert({ clinic_id: clinicAId, status: "handed_off" })
      .select("id")
      .single();

    expect(conv).toBeTruthy();
    createdConversationIds.add(conv!.id);

    let modelCalled = false;
    const mockModel = new MockLanguageModelV3({
      doStream: async () => {
        modelCalled = true;
        return {
          stream: simulateReadableStream({ chunks: [] as any }),
        };
      },
    });
    setModelOverride(mockModel);

    const req = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: conv!.id,
        message: "Is anyone there?",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(modelCalled).toBe(false);

    const text = await res.text();
    expect(text).toContain("team will contact you");

    const { data: msgs } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conv!.id);

    expect(msgs?.length).toBe(1);
    expect(msgs![0].role).toBe("user");
    expect(msgs![0].content).toBe("Is anyone there?");
  });

  it("a mocked tool call (list_doctors) executes with the server clinicId and reaches the model", async () => {
    let capturedPromptForStep2: any = null;

    let step = 0;
    const mockModel = new MockLanguageModelV3({
      doStream: async (options) => {
        step++;
        if (step === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                {
                  type: "tool-call",
                  toolCallId: "call_1",
                  toolName: "list_doctors",
                  input: JSON.stringify({}),
                },
                {
                  type: "finish",
                  finishReason: { unified: "tool-calls", raw: "tool_calls" },
                  usage: mockUsage(12, 6),
                },
              ] as any,
            }),
          };
        } else {
          capturedPromptForStep2 = options.prompt;
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "text-start", id: "2" },
                {
                  type: "text-delta",
                  id: "2",
                  delta: "We have doctors available at Clinic A.",
                },
                { type: "text-end", id: "2" },
                {
                  type: "finish",
                  finishReason: { unified: "stop", raw: "stop" },
                  usage: mockUsage(20, 10),
                },
              ] as any,
            }),
          };
        }
      },
    });
    setModelOverride(mockModel);

    const req = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Which doctors do you have?" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const convId = res.headers.get("X-Conversation-Id");
    if (convId) createdConversationIds.add(convId);

    const responseText = await res.text();
    expect(responseText).toBe("We have doctors available at Clinic A.");

    expect(capturedPromptForStep2).toBeTruthy();
    const promptJson = JSON.stringify(capturedPromptForStep2);

    expect(promptJson).toContain("Dr. Priya Sharma");
    expect(promptJson).toContain("Dr. Rahul Mehta");
    expect(promptJson).not.toContain("Dr. Anjali Singh");
  });

  it("persists messages, tool_calls, and token usage in the messages table", async () => {
    const mockModel = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "1" },
            { type: "text-delta", id: "1", delta: "Appointment booked successfully." },
            { type: "text-end", id: "1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: mockUsage(45, 15),
            },
          ] as any,
        }),
      }),
    });
    setModelOverride(mockModel);

    const req = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Please book an appointment" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const convId = res.headers.get("X-Conversation-Id");
    expect(convId).toBeTruthy();
    if (convId) createdConversationIds.add(convId);

    await res.text();

    const supabase = getAdminClient();
    let msgs: any[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      const { data } = await supabase
        .from("messages")
        .select("role, content, input_tokens, output_tokens, latency_ms")
        .eq("conversation_id", convId!)
        .order("created_at", { ascending: true });
      msgs = data || [];
      if (msgs.length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    expect(msgs.length).toBe(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("Please book an appointment");

    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].content).toBe("Appointment booked successfully.");
    expect(msgs[1].input_tokens).toBe(45);
    expect(msgs[1].output_tokens).toBe(15);
    expect(typeof msgs[1].latency_ms).toBe("number");
    expect(msgs[1].latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("step cap stops a model that keeps calling tools", async () => {
    let stepCount = 0;
    const mockModel = new MockLanguageModelV3({
      doStream: async () => {
        stepCount++;
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call",
                toolCallId: `call_${stepCount}`,
                toolName: "list_doctors",
                input: JSON.stringify({}),
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool_calls" },
                usage: mockUsage(5, 5),
              },
            ] as any,
          }),
        };
      },
    });
    setModelOverride(mockModel);

    const req = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Looping tool test" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const convId = res.headers.get("X-Conversation-Id");
    if (convId) createdConversationIds.add(convId);

    await res.text();
    expect(stepCount).toBe(5);
  });

  it("inspects tool schemas passed to model and asserts none contain clinicId, conversationId, or now", () => {
    const tools = createChatTools("dummy-clinic-id", "dummy-conv-id");

    const toolKeys = Object.keys(tools) as Array<keyof typeof tools>;
    expect(toolKeys.length).toBe(7);

    for (const key of toolKeys) {
      const toolDef = tools[key];
      const schema = toolDef.inputSchema as z.ZodTypeAny;

      let current: any = schema;
      while (current._def?.innerType) {
        current = current._def.innerType;
      }

      if (current.shape) {
        const shapeKeys = Object.keys(current.shape);
        expect(shapeKeys).not.toContain("clinicId");
        expect(shapeKeys).not.toContain("clinic_id");
        expect(shapeKeys).not.toContain("conversationId");
        expect(shapeKeys).not.toContain("conversation_id");
        expect(shapeKeys).not.toContain("now");
      }
    }
  });

  // ── RESILIENCY & FAILOVER TESTS ──────────────────────────────────────────────

  it("first model fails with 503 and the second succeeds", async () => {
    let model1Called = false;
    let model2Called = false;

    const model1 = new MockLanguageModelV3({
      doStream: async () => {
        model1Called = true;
        throw new APICallError({
          message: "Service temporarily unavailable",
          url: "https://api.test",
          requestBodyValues: {},
          statusCode: 503,
        });
      },
    });

    const model2 = new MockLanguageModelV3({
      doStream: async () => {
        model2Called = true;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "1" },
              { type: "text-delta", id: "1", delta: "Recovered successfully on fallback model." },
              { type: "text-end", id: "1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: mockUsage(15, 8),
              },
            ] as any,
          }),
        };
      },
    });

    setModelOverride([model1, model2]);

    const req = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hello resiliency test" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const convId = res.headers.get("X-Conversation-Id");
    if (convId) createdConversationIds.add(convId);

    const text = await res.text();
    expect(text).toBe("Recovered successfully on fallback model.");
    expect(model1Called).toBe(true);
    expect(model2Called).toBe(true);
  });

  it("all models fail returns the friendly 503 and persists the fallback message", async () => {
    const model1 = new MockLanguageModelV3({
      doStream: async () => {
        throw new APICallError({
          message: "Rate limit exceeded (429)",
          url: "https://api.test",
          requestBodyValues: {},
          statusCode: 429,
        });
      },
    });

    const model2 = new MockLanguageModelV3({
      doStream: async () => {
        throw new APICallError({
          message: "Service unavailable (503)",
          url: "https://api.test",
          requestBodyValues: {},
          statusCode: 503,
        });
      },
    });

    setModelOverride([model1, model2]);

    const req = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hello when all fail" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(503);

    const convId = res.headers.get("X-Conversation-Id");
    expect(convId).toBeTruthy();
    if (convId) createdConversationIds.add(convId);

    const responseText = await res.text();
    expect(responseText).toBe("We're very busy, please try again in a minute");
    expect(responseText).not.toContain("Rate limit");
    expect(responseText).not.toContain("429");
    expect(responseText).not.toContain("503");

    // Verify fallback assistant message was persisted
    const supabase = getAdminClient();
    const { data: msgs } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", convId!)
      .order("created_at", { ascending: true });

    expect(msgs?.length).toBe(2);
    expect(msgs![0].role).toBe("user");
    expect(msgs![1].role).toBe("assistant");
    expect(msgs![1].content).toBe("We're very busy, please try again in a minute");
  });

  it("a failure after streaming has started is not retried on another model", async () => {
    let model2Called = false;

    const model1 = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-start", id: "1" });
            controller.enqueue({ type: "text-delta", id: "1", delta: "Partial stream content..." });
            // Simulate stream error after text output has begun
            setTimeout(() => {
              try {
                controller.error(new Error("Connection reset mid-stream"));
              } catch {
                // Ignore if stream already handled
              }
            }, 50);
          },
        }) as any,
      }),
    });

    const model2 = new MockLanguageModelV3({
      doStream: async () => {
        model2Called = true;
        return {
          stream: simulateReadableStream({ chunks: [] as any }),
        };
      },
    });

    setModelOverride([model1, model2]);

    const req = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hello mid-stream error" }),
    });

    const res = await POST(req);
    const convId = res.headers.get("X-Conversation-Id");
    if (convId) createdConversationIds.add(convId);

    // Since streaming began, response was initiated
    expect(res.status).toBe(200);

    try {
      await res.text();
    } catch {
      // Expected to fail mid-stream
    }

    // Model 2 must NOT have been called mid-stream
    expect(model2Called).toBe(false);
  });

  it("model 1 executes a tool then fails, model 2 must NOT be called and the tool must have run exactly once", async () => {
    let toolExecutionCount = 0;
    let model2Called = false;

    let step = 0;
    const model1 = new MockLanguageModelV3({
      doStream: async () => {
        step++;
        if (step === 1) {
          toolExecutionCount++;
          return {
            stream: simulateReadableStream({
              chunks: [
                {
                  type: "tool-call",
                  toolCallId: "call_resched_1",
                  toolName: "list_doctors",
                  input: JSON.stringify({}),
                },
                {
                  type: "finish",
                  finishReason: { unified: "tool-calls", raw: "tool_calls" },
                  usage: mockUsage(10, 5),
                },
              ] as any,
            }),
          };
        } else {
          // Model 1 fails on step 2 after tool execution has taken place
          throw new APICallError({
            message: "Model 1 crashed after tool",
            url: "https://api.test",
            requestBodyValues: {},
            statusCode: 503,
          });
        }
      },
    });

    const model2 = new MockLanguageModelV3({
      doStream: async () => {
        model2Called = true;
        return {
          stream: simulateReadableStream({ chunks: [] as any }),
        };
      },
    });

    setModelOverride([model1, model2]);

    const req = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "List doctors then fail" }),
    });

    const res = await POST(req);
    const convId = res.headers.get("X-Conversation-Id");
    if (convId) createdConversationIds.add(convId);

    expect(res.status).toBe(503);

    const text = await res.text();
    expect(text).toBe("We're very busy, please try again in a minute");

    // Tool must have been initiated once
    expect(toolExecutionCount).toBe(1);
    // Model 2 must NOT be called because tool execution has side effects
    expect(model2Called).toBe(false);
  });
});
