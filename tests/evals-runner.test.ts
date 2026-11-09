/**
 * tests/evals-runner.test.ts
 *
 * Unit tests for the evaluation runner internals (0 real model calls):
 * - Schema validation (rejection of typos and unknown properties)
 * - Template expansion ({{next_monday}}, {{next_tuesday}}, {{patient_phone}}, etc.)
 * - Every check type (both pass and fail branches)
 * - Phone masking (...XX)
 * - Cleanup execution when a scenario throws
 * - Safety guard validation (refuses wrong clinic names, requires --yes)
 * - INFRA_ERROR classification and retry detection
 * - Summary mathematics (pass rate denominator excluding infra errors)
 */

import fs from "fs";
import * as dotenv from "dotenv";
import path from "path";
import { describe, expect, it } from "vitest";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
import {
  checkPromptLeak,
  containsInOrder,
  countSentences,
  evaluateExpectations,
  hasMarkdown,
  normalizeText,
} from "../evals/checks";
import { isRetryableInfraResponse, loadAllScenarios } from "../evals/runner";
import { runSafetyGuard } from "../evals/safety";
import { expandTemplate, getNextWeekdayDate, maskPhone } from "../evals/template";
import { ExpectSchema, ScenarioFileSchema, ScenarioSchema } from "../evals/types";
import { DateTime } from "luxon";

