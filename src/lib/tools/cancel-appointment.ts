import { DateTime } from "luxon";
import { z } from "zod";
import { getAdminClient } from "../supabase/admin";
import { normalizeIndianPhone } from "./book-appointment";
import { ToolResult } from "./types";

export const cancelAppointmentInputSchema = z.object({
  appointment_id: z.string().uuid({ message: "Invalid appointment_id format; expected UUID" }),
  patient_phone: z.string().trim().min(1, { message: "Patient phone is required" }),
});

export type CancelAppointmentInput = z.infer<typeof cancelAppointmentInputSchema>;

export interface CancelAppointmentConfirmation {
  id: string;
  doctor_name: string;
  label: string;
}

/**
 * Cancels a booked future appointment verifying phone ownership.
 */
export async function cancelAppointment(
  clinicId: string,
  input: unknown,
  now?: DateTime
): Promise<ToolResult<CancelAppointmentConfirmation>> {
  if (!clinicId || typeof clinicId !== "string") {
    return {
      ok: false,
      error: "INVALID_INPUT",
      message: "A valid clinicId string is required",
    };
  }

  const parsed = cancelAppointmentInputSchema.safeParse(input);
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

  const appointmentId = parsed.data.appointment_id;

  try {
    const supabase = getAdminClient();

    // 1. Fetch clinic timezone
    const { data: clinic, error: clinicErr } = await supabase
      .from("clinics")
      .select("timezone")
      .eq("id", clinicId)
      .maybeSingle();

    if (clinicErr) {
      console.error("[cancel_appointment] clinic error:", clinicErr.message);
      return { ok: false, error: "INTERNAL_ERROR", message: "Failed to load clinic" };
    }
    if (!clinic) {
      return { ok: false, error: "CLINIC_NOT_FOUND", message: "Clinic not found" };
    }

    const clinicTimezone = clinic.timezone || "UTC";
    const currentNow = (now ?? DateTime.now()).setZone(clinicTimezone);
    const currentNowUtc = currentNow.toUTC().toISO()!;

    // 2. Look up patient by clinic_id and phone
    const { data: patient, error: patientErr } = await supabase
      .from("patients")
      .select("id")
      .eq("clinic_id", clinicId)
      .eq("phone", normalizedPhone)
      .maybeSingle();

    if (patientErr) {
      console.error("[cancel_appointment] patient error:", patientErr.message);
      return { ok: false, error: "INTERNAL_ERROR", message: "Failed to look up patient" };
    }

    // Uniform error if patient doesn't exist
    if (!patient) {
      return {
        ok: false,
        error: "APPOINTMENT_NOT_FOUND",
        message: "Appointment not found",
      };
    }

    // 3. Find appointment by id, clinic_id, and patient_id
    const { data: appt, error: apptErr } = await supabase
      .from("appointments")
      .select("id, status, start_at, doctors(name)")
      .eq("id", appointmentId)
      .eq("clinic_id", clinicId)
      .eq("patient_id", patient.id)
      .maybeSingle();

    if (apptErr) {
      console.error("[cancel_appointment] appointment query error:", apptErr.message);
      return { ok: false, error: "INTERNAL_ERROR", message: "Failed to look up appointment" };
    }

    // Uniform error if not found, wrong phone, or wrong clinic
    if (!appt) {
      return {
        ok: false,
        error: "APPOINTMENT_NOT_FOUND",
        message: "Appointment not found",
      };
    }

    if (appt.status === "cancelled") {
      return {
        ok: false,
        error: "ALREADY_CANCELLED",
        message: "This appointment is already cancelled",
      };
    }

    if (appt.status !== "booked" || appt.start_at <= currentNowUtc) {
      return {
        ok: false,
        error: "APPOINTMENT_NOT_CANCELLABLE",
        message: "Past or non-booked appointments cannot be cancelled",
      };
    }

    const originalStartAt = appt.start_at;

    // 4. Atomic cancel UPDATE with status='booked', start_at > currentNow, start_at = originalStartAt
    const { data: updated, error: updateErr } = await supabase
      .from("appointments")
      .update({ status: "cancelled" })
      .eq("id", appointmentId)
      .eq("clinic_id", clinicId)
      .eq("status", "booked")
      .eq("start_at", originalStartAt)
      .gt("start_at", currentNowUtc)
      .select("id")
      .maybeSingle();

    if (updateErr) {
      console.error("[cancel_appointment] update error:", updateErr.message);
      return { ok: false, error: "INTERNAL_ERROR", message: "Failed to cancel appointment" };
    }

    // If zero rows updated (e.g. concurrent race)
    if (!updated) {
      const { data: recheck } = await supabase
        .from("appointments")
        .select("status, start_at")
        .eq("id", appointmentId)
        .eq("clinic_id", clinicId)
        .eq("patient_id", patient.id)
        .maybeSingle();

      if (!recheck) {
        return { ok: false, error: "APPOINTMENT_NOT_FOUND", message: "Appointment not found" };
      }
      if (recheck.status === "cancelled") {
        return { ok: false, error: "ALREADY_CANCELLED", message: "This appointment is already cancelled" };
      }
      return {
        ok: false,
        error: "APPOINTMENT_NOT_CANCELLABLE",
        message: "Appointment was modified or is in the past",
      };
    }

    const doc = Array.isArray(appt.doctors) ? appt.doctors[0] : appt.doctors;
    const docName = (doc as { name?: string })?.name || "Doctor";
    const startDateTime = DateTime.fromISO(originalStartAt).setZone(clinicTimezone);

    return {
      ok: true,
      data: {
        id: appointmentId,
        doctor_name: docName,
        label: startDateTime.toFormat("ccc d LLL, h:mm a"),
      },
    };
  } catch (err) {
    console.error("[cancel_appointment] unexpected error:", err);
    return {
      ok: false,
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred while cancelling appointment",
    };
  }
}

