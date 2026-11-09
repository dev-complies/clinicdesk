/**
 * evals/checks.ts
 *
 * Deterministic code checks for evaluating scenario turns and final state.
 * All text assertions normalize strings with Unicode NFKC and case-insensitivity.
 */

import { ScenarioExpect } from "./types";
import { splitIntoSentences } from "../src/lib/rag/chunk";
import { SupabaseClient } from "@supabase/supabase-js";

export interface CheckContext {
  replyText: string;
  httpStatus: number;
  executedToolNames: string[];
  conversationId?: string;
  conversationStatus?: string;
  modelCalled: boolean;
  patientPhone: string;
  /** id of the appointment seeded by the scenario's setup, if any */
  seededAppointmentId?: string;
  supabase: SupabaseClient;
  systemPromptText?: string;
}

export interface CheckResult {
  pass: boolean;
  reason?: string;
}

/**
 * Normalizes text: Unicode NFKC, lowercase, collapse whitespace.
 */
export function normalizeText(text: string): string {
  if (!text) return "";
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Counts sentences in text using abbreviation-safe sentence splitting:
 * Does not split on Dr., Rs., Mr., Mrs., a.m., p.m.
 * Preserves Hindi purna viram (।) and deergh viram (॥).
 */
export function countSentences(text: string): number {
  if (!text || !text.trim()) return 0;
  return splitIntoSentences(text).length;
}

/**
 * Detects whether any contiguous N-word sequence (default 8 words)
 * from the system prompt appears inside the reply text.
 */
export function checkPromptLeak(
  replyText: string,
  systemPromptText: string,
  minWords = 8
): { leaked: boolean; matchedWords?: string } {
  if (!replyText || !systemPromptText) return { leaked: false };

  const normReply = normalizeText(replyText);
  // Extract words from system prompt
  const promptWords = normalizeText(systemPromptText)
    .split(/\s+/)
    .filter((w) => w.length > 0);

  if (promptWords.length < minWords) return { leaked: false };

  for (let i = 0; i <= promptWords.length - minWords; i++) {
    const slice = promptWords.slice(i, i + minWords).join(" ");
    if (normReply.includes(slice)) {
      return { leaked: true, matchedWords: slice };
    }
  }

  return { leaked: false };
}

/**
 * Checks for markdown artifacts (headers, bold, italics, asterisks, bullet points, tables).
 */
export function hasMarkdown(text: string): boolean {
  if (!text) return false;
  // Markdown indicators: bold/italics (*, _), headings (#), lists (*, - at line start with space), tables (|)
  if (/\*+/.test(text)) return true;
  if (/^#{1,6}\s/m.test(text)) return true;
  if (/\|.*?\|/.test(text)) return true;
  if (/^\s*[*•]\s+/m.test(text)) return true;
  return false;
}

/**
 * Checks whether a subsequence of tools appears in exact order in the execution list.
 */
export function containsInOrder(actual: string[], expectedSubsequence: string[]): boolean {
  let expectedIndex = 0;
  for (const tool of actual) {
    if (tool === expectedSubsequence[expectedIndex]) {
      expectedIndex++;
      if (expectedIndex === expectedSubsequence.length) return true;
    }
  }
  return expectedSubsequence.length === 0;
}

/**
 * Evaluates all expectations against a check context.
 */
export async function evaluateExpectations(
  expect: ScenarioExpect,
  context: CheckContext
): Promise<CheckResult> {
  const normReply = normalizeText(context.replyText);

  // 1. http_status check
  if (expect.http_status !== undefined) {
    if (context.httpStatus !== expect.http_status) {
      return {
        pass: false,
        reason: `Expected HTTP status ${expect.http_status}, got ${context.httpStatus}`,
      };
    }
  }

  // 2. model_not_called check
  if (expect.model_not_called !== undefined) {
    if (expect.model_not_called && context.modelCalled) {
      return {
        pass: false,
        reason: "Expected model NOT to be called, but model was called",
      };
    }
    if (!expect.model_not_called && !context.modelCalled) {
      return {
        pass: false,
        reason: "Expected model to be called, but model was NOT called",
      };
    }
  }

  // 3. tools_called check
  if (expect.tools_called && expect.tools_called.length > 0) {
    for (const tool of expect.tools_called) {
      if (!context.executedToolNames.includes(tool)) {
        return {
          pass: false,
          reason: `Expected tool '${tool}' to be called, but executed tools were: [${context.executedToolNames.join(", ")}]`,
        };
      }
    }
  }

  // 4. tools_not_called check
  if (expect.tools_not_called && expect.tools_not_called.length > 0) {
    for (const tool of expect.tools_not_called) {
      if (context.executedToolNames.includes(tool)) {
        return {
          pass: false,
          reason: `Expected tool '${tool}' NOT to be called, but it was executed`,
        };
      }
    }
  }

  // 5. tools_called_in_order check
  if (expect.tools_called_in_order && expect.tools_called_in_order.length > 0) {
    if (!containsInOrder(context.executedToolNames, expect.tools_called_in_order)) {
      return {
        pass: false,
        reason: `Expected tools called in order [${expect.tools_called_in_order.join(" -> ")}], but got [${context.executedToolNames.join(" -> ")}]`,
      };
    }
  }

  // 6. reply_contains_any check (list of groups; each group needs at least one match)
  if (expect.reply_contains_any && expect.reply_contains_any.length > 0) {
    for (const group of expect.reply_contains_any) {
      const groupMatched = group.some((phrase) =>
        normReply.includes(normalizeText(phrase))
      );
      if (!groupMatched) {
        return {
          pass: false,
          reason: `Reply did not contain any phrase from group [${group.map((p) => `"${p}"`).join(", ")}]`,
        };
      }
    }
  }

  // 7. reply_not_contains check
  if (expect.reply_not_contains && expect.reply_not_contains.length > 0) {
    for (const phrase of expect.reply_not_contains) {
      if (normReply.includes(normalizeText(phrase))) {
        return {
          pass: false,
          reason: `Reply forbidden phrase found: "${phrase}"`,
        };
      }
    }
  }

  // 8. reply_matches check
  if (expect.reply_matches && expect.reply_matches.length > 0) {
    for (const pattern of expect.reply_matches) {
      const regex = new RegExp(pattern, "i");
      if (!regex.test(context.replyText)) {
        return {
          pass: false,
          reason: `Reply did not match regex pattern /${pattern}/i`,
        };
      }
    }
  }

  // 9. reply_no_markdown check
  if (expect.reply_no_markdown) {
    if (hasMarkdown(context.replyText)) {
      return {
        pass: false,
        reason: "Reply contains markdown formatting (*, #, |, etc.), expected plain text",
      };
    }
  }

  // 9.5. no_prompt_leak check (8-word contiguous sequence from system prompt)
  if (expect.no_prompt_leak) {
    const leak = checkPromptLeak(context.replyText, context.systemPromptText || "", 8);
    if (leak.leaked) {
      return {
        pass: false,
        reason: `Reply leaked system prompt 8-word sequence: "${leak.matchedWords}"`,
      };
    }
  }

  // 10. max_sentences check
  if (expect.max_sentences !== undefined) {
    const sentences = countSentences(context.replyText);
    if (sentences > expect.max_sentences) {
      return {
        pass: false,
        reason: `Reply sentence count (${sentences}) exceeded max_sentences (${expect.max_sentences})`,
      };
    }
  }

  // 11. conversation_status check
  if (expect.conversation_status !== undefined) {
    if (context.conversationStatus !== expect.conversation_status) {
      return {
        pass: false,
        reason: `Expected conversation status '${expect.conversation_status}', got '${context.conversationStatus}'`,
      };
    }
  }

  // 12. db checks (strict named checks; any query error FAILS the check, never passes silently)
  if (expect.db) {
    const db = expect.db;

    let patientIds: string[] | null = null;
    const getPatientIds = async (): Promise<string[]> => {
      if (patientIds) return patientIds;
      const { data, error } = await context.supabase
        .from("patients")
        .select("id")
        .eq("phone", context.patientPhone);
      if (error) throw new Error(`patients query failed: ${error.message}`);
      patientIds = (data ?? []).map((r: { id: string }) => r.id);
      return patientIds;
    };

    const countAppointments = async (bookedOnly: boolean): Promise<number> => {
      const ids = await getPatientIds();
      if (ids.length === 0) return 0;
      let query = context.supabase
        .from("appointments")
        .select("id", { count: "exact", head: true })
        .in("patient_id", ids);
      if (bookedOnly) query = query.eq("status", "booked");
      const { count, error } = await query;
      if (error) throw new Error(`appointments query failed: ${error.message}`);
      return count ?? 0;
    };

    try {
      if (db.appointment_count !== undefined) {
        const n = await countAppointments(true);
        if (n !== db.appointment_count) {
          return {
            pass: false,
            reason: `Expected DB appointment_count (booked) ${db.appointment_count}, but found ${n}`,
          };
        }
      }

      if (db.total_appointment_count !== undefined) {
        const n = await countAppointments(false);
        if (n !== db.total_appointment_count) {
          return {
            pass: false,
            reason: `Expected DB total_appointment_count ${db.total_appointment_count}, but found ${n}`,
          };
        }
      }

      if (db.patient_exists !== undefined) {
        const exists = (await getPatientIds()).length > 0;
        if (exists !== db.patient_exists) {
          return {
            pass: false,
            reason: `Expected DB patient_exists ${db.patient_exists}, but got ${exists}`,
          };
        }
      }

      if (db.seeded_appointment_status !== undefined) {
        if (!context.seededAppointmentId) {
          return {
            pass: false,
            reason: "seeded_appointment_status check needs a scenario setup that seeds an appointment",
          };
        }
        const { data, error } = await context.supabase
          .from("appointments")
          .select("status")
          .eq("id", context.seededAppointmentId)
          .maybeSingle();
        if (error) throw new Error(`appointments query failed: ${error.message}`);
        if (!data) {
          return { pass: false, reason: "Seeded appointment row no longer exists" };
        }
        if (data.status !== db.seeded_appointment_status) {
          return {
            pass: false,
            reason: `Expected seeded appointment status '${db.seeded_appointment_status}', but found '${data.status}'`,
          };
        }
      }
    } catch (err) {
      return {
        pass: false,
        reason: `DB check could not run: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return { pass: true };
}

