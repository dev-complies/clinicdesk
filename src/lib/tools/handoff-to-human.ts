import { z } from "zod";
import { getAdminClient } from "../supabase/admin";
import { ToolResult } from "./types";

export const handoffToHumanInputSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, { message: "Reason must be at least 1 character" })
    .max(200, { message: "Reason must not exceed 200 characters" }),
});

export type HandoffToHumanInput = z.infer<typeof handoffToHumanInputSchema>;

export interface HandoffConfirmation {
  status: "handed_off";
  handoff_phone: string | null;
  message: string;
}

/**
 * Hands off an active or already handed-off conversation to human clinic staff.
 * Idempotent when called repeatedly on the same conversation.
 */
export async function handoffToHuman(
  clinicId: string,
  conversationId: string,
  input: unknown
): Promise<ToolResult<HandoffConfirmation>> {
  if (!clinicId || typeof clinicId !== "string") {
    return {
      ok: false,
      error: "INVALID_INPUT",
      message: "A valid clinicId string is required",
    };
  }

  if (!conversationId || typeof conversationId !== "string") {
    return {
      ok: false,
      error: "INVALID_INPUT",
      message: "A valid conversationId string is required",
    };
  }

  const parsed = handoffToHumanInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "INVALID_INPUT",
      message: parsed.error.issues.map((i) => i.message).join(", "),
    };
  }

  try {
    const supabase = getAdminClient();

    // 1. Verify conversation belongs to clinicId
    const { data: conv, error: convErr } = await supabase
      .from("conversations")
      .select("id, status")
      .eq("id", conversationId)
      .eq("clinic_id", clinicId)
      .maybeSingle();

    if (convErr) {
      console.error("[handoff_to_human] conversation query error:", convErr.message);
      return { ok: false, error: "INTERNAL_ERROR", message: "Failed to verify conversation" };
    }

    // A missing conversation or a 'closed' conversation returns CONVERSATION_NOT_FOUND
    if (!conv || conv.status === "closed") {
      return {
        ok: false,
        error: "CONVERSATION_NOT_FOUND",
        message: "Conversation not found or is closed",
      };
    }

    // 2. Fetch clinic handoff phone
    const { data: clinic, error: clinicErr } = await supabase
      .from("clinics")
      .select("handoff_phone")
      .eq("id", clinicId)
      .maybeSingle();

    if (clinicErr) {
      console.error("[handoff_to_human] clinic error:", clinicErr.message);
      return { ok: false, error: "INTERNAL_ERROR", message: "Failed to load clinic details" };
    }

    const handoffPhone = clinic?.handoff_phone ?? null;

    // 3. If currently 'active', update status to 'handed_off' (idempotent if already 'handed_off')
    if (conv.status === "active") {
      const { error: updateErr } = await supabase
        .from("conversations")
        .update({ status: "handed_off" })
        .eq("id", conversationId)
        .eq("clinic_id", clinicId);

      if (updateErr) {
        console.error("[handoff_to_human] update error:", updateErr.message);
        return { ok: false, error: "INTERNAL_ERROR", message: "Failed to update conversation status" };
      }
    }

    const message = handoffPhone
      ? `I have handed you off to clinic staff. You can also contact us directly at ${handoffPhone}.`
      : "I have handed you off to clinic staff. Someone will contact you shortly.";

    return {
      ok: true,
      data: {
        status: "handed_off",
        handoff_phone: handoffPhone,
        message,
      },
    };
  } catch (err) {
    console.error("[handoff_to_human] unexpected error:", err);
    return {
      ok: false,
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred during handoff",
    };
  }
}

