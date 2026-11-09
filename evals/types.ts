/**
 * evals/types.ts
 *
 * Zod schemas and TypeScript types for the ClinicDesk evaluation suite.
 * Strict schemas ensure unknown fields or typos in scenario JSON fail at load time.
 */

import { z } from "zod";

/**
 * Strict, named database checks. Unknown names fail when the scenario files load,
 * so a typo can never silently check nothing.
 *  - appointment_count: BOOKED appointments for the scenario's reserved test phone
 *  - total_appointment_count: appointments in any status for that phone
 *  - patient_exists: whether a patient row exists for that phone
 *  - seeded_appointment_status: status of the appointment this scenario seeded in setup
 */
export const DbExpectSchema = z
  .object({
    appointment_count: z.number().int().min(0).optional(),
    total_appointment_count: z.number().int().min(0).optional(),
    patient_exists: z.boolean().optional(),
    seeded_appointment_status: z.enum(["booked", "cancelled", "completed"]).optional(),
  })
  .strict();

export type DbExpect = z.infer<typeof DbExpectSchema>;

export const ExpectSchema = z
  .object({
    tools_called: z.array(z.string()).optional(),
    tools_not_called: z.array(z.string()).optional(),
    tools_called_in_order: z.array(z.string()).optional(),
    reply_contains_any: z.array(z.array(z.string())).optional(),
    reply_not_contains: z.array(z.string()).optional(),
    reply_matches: z.array(z.string()).optional(),
    reply_no_markdown: z.boolean().optional(),
    no_prompt_leak: z.boolean().optional(),
    max_sentences: z.number().int().positive().optional(),
    conversation_status: z.enum(["active", "handed_off"]).optional(),
    db: DbExpectSchema.optional(),
    http_status: z.number().int().optional(),
    model_not_called: z.boolean().optional(),
  })
  .strict();

export type ScenarioExpect = z.infer<typeof ExpectSchema>;

export const TurnSchema = z
  .object({
    user: z.string().min(1, "Turn user message must not be empty"),
    expect: ExpectSchema.optional(),
  })
  .strict();

export type ScenarioTurn = z.infer<typeof TurnSchema>;

export const SetupSchema = z
  .object({
    seed_appointment: z.boolean().optional(),
    doctor: z.enum(["doctor_a", "doctor_b"]).optional(),
    days_from_now: z.number().int().optional(),
    slot_time: z.string().optional(), // "HH:MM", e.g. "10:00"
    clinic: z.enum(["clinic_a", "clinic_b"]).optional(),
  })
  .strict();

export type ScenarioSetup = z.infer<typeof SetupSchema>;

export const ScenarioSchema = z
  .object({
    id: z.string().min(1, "Scenario id must not be empty"),
    category: z.string().min(1, "Category must not be empty"),
    description: z.string().min(1, "Description must not be empty"),
    language: z.enum(["en", "hi", "hinglish"]),
    setup: SetupSchema.optional(),
    turns: z.array(TurnSchema).min(1, "Scenario must have at least one turn"),
    expect: ExpectSchema.optional(),
  })
  .strict();

export type Scenario = z.infer<typeof ScenarioSchema>;

export const ScenarioFileSchema = z
  .object({
    category: z.string().min(1, "Category must not be empty"),
    scenarios: z.array(ScenarioSchema).min(1, "Scenario file must contain scenarios"),
  })
  .strict();

export type ScenarioFile = z.infer<typeof ScenarioFileSchema>;

export interface TurnExecutionResult {
  turnIndex: number;
  userPrompt: string;
  replyText: string;
  httpStatus: number;
  conversationId?: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  modelId?: string;
  persistedToolCalls: any[];
  modelCalled: boolean;
  checksPassed: boolean;
  failureReason?: string;
}

export type ScenarioStatus = "PASSED" | "FAILED" | "INFRA_ERROR";

export interface ScenarioRunResult {
  scenarioId: string;
  category: string;
  description: string;
  status: ScenarioStatus;
  runIndex: number; // For repeat runs
  turns: TurnExecutionResult[];
  failedExpectation?: string;
  failedReplyText?: string;
  totalLatencyMs: number;
  totalTokens: number;
  error?: string;
}

export interface ScenarioSummary {
  scenarioId: string;
  category: string;
  allRunsPassed: boolean;
  runs: ScenarioRunResult[];
  isFlaky: boolean;
  status: ScenarioStatus;
  failedExpectation?: string;
  failedReplyText?: string;
}

export interface CategorySummary {
  category: string;
  total: number;
  passed: number;
  failed: number;
  infraErrors: number;
  flaky: number;
  avgLatencyMs: number;
  avgTokens: number;
}

export interface EvalRunReport {
  timestamp: string;
  gitSha: string;
  modelId: string;
  systemPromptHash: string;
  scenarioFilesHash: string;
  totalScenarios: number;
  evaluatedScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  infraErrorScenarios: number;
  flakyScenarios: number;
  passRate: number; // 0 to 1
  categorySummaries: CategorySummary[];
  scenarioSummaries: ScenarioSummary[];
}

export interface LatestSummaryJSON {
  timestamp: string;
  git_sha: string;
  model_id: string;
  system_prompt_hash: string;
  scenario_files_hash: string;
  total: number;
  evaluated: number;
  passed: number;
  failed: number;
  infra_errors: number;
  flaky: number;
  pass_rate: number;
  categories: Array<{
    category: string;
    total: number;
    passed: number;
    infra_errors: number;
    pass_rate: number;
  }>;
}
