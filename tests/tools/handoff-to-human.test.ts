import * as dotenv from "dotenv";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAdminClient } from "../../src/lib/supabase/admin";
import { handoffToHuman } from "../../src/lib/tools/handoff-to-human";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

describe("Tool: handoff_to_human", () => {
  let clinicAId: string;
  let clinicBId: string;

  let activeConvAId: string;
  let closedConvAId: string;
  let activeConvBId: string;

  const createdConvIds = new Set<string>();

  beforeAll(async () => {
    const supabase = getAdminClient();

    const { data: clinicA } = await supabase
      .from("clinics")
      .select("id")
      .eq("name", "Demo Clinic A")
      .single();
    clinicAId = clinicA!.id;

    const { data: clinicB } = await supabase
      .from("clinics")
      .select("id")
      .eq("name", "Demo Clinic B")
      .single();
    clinicBId = clinicB!.id;

    // Create test conversations
    const { data: c1 } = await supabase
      .from("conversations")
      .insert({
        clinic_id: clinicAId,
        language: "en",
        status: "active",
      })
      .select("id")
      .single();
    activeConvAId = c1!.id;
    createdConvIds.add(activeConvAId);

    const { data: c2 } = await supabase
      .from("conversations")
      .insert({
        clinic_id: clinicAId,
        language: "en",
        status: "closed",
      })
      .select("id")
      .single();
    closedConvAId = c2!.id;
    createdConvIds.add(closedConvAId);

    const { data: c3 } = await supabase
      .from("conversations")
      .insert({
        clinic_id: clinicBId,
        language: "en",
        status: "active",
      })
      .select("id")
      .single();
    activeConvBId = c3!.id;
    createdConvIds.add(activeConvBId);
  });

  afterAll(async () => {
    const supabase = getAdminClient();
    if (createdConvIds.size > 0) {
      await supabase
        .from("conversations")
        .delete()
        .in("id", Array.from(createdConvIds));
    }
  });

  it("sets conversation status to handed_off and returns handoff_phone and confirmation message", async () => {
    const res = await handoffToHuman(clinicAId, activeConvAId, {
      reason: "Patient requested to speak with a doctor",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.data.status).toBe("handed_off");
    expect(res.data.handoff_phone).toBe("+919000000001");
    expect(res.data.message).toContain("+919000000001");

    // Check DB status
    const supabase = getAdminClient();
    const { data: dbRow } = await supabase
      .from("conversations")
      .select("status")
      .eq("id", activeConvAId)
      .single();
    expect(dbRow?.status).toBe("handed_off");
  });

  it("is idempotent when called again on an already handed-off conversation", async () => {
    const res = await handoffToHuman(clinicAId, activeConvAId, {
      reason: "Patient repeated request",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.status).toBe("handed_off");
  });

  it("returns CONVERSATION_NOT_FOUND when conversation belongs to another clinic", async () => {
    const res = await handoffToHuman(clinicAId, activeConvBId, {
      reason: "Cross clinic attempt",
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("CONVERSATION_NOT_FOUND");

    // Verify conversation B is still active
    const supabase = getAdminClient();
    const { data: dbRow } = await supabase
      .from("conversations")
      .select("status")
      .eq("id", activeConvBId)
      .single();
    expect(dbRow?.status).toBe("active");
  });

  it("returns CONVERSATION_NOT_FOUND for a closed conversation", async () => {
    const res = await handoffToHuman(clinicAId, closedConvAId, {
      reason: "Closed conversation attempt",
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("CONVERSATION_NOT_FOUND");
  });

  it("returns INVALID_INPUT for empty reason or reason exceeding 200 characters", async () => {
    // Empty reason
    const resEmpty = await handoffToHuman(clinicAId, activeConvAId, {
      reason: "   ",
    });
    expect(resEmpty.ok).toBe(false);
    if (!resEmpty.ok) {
      expect(resEmpty.error).toBe("INVALID_INPUT");
    }

    // 201-char reason
    const resTooLong = await handoffToHuman(clinicAId, activeConvAId, {
      reason: "a".repeat(201),
    });
    expect(resTooLong.ok).toBe(false);
    if (!resTooLong.ok) {
      expect(resTooLong.error).toBe("INVALID_INPUT");
    }
  });
});