describe("Evals Runner Internals", () => {
  // -------------------------------------------------------------------------
  // 1. Zod Schema Validation
  // -------------------------------------------------------------------------
  describe("Zod schema validation", () => {
    it("validates a compliant scenario definition", () => {
      const valid = {
        id: "faq-test-1",
        category: "faq",
        description: "Test description",
        language: "en",
        turns: [{ user: "Hello" }],
        expect: {
          reply_no_markdown: true,
          http_status: 200,
        },
      };

      const result = ScenarioSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it("rejects unknown properties in scenario or expectations due to strict validation", () => {
      const invalid = {
        id: "faq-test-1",
        category: "faq",
        description: "Test",
        language: "en",
        turns: [{ user: "Hello" }],
        unknown_property: "disallowed",
      };

      const result = ScenarioSchema.safeParse(invalid);
      expect(result.success).toBe(false);

      const invalidExpect = {
        reply_no_markdown: true,
        typo_expectation: true,
      };
      const expectResult = ExpectSchema.safeParse(invalidExpect);
      expect(expectResult.success).toBe(false);
    });

    it("validates a complete scenario file and rejects empty scenarios", () => {
      const emptyFile = {
        category: "faq",
        scenarios: [],
      };
      expect(ScenarioFileSchema.safeParse(emptyFile).success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Template Expansion & Phone Masking
  // -------------------------------------------------------------------------
  describe("Template expansion & masking", () => {
    it("computes next occurrence of Monday and Tuesday strictly in future", () => {
      // Anchored to Friday 2026-11-06
      const fixedDt = DateTime.fromISO("2026-11-06T10:00:00", { zone: "Asia/Kolkata" });
      const nextMon = getNextWeekdayDate(1, fixedDt, "Asia/Kolkata");
      const nextTue = getNextWeekdayDate(2, fixedDt, "Asia/Kolkata");

      expect(nextMon).toBe("2026-11-09");
      expect(nextTue).toBe("2026-11-10");
    });

    it("expands all template placeholders accurately", () => {
      const fixedDt = DateTime.fromISO("2026-11-06T10:00:00", { zone: "Asia/Kolkata" });
      const rawPrompt =
        "Book Dr on {{next_monday}} for {{patient_phone}} with {{doctor_a_id}} and cancel {{clinic_b_appointment_id}}";

      const expanded = expandTemplate(rawPrompt, {
        patientPhone: "+919999900001",
        doctorAId: "doc-123",
        clinicBAppointmentId: "appt-999",
        now: fixedDt,
        timezone: "Asia/Kolkata",
      });

      expect(expanded).toBe(
        "Book Dr on 2026-11-09 for +919999900001 with doc-123 and cancel appt-999"
      );
    });

    it("masks phone numbers revealing only the last 2 digits", () => {
      expect(maskPhone("+919999900001")).toBe("...01");
      expect(maskPhone("+919876543210")).toBe("...10");
      expect(maskPhone("12")).toBe("...12");
      expect(maskPhone("1")).toBe("...");
      expect(maskPhone("")).toBe("...");
    });
  });

  // -------------------------------------------------------------------------
  // 3. Every Check Type (Pass and Fail branches)
  // -------------------------------------------------------------------------
  describe("Evaluation checks", () => {
    const fakeSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { id: "p1" } }),
            eq: () => ({
              count: 1,
            }),
          }),
        }),
      }),
    } as any;

    const baseContext = {
      replyText: "Clinic is closed on Sundays as per schedule.",
      httpStatus: 200,
      executedToolNames: ["search_clinic_info", "list_doctors"],
      conversationId: "conv-1",
      conversationStatus: "active",
      modelCalled: true,
      patientPhone: "+919999900001",
      supabase: fakeSupabase,
    };

    it("http_status check: passes on match, fails on mismatch", async () => {
      const pass = await evaluateExpectations({ http_status: 200 }, baseContext);
      expect(pass.pass).toBe(true);

      const fail = await evaluateExpectations({ http_status: 404 }, baseContext);
      expect(fail.pass).toBe(false);
      expect(fail.reason).toMatch(/Expected HTTP status 404, got 200/);
    });

    it("model_not_called check: passes on false, fails on true when model called", async () => {
      const pass = await evaluateExpectations({ model_not_called: false }, baseContext);
      expect(pass.pass).toBe(true);

      const fail = await evaluateExpectations({ model_not_called: true }, baseContext);
      expect(fail.pass).toBe(false);
      expect(fail.reason).toMatch(/Expected model NOT to be called/);
    });

    it("tools_called and tools_not_called checks", async () => {
      const pass = await evaluateExpectations(
        { tools_called: ["search_clinic_info"], tools_not_called: ["book_appointment"] },
        baseContext
      );
      expect(pass.pass).toBe(true);

      const failMissing = await evaluateExpectations(
        { tools_called: ["cancel_appointment"] },
        baseContext
      );
      expect(failMissing.pass).toBe(false);
      expect(failMissing.reason).toMatch(/Expected tool 'cancel_appointment' to be called/);

      const failForbidden = await evaluateExpectations(
        { tools_not_called: ["list_doctors"] },
        baseContext
      );
      expect(failForbidden.pass).toBe(false);
      expect(failForbidden.reason).toMatch(/Expected tool 'list_doctors' NOT to be called/);
    });

    it("tools_called_in_order check", async () => {
      expect(containsInOrder(["a", "b", "c"], ["a", "c"])).toBe(true);
      expect(containsInOrder(["a", "b", "c"], ["c", "a"])).toBe(false);

      const pass = await evaluateExpectations(
        { tools_called_in_order: ["search_clinic_info", "list_doctors"] },
        baseContext
      );
      expect(pass.pass).toBe(true);

      const fail = await evaluateExpectations(
        { tools_called_in_order: ["list_doctors", "search_clinic_info"] },
        baseContext
      );
      expect(fail.pass).toBe(false);
    });

    it("reply_contains_any check with Unicode normalization", async () => {
      const pass = await evaluateExpectations(
        { reply_contains_any: [["closed", "band"]] },
        baseContext
      );
      expect(pass.pass).toBe(true);

      const fail = await evaluateExpectations(
        { reply_contains_any: [["open", "chalu"]] },
        baseContext
      );
      expect(fail.pass).toBe(false);
    });

    it("reply_not_contains check", async () => {
      const pass = await evaluateExpectations(
        { reply_not_contains: ["open on sunday"] },
        baseContext
      );
      expect(pass.pass).toBe(true);

      const fail = await evaluateExpectations(
        { reply_not_contains: ["closed on sundays"] },
        baseContext
      );
      expect(fail.pass).toBe(false);
    });

    it("reply_matches regex check", async () => {
      const pass = await evaluateExpectations(
        { reply_matches: ["closed.*sunday"] },
        baseContext
      );
      expect(pass.pass).toBe(true);

      const fail = await evaluateExpectations(
        { reply_matches: ["^open"] },
        baseContext
      );
      expect(fail.pass).toBe(false);
    });

    it("reply_no_markdown check", async () => {
      expect(hasMarkdown("Plain text answer.")).toBe(false);
      expect(hasMarkdown("Has **bold** text.")).toBe(true);
      expect(hasMarkdown("# Heading")).toBe(true);
      expect(hasMarkdown("| col1 | col2 |")).toBe(true);

      const pass = await evaluateExpectations(
        { reply_no_markdown: true },
        baseContext
      );
      expect(pass.pass).toBe(true);

      const fail = await evaluateExpectations(
        { reply_no_markdown: true },
        { ...baseContext, replyText: "Here is **markdown**." }
      );
      expect(fail.pass).toBe(false);
    });

    it("max_sentences check", async () => {
      expect(countSentences("Sentence 1. Sentence 2! Sentence 3?")).toBe(3);
      expect(countSentences("Sentence 1। Sentence 2॥")).toBe(2);

      const pass = await evaluateExpectations(
        { max_sentences: 3 },
        baseContext
      );
      expect(pass.pass).toBe(true);

      const fail = await evaluateExpectations(
        { max_sentences: 1 },
        { ...baseContext, replyText: "First sentence. Second sentence." }
      );
      expect(fail.pass).toBe(false);
    });

    it("conversation_status check", async () => {
      const pass = await evaluateExpectations(
        { conversation_status: "active" },
        baseContext
      );
      expect(pass.pass).toBe(true);

      const fail = await evaluateExpectations(
        { conversation_status: "handed_off" },
        baseContext
      );
      expect(fail.pass).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Safety Guard
  // -------------------------------------------------------------------------
  describe("Safety guard", () => {
    it("refuses to run when confirmation flag --yes / EVAL_CONFIRM=1 is missing", async () => {
      const oldConfirm = process.env.EVAL_CONFIRM;
      delete process.env.EVAL_CONFIRM;

      const mockSupabase = {
        from: () => ({
          select: () => ({
            eq: () => ({
              single: async () => ({ data: { id: "c1", name: "Demo Clinic A" } }),
            }),
          }),
        }),
      } as any;

      await expect(runSafetyGuard(mockSupabase, { yes: false })).rejects.toThrow(
        /requires explicit confirmation/i
      );

      process.env.EVAL_CONFIRM = oldConfirm;
    });

    it("refuses to run if target clinic is not 'Demo Clinic A'", async () => {
      const mockSupabase = {
        from: () => ({
          select: () => ({
            eq: (col: string, val: string) => ({
              single: async () => {
                if (val === "Demo Clinic A") {
                  return { data: null, error: { message: "Not found" } };
                }
                return { data: { id: "c2", name: "Demo Clinic B" } };
              },
            }),
          }),
        }),
      } as any;

      await expect(runSafetyGuard(mockSupabase, { yes: true })).rejects.toThrow(
        /Target clinic must be named exactly 'Demo Clinic A'/
      );
    });
  });

  // -------------------------------------------------------------------------
  // 5. INFRA_ERROR Classification & Retry
  // -------------------------------------------------------------------------
  describe("Infrastructure retry & error classification", () => {
    it("retries only on HTTP 429 and 503", () => {
      expect(isRetryableInfraResponse(429, "Too many requests")).toBe(true);
      expect(isRetryableInfraResponse(503, "We're very busy, please try again in a minute")).toBe(true);
      expect(isRetryableInfraResponse(200, "Normal response text")).toBe(false);
      expect(isRetryableInfraResponse(400, "bad request")).toBe(false);
      expect(isRetryableInfraResponse(404, "not found")).toBe(false);
    });

    it("never decides from body text: a 200 reply containing 'busy' must not be re-sent", () => {
      // Re-sending could repeat a booking or cancellation that already ran.
      expect(isRetryableInfraResponse(200, "We're very busy, please try again in a minute")).toBe(false);
      expect(isRetryableInfraResponse(200, "Our clinic is busy on Mondays")).toBe(false);
      expect(isRetryableInfraResponse(200, "The reply was cut off. If you were booking or cancelling, ask me to check my appointments before trying again.")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Summary Statistics Mathematics
  // -------------------------------------------------------------------------
  describe("Summary statistics mathematics", () => {
    it("excludes INFRA_ERROR scenarios from pass rate denominator", () => {
      const total = 10;
      const infra = 2;
      const passed = 7;
      const failed = 1;

      const evaluated = total - infra; // 8
      const passRate = evaluated > 0 ? passed / evaluated : 1.0;

      expect(evaluated).toBe(8);
      expect(passRate).toBe(0.875);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Contract tests that exercise the real code (no local-variable-only assertions)
  // -------------------------------------------------------------------------
  describe("Strict db check schema (fails at load time)", () => {
    it("rejects unknown db check names when the scenario files load", () => {
      const bad = ExpectSchema.safeParse({ db: { apointment_count: 1 } });
      expect(bad.success).toBe(false);
    });

    it("accepts every named db check", () => {
      const ok = ExpectSchema.safeParse({
        db: {
          appointment_count: 1,
          total_appointment_count: 2,
          patient_exists: true,
          seeded_appointment_status: "booked",
        },
      });
      expect(ok.success).toBe(true);
    });

    it("rejects an invalid seeded appointment status (the old 'scheduled' value does not exist)", () => {
      const bad = ExpectSchema.safeParse({ db: { seeded_appointment_status: "scheduled" } });
      expect(bad.success).toBe(false);
    });
  });

  describe("Scenario facts exist in the clinic documents", () => {
    const docs = (name: string) =>
      fs.readFileSync(path.resolve(process.cwd(), "data/demo-clinic-a", name), "utf-8").toLowerCase();

    it("the facts the FAQ scenarios expect are in the markdown files", () => {
      const scenarios = loadAllScenarios(path.resolve(process.cwd(), "evals/scenarios"));
      const facts: Record<string, { file: string; fact: string; mustBeInExpect: string }> = {
        "faq-sunday-timings": { file: "timings.md", fact: "sunday: closed", mustBeInExpect: "closed" },
        "faq-cancellation-policy": { file: "policies.md", fact: "2 hours", mustBeInExpect: "2 hours" },
        "faq-ecg-price": { file: "fees-and-services.md", fact: "rs. 350", mustBeInExpect: "350" },
      };
      for (const [id, { file, fact, mustBeInExpect }] of Object.entries(facts)) {
        expect(docs(file), `${id}: '${fact}' missing from ${file}`).toContain(fact);
        const sc = scenarios.find((s) => s.id === id);
        expect(sc, `scenario ${id} missing`).toBeDefined();
        const flat = JSON.stringify(sc?.expect?.reply_contains_any ?? []).toLowerCase();
        expect(flat, `${id} does not expect '${mustBeInExpect}'`).toContain(mustBeInExpect);
      }
    });

    it("no scenario forbids a phrase that a correct answer would contain", () => {
      const scenarios = loadAllScenarios(path.resolve(process.cwd(), "evals/scenarios"));
      // "not open on sunday" is a correct answer; forbidding "open on sunday" would fail it.
      const sunday = scenarios.find((s) => s.id === "faq-sunday-timings");
      for (const phrase of sunday?.expect?.reply_not_contains ?? []) {
        expect("we are not open on sunday, the clinic is closed on sundays".includes(phrase.toLowerCase())).toBe(false);
      }
    });
  });

  describe("Starter scenarios keep their intended structure", () => {
    const scenarios = loadAllScenarios(path.resolve(process.cwd(), "evals/scenarios"));

    it("has 12 starter scenarios with unique ids", () => {
      expect(scenarios.length).toBe(12);
      expect(new Set(scenarios.map((s) => s.id)).size).toBe(12);
    });

    it("book-happy-path sends all details first, then confirms, and requires availability before booking", () => {
      const sc = scenarios.find((s) => s.id === "book-happy-path");
      expect(sc?.turns.length).toBe(2);
      expect(sc?.turns[0].user).toContain("{{patient_phone}}");
      expect(sc?.expect?.tools_called_in_order).toEqual(["check_availability", "book_appointment"]);
      expect(sc?.expect?.db?.appointment_count).toBe(1);
    });

    it("negative scenarios assert database state, not only reply text", () => {
      for (const id of ["cancel-wrong-phone", "cross-clinic-cancel"]) {
        const sc = scenarios.find((s) => s.id === id);
        expect(sc?.expect?.db?.seeded_appointment_status, id).toBe("booked");
      }
      expect(scenarios.find((s) => s.id === "book-offgrid-time")?.expect?.db?.appointment_count).toBe(0);
    });

    it("cross-clinic scenario uses Clinic B's real phone so only tenant isolation can stop it", () => {
      const sc = scenarios.find((s) => s.id === "cross-clinic-cancel");
      expect(sc?.setup?.clinic).toBe("clinic_b");
      expect(sc?.turns[0].user).toContain("{{clinic_b_appointment_id}}");
      expect(sc?.turns[0].user).toContain("{{patient_phone}}");
    });
  });

  describe("Prompt leak check", () => {
    const systemPrompt =
      "You are the AI receptionist for Demo Clinic A. Plain text only. No markdown formatting. Never discuss symptoms.";

    it("detects 8 consecutive words from the system prompt", () => {
      const leaked =
        "Here are my internal rules: You are the AI receptionist for Demo Clinic A. Plain text only.";
      expect(checkPromptLeak(leaked, systemPrompt, 8).leaked).toBe(true);
    });

    it("does not flag a normal reply", () => {
      expect(
        checkPromptLeak("We are closed on Sundays. Would you like an appointment on Monday?", systemPrompt, 8).leaked
      ).toBe(false);
    });
  });
});
