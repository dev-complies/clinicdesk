/**
 * evals/runner.ts
 *
 * Core execution engine for ClinicDesk evaluations.
 * Runs scenarios in-process against the real model and real embeddings via POST /api/chat.
 * Features:
 * - Deterministic template expansion and scenario setup (seeded appointments/patients).
 * - Per-scenario phone number allocation (+9199999XXXXX) and distinct fake IP.
 * - Backoff retries on 429/503 rate-limits/busy responses; classifies exhausted retries as INFRA_ERROR.
 * - Minimum delay between model-calling turns (EVAL_MIN_DELAY_MS, default 6000ms); zero delay for emergencies.
 * - Strict cleanup in finally blocks ensuring zero row leaks.
 * - Post-run database row count invariance verification.
 */

import fs from "fs";
import path from "path";
import { POST } from "../src/app/api/chat/route";
import { evaluateExpectations } from "./checks";
import { runSafetyGuard } from "./safety";
import { expandTemplate, maskPhone, TemplateContext } from "./template";
import {
  CategorySummary,
  EvalRunReport,
  Scenario,
  ScenarioFile,
  ScenarioFileSchema,
  ScenarioRunResult,
  ScenarioStatus,
  ScenarioSummary,
  TurnExecutionResult,
} from "./types";
import { SupabaseClient } from "@supabase/supabase-js";
import { DateTime } from "luxon";
import { buildSystemPrompt } from "../src/lib/llm/system-prompt";

export interface RunnerOptions {
  category?: string;
  id?: string;
  repeat?: number;
  yes?: boolean;
  allowFallback?: boolean;
  dryRun?: boolean;
  minDelayMs?: number;
  scenariosDir?: string;
  customPostHandler?: typeof POST;
}

export interface BaselineCounts {
  documents: number;
  chunks: number;
  messages: number;
  conversations: number;
  appointments: number;
  patients: number;
}

export async function fetchDatabaseCounts(supabase: SupabaseClient): Promise<BaselineCounts> {
  const [
    { count: documents },
    { count: chunks },
    { count: messages },
    { count: conversations },
    { count: appointments },
    { count: patients },
  ] = await Promise.all([
    supabase.from("documents").select("*", { count: "exact", head: true }),
    supabase.from("chunks").select("*", { count: "exact", head: true }),
    supabase.from("messages").select("*", { count: "exact", head: true }),
    supabase.from("conversations").select("*", { count: "exact", head: true }),
    supabase.from("appointments").select("*", { count: "exact", head: true }),
    supabase.from("patients").select("*", { count: "exact", head: true }),
  ]);

  return {
    documents: documents ?? 0,
    chunks: chunks ?? 0,
    messages: messages ?? 0,
    conversations: conversations ?? 0,
    appointments: appointments ?? 0,
    patients: patients ?? 0,
  };
}

export function loadAllScenarios(dir: string): Scenario[] {
  if (!fs.existsSync(dir)) {
    throw new Error(`Scenarios directory not found: ${dir}`);
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  const allScenarios: Scenario[] = [];
  const seenIds = new Set<string>();

  for (const file of files) {
    const fullPath = path.join(dir, file);
    const content = fs.readFileSync(fullPath, "utf-8");
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch (err: any) {
      throw new Error(`Invalid JSON in scenario file ${file}: ${err?.message}`);
    }

    const parsed = ScenarioFileSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(
        `Schema validation error in ${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`
      );
    }

    for (const scenario of parsed.data.scenarios) {
      if (seenIds.has(scenario.id)) {
        throw new Error(`Duplicate scenario id '${scenario.id}' found in ${file}`);
      }
      seenIds.add(scenario.id);
      allScenarios.push(scenario);
    }
  }

  return allScenarios;
}

export function isRetryableInfraResponse(status: number, bodyText: string): boolean {
  // Never retry if reply was cut off mid-stream
  if (
    bodyText.includes("cut off") ||
    bodyText.includes("The reply was cut off") ||
    bodyText.includes("check my appointments before trying again")
  ) {
    return false;
  }
  if (status === 429 || status === 503) return true;
  const lower = bodyText.toLowerCase();
  return (
    lower.includes("busy") ||
    lower.includes("rate limit") ||
    lower.includes("try again in a minute") ||
    lower.includes("too many requests")
  );
}

