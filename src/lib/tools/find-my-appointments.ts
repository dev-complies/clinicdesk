import { DateTime } from "luxon";
import { z } from "zod";
import { getAdminClient } from "../supabase/admin";
import { normalizeIndianPhone } from "./book-appointment";
import { ToolResult } from "./types";

export const findMyAppointmentsInputSchema = z.object({
  patient_phone: z.string().trim().min(1, { message: "Patient phone is required" }),
});

export type FindMyAppointmentsInput = z.infer<typeof findMyAppointmentsInputSchema>;

export interface PatientAppointmentSummary {
  id: string;
  doctor_name: string;
  start_at: string;
  end_at: string;
  label: string; // e.g. "Mon 16 Nov, 10:15 AM"
}

/**
 * Returns a patient's active booked appointments with start_at in the future,
 * sorted soonest first (max 5). Excludes patient PII.
 */
export async function findMyAppointments(
  clinicId: string,
  input: unknown,
  now?: DateTime
): Promise<ToolResult<PatientAppointmentSummary[]>> {
  if (!clinicId || typeof clinicId !== "string") {
    return {
      ok: false,
      error: "INVALID_INPUT",
      message: "A valid clinicId string is required",
    };
  }

  const parsed = findMyAppointmentsInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "INVALID_INPUT",
      message: parsed.error.issues.map((i) => i.message).join(", "),
    };
  }

  const normalizedPhone = normalizeIndianPhone(parsed.data.patient_phone);
  if (!normalizedPhone) {
    return {
      ok: false,
      error: "INVALID_PHONE",
      message: "Invalid phone number format",
    };
  }

  try {
    const supabase = getAdminClient();

    // 1. Fetch clinic timezone
    const { data: clinic, error: clinicErr } = await supabase
      .from("clinics")
      .select("timezone")
      .eq("id", clinicId)
      .maybeSingle();

    if (clinicErr) {
      console.error("[find_my_appointments] clinic error:", clinicErr.message);
      return { ok: false, error: "INTERNAL_ERROR", message: "Failed to load clinic" };
    }
    if (!clinic) {
      return { ok: false, error: "CLINIC_NOT_FOUND", message: "Clinic not found" };
    }

    const clinicTimezone = clinic.timezone || "UTC";

    // 2. Look up patient by clinic_id and phone
    const { data: patient, error: patientErr } = await supabase
      .from("patients")
      .select("id")
      .eq("clinic_id", clinicId)
      .eq("phone", normalizedPhone)
      .maybeSingle();

    if (patientErr) {
      console.error("[find_my_appointments] patient error:", patientErr.message);
      return { ok: false, error: "INTERNAL_ERROR", message: "Failed to look up patient" };
    }

    // Unknown phone returns empty list (not an error)
    if (!patient) {
      return { ok: true, data: [] };
    }

    // 3. Query future booked appointments for this patient
    const currentNow = (now ?? DateTime.now()).setZone(clinicTimezone);
    const currentNowUtc = currentNow.toUTC().toISO()!;

    const { data: appts, error: apptsErr } = await supabase
      .from("appointments")
      .select("id, start_at, end_at, doctors(name)")
      .eq("clinic_id", clinicId)
      .eq("patient_id", patient.id)
      .eq("status", "booked")
      .gt("start_at", currentNowUtc)
      .order("start_at", { ascending: true })
      .limit(5);

    if (apptsErr) {
      console.error("[find_my_appointments] appointments error:", apptsErr.message);
      return { ok: false, error: "INTERNAL_ERROR", message: "Failed to load appointments" };
    }

    const summaries: PatientAppointmentSummary[] = (appts || []).map((row) => {
      // row.doctors can be an object or array in Supabase PostgREST types
      const doc = Array.isArray(row.doctors) ? row.doctors[0] : row.doctors;
      const docName = (doc as { name?: string })?.name || "Doctor";
      const startDateTime = DateTime.fromISO(row.start_at).setZone(clinicTimezone);

      return {
        id: row.id,
        doctor_name: docName,
        start_at: row.start_at,
        end_at: row.end_at,
        label: startDateTime.toFormat("ccc d LLL, h:mm a"),
      };
    });

    return {
      ok: true,
      data: summaries,
    };
  } catch (err) {
    console.error("[find_my_appointments] unexpected error:", err);
    return {
      ok: false,
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred while finding appointments",
    };
  }
}

