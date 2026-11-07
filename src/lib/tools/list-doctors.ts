import { z } from "zod";
import { getAdminClient } from "../supabase/admin";
import { ToolResult } from "./types";

export const listDoctorsInputSchema = z
  .object({
    speciality: z.string().trim().min(1).optional(),
  })
  .optional()
  .default({});

export type ListDoctorsInput = z.infer<typeof listDoctorsInputSchema>;

export interface DoctorSummary {
  id: string;
  name: string;
  speciality: string | null;
  fee: number;
}

/**
 * Returns active doctors for the given clinicId, optionally filtered by speciality.
 */
export async function listDoctors(
  clinicId: string,
  input?: unknown
): Promise<ToolResult<DoctorSummary[]>> {
  if (!clinicId || typeof clinicId !== "string") {
    return {
      ok: false,
      error: "INVALID_INPUT",
      message: "A valid clinicId string is required",
    };
  }

  const parsed = listDoctorsInputSchema.safeParse(input ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: "INVALID_INPUT",
      message: parsed.error.issues.map((i) => i.message).join(", "),
    };
  }

  try {
    const supabase = getAdminClient();
    let query = supabase
      .from("doctors")
      .select("id, name, speciality, fee")
      .eq("clinic_id", clinicId)
      .eq("active", true)
      .order("name", { ascending: true });

    if (parsed.data.speciality) {
      query = query.ilike("speciality", parsed.data.speciality);
    }

    const { data, error } = await query;

    if (error) {
      console.error("[list_doctors] database error:", error.message);
      return {
        ok: false,
        error: "INTERNAL_ERROR",
        message: "Failed to retrieve doctors list",
      };
    }

    const doctors: DoctorSummary[] = (data || []).map((doc) => ({
      id: doc.id,
      name: doc.name,
      speciality: doc.speciality,
      fee: Number(doc.fee),
    }));

    return {
      ok: true,
      data: doctors,
    };
  } catch (err) {
    console.error("[list_doctors] unexpected error:", err);
    return {
      ok: false,
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred while listing doctors",
    };
  }
}