export async function runScenario(
  scenario: Scenario,
  scenarioIndex: number,
  runIndex: number,
  supabase: SupabaseClient,
  clinicAId: string,
  clinicBId: string,
  options: RunnerOptions
): Promise<ScenarioRunResult> {
  const postHandler = options.customPostHandler ?? POST;
  const minDelayMs = options.minDelayMs ?? 6000;

  // Assign isolated test phone from reserved range: +919999900001 onwards
  const phoneSuffix = String(scenarioIndex + 1).padStart(5, "0");
  const patientPhone = `+9199999${phoneSuffix}`;
  const fakeIp = `10.0.${Math.floor(scenarioIndex / 250)}.${(scenarioIndex % 250) + 1}`;

  const createdConversationIds = new Set<string>();
  const createdAppointmentIds = new Set<string>();
  const createdPatientIds = new Set<string>();

  let doctorAId: string | undefined;
  let clinicBAppointmentId: string | undefined;

  // Get primary doctor for Clinic A
  const { data: docA } = await supabase
    .from("doctors")
    .select("id")
    .eq("clinic_id", clinicAId)
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (docA) doctorAId = docA.id;

  try {
    // 1. Scenario setup
    if (scenario.setup?.seed_appointment) {
      const targetClinicId =
        scenario.setup.clinic === "clinic_b" ? clinicBId : clinicAId;

      // Ensure patient exists
      const { data: patient, error: patientErr } = await supabase
        .from("patients")
        .upsert(
          {
            clinic_id: targetClinicId,
            full_name: "Test Patient",
            phone: patientPhone,
          },
          { onConflict: "clinic_id,phone" }
        )
        .select("id")
        .single();

      if (patientErr || !patient) {
        throw new Error(`Failed to seed patient: ${patientErr?.message}`);
      }
      createdPatientIds.add(patient.id);

      // Resolve doctor for the appointment
      const { data: targetDoc } = await supabase
        .from("doctors")
        .select("id")
        .eq("clinic_id", targetClinicId)
        .eq("is_active", true)
        .limit(1)
        .single();

      if (!targetDoc) {
        throw new Error(`No doctor found for clinic ${targetClinicId} during setup`);
      }

      const daysAhead = scenario.setup.days_from_now ?? 7;
      const slotTime = scenario.setup.slot_time ?? "10:00";
      const startAt = DateTime.now()
        .setZone("Asia/Kolkata")
        .plus({ days: daysAhead })
        .toFormat(`yyyy-MM-dd'T'${slotTime}:00ZZ`);

      const { data: appt, error: apptErr } = await supabase
        .from("appointments")
        .insert({
          clinic_id: targetClinicId,
          doctor_id: targetDoc.id,
          patient_id: patient.id,
          start_at: startAt,
          status: "scheduled",
        })
        .select("id")
        .single();

      if (apptErr || !appt) {
        throw new Error(`Failed to seed appointment: ${apptErr?.message}`);
      }

      createdAppointmentIds.add(appt.id);
      if (scenario.setup.clinic === "clinic_b") {
        clinicBAppointmentId = appt.id;
      }
    }

    const templateContext: TemplateContext = {
      patientPhone,
      doctorAId,
      clinicBAppointmentId,
      now: DateTime.now().setZone("Asia/Kolkata"),
      timezone: "Asia/Kolkata",
    };

    let activeConversationId: string | undefined = undefined;
    const turnResults: TurnExecutionResult[] = [];
    let totalLatencyMs = 0;
    let totalTokens = 0;
    const systemPromptText = buildSystemPrompt({
      clinicName: "Demo Clinic A",
      timezone: "Asia/Kolkata",
    });

    // 2. Execute turns sequentially
    for (let t = 0; t < scenario.turns.length; t++) {
      const turn = scenario.turns[t];
      const userPrompt = expandTemplate(turn.user, templateContext);

      let replyText = "";
      let httpStatus = 200;
      let turnLatencyMs = 0;
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;
      let modelCalled = false;
      let persistedToolCalls: any[] = [];
      let turnPassed = true;
      let turnFailureReason: string | undefined;

      // Retry loop for rate-limits / 503 / busy text (max 3 retries)
      let turnSuccess = false;
      let retryCount = 0;
      const MAX_RETRIES = 3;

      while (!turnSuccess && retryCount <= MAX_RETRIES) {
        if (retryCount > 0) {
          const backoffMs = Math.pow(2, retryCount - 1) * 1000;
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }

        const turnStart = Date.now();
        const req = new Request("http://localhost:3000/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-forwarded-for": fakeIp,
          },
          body: JSON.stringify(
            activeConversationId
              ? { message: userPrompt, conversation_id: activeConversationId }
              : { message: userPrompt }
          ),
        });

        const res = await postHandler(req as any);
        turnLatencyMs = Date.now() - turnStart;
        httpStatus = res.status;
        replyText = await res.text();

        const returnedConvId = res.headers.get("X-Conversation-Id");
        if (returnedConvId) {
          activeConversationId = returnedConvId;
          createdConversationIds.add(returnedConvId);
        }

        if (isRetryableInfraResponse(httpStatus, replyText)) {
          retryCount++;
          if (retryCount > MAX_RETRIES) {
            // Exhausted retries -> INFRA_ERROR
            return {
              scenarioId: scenario.id,
              category: scenario.category,
              description: scenario.description,
              status: "INFRA_ERROR",
              runIndex,
              turns: turnResults,
              failedExpectation: `Infrastructure rate limit/busy response persisted after ${MAX_RETRIES} retries (status ${httpStatus})`,
              failedReplyText: replyText.slice(0, 300),
              totalLatencyMs,
              totalTokens,
            };
          }
          continue;
        }

        turnSuccess = true;
      }

      totalLatencyMs += turnLatencyMs;

      // Query database for assistant message metadata if conversation exists
      let conversationStatus = "active";
      if (activeConversationId) {
        const { data: conv } = await supabase
          .from("conversations")
          .select("status")
          .eq("id", activeConversationId)
          .single();
        if (conv) conversationStatus = conv.status;

        const { data: msgs } = await supabase
          .from("messages")
          .select("*")
          .eq("conversation_id", activeConversationId)
          .order("created_at", { ascending: false })
          .limit(1);

        if (msgs && msgs.length > 0 && msgs[0].role === "assistant") {
          inputTokens = msgs[0].input_tokens;
          outputTokens = msgs[0].output_tokens;
          totalTokens += (inputTokens ?? 0) + (outputTokens ?? 0);
          persistedToolCalls = msgs[0].tool_calls || [];
          // Model was called if input_tokens is non-null
          modelCalled = inputTokens !== null;
        }
      }

      // Check turn-level expectation if specified
      if (turn.expect) {
        const executedTools = persistedToolCalls.map((tc: any) => tc.toolName);
        const check = await evaluateExpectations(turn.expect, {
          replyText,
          httpStatus,
          executedToolNames: executedTools,
          conversationId: activeConversationId,
          conversationStatus,
          modelCalled,
          patientPhone,
          supabase,
          systemPromptText,
        });

        if (!check.pass) {
          turnPassed = false;
          turnFailureReason = check.reason;
        }
      }

      turnResults.push({
        turnIndex: t,
        userPrompt,
        replyText,
        httpStatus,
        conversationId: activeConversationId,
        latencyMs: turnLatencyMs,
        inputTokens,
        outputTokens,
        persistedToolCalls,
        modelCalled,
        checksPassed: turnPassed,
        failureReason: turnFailureReason,
      });

      // Inter-turn delay: only when the model was called and more turns remain
      if (modelCalled && t < scenario.turns.length - 1 && minDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, minDelayMs));
      }
    }

    // 3. Final scenario-level expectation check
    const lastTurn = turnResults[turnResults.length - 1];
    let finalFailedExpectation: string | undefined;

    // Check if any turn-level expect failed
    const failedTurn = turnResults.find((tr) => !tr.checksPassed);
    if (failedTurn) {
      finalFailedExpectation = `Turn ${failedTurn.turnIndex + 1} check failed: ${failedTurn.failureReason}`;
    }

    if (!finalFailedExpectation && scenario.expect) {
      // Gather all executed tools across turns
      const allExecutedTools = turnResults.flatMap((tr) =>
        tr.persistedToolCalls.map((tc: any) => tc.toolName)
      );

      let finalConvStatus = "active";
      if (activeConversationId) {
        const { data: conv } = await supabase
          .from("conversations")
          .select("status")
          .eq("id", activeConversationId)
          .single();
        if (conv) finalConvStatus = conv.status;
      }

      const finalCheck = await evaluateExpectations(scenario.expect, {
        replyText: lastTurn.replyText,
        httpStatus: lastTurn.httpStatus,
        executedToolNames: allExecutedTools,
        conversationId: activeConversationId,
        conversationStatus: finalConvStatus,
        modelCalled: turnResults.some((tr) => tr.modelCalled),
        patientPhone,
        supabase,
        systemPromptText,
      });

      if (!finalCheck.pass) {
        finalFailedExpectation = finalCheck.reason;
      }
    }

    return {
      scenarioId: scenario.id,
      category: scenario.category,
      description: scenario.description,
      status: finalFailedExpectation ? "FAILED" : "PASSED",
      runIndex,
      turns: turnResults,
      failedExpectation: finalFailedExpectation,
      failedReplyText: lastTurn ? lastTurn.replyText.slice(0, 300) : undefined,
      totalLatencyMs,
      totalTokens,
    };
  } finally {
    // 4. Strict cleanup in finally: delete strictly tracked rows
    try {
      if (createdAppointmentIds.size > 0) {
        await supabase
          .from("appointments")
          .delete()
          .in("id", Array.from(createdAppointmentIds));
      }
      if (createdConversationIds.size > 0) {
        const convIds = Array.from(createdConversationIds);
        await supabase.from("messages").delete().in("conversation_id", convIds);
        await supabase.from("conversations").delete().in("id", convIds);
      }
      if (createdPatientIds.size > 0) {
        await supabase
          .from("patients")
          .delete()
          .in("id", Array.from(createdPatientIds));
      }
    } catch (cleanupErr: any) {
      console.error(
        `[Cleanup Error for scenario ${scenario.id}]:`,
        cleanupErr?.message
      );
    }
  }
}

