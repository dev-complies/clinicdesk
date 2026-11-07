import { DateTime } from "luxon";
import { z } from "zod";
import { getAdminClient } from "../supabase/admin";
import {
  AvailabilitySlot,
  getDoctorDayScheduleContext,
} from "./availability-helper";
import { normalizeIndianPhone } from "./book-appointment";
import { ToolResult } from "./types";

export const rescheduleAppointmentInputSchema = z.object({
  appointment_id: z.string().uuid({ message: "Invalid appointment_id format; expected UUID" }),
  patient_phone: z.string().trim().min(1, { message: "Patient phone is required" }),
  new_start_at: z.string().datetime({ message: "Invalid new_start_at format; expected ISO datetime string" }),
});

export type RescheduleAppointmentInput = z.infer<typeof rescheduleAppointmentInputSchema>;

export interface RescheduleAppointmentConfirmation {
  id: string;
  doctor_name: string;
  old_label: string; // e.g. "Mon 16 Nov, 10:00 AM"
  new_label: string; // e.g. "Mon 16 Nov, 11:15 AM"
  start_at: string;
  end_at: string;
}

export interface SlotTakenErrorData {
  next_slots: AvailabilitySlot[];
}

/**
 * Computes up to 3 next available free slots for a doctor on a given day.
 */
async function getNextFreeSlots(
  clinicId: string,
  doctorId: string,
  requestedDate: DateTime,
  reqStart: DateTime,
  now?: DateTime
): Promise<AvailabilitySlot[]> {
  const contextResult = await getDoctorDayScheduleContext(clinicId, doctorId, requestedDate, now);
  if (!contextResult.ok) return [];

  const laterSlots = contextResult.data.availableSlots.filter((slot) => {
    const slotStartTime = DateTime.fromISO(slot.start_at);
    return slotStartTime > reqStart;
  });

  if (laterSlots.length >= 3) {
    return laterSlots.slice(0, 3);
  }

  const otherSlots = contextResult.data.availableSlots.filter(
    (s) => !laterSlots.some((ls) => ls.start_at === s.start_at)
  );
  return [...laterSlots, ...otherSlots].slice(0, 3);
}

/**
 * Reschedules an appointment atomically to a new slot for the same doctor.
 */
export async function rescheduleAppointment(
  clinicId: string,
  input: unknown,
  now?: DateTime
): Promise<ToolResult<RescheduleAppointmentConfirmation, SlotTakenErrorData>> {
  if (!clinicId || typeof clinicId !== "string") {
    return {
      ok: false,
      error: "INVALID_INPUT",
      message: "A valid clinicId string is required",
    };
  }

  const parsed = rescheduleAppointmentInputSchema.safeParse(input);
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

  const { appointment_id: appointmentId, new_start_at: rawNewStartAt } = parsed.data;

  try {
    const supabase = getAdminClient();

    // 1. Fetch clinic timezone
    const { data: clinic, error: clinicErr } = await supabase
      .from("clinics")
      .select("timezone")
      .eq("id", clinicId)
      .maybeSingle();

    if (clinicErr) {
      console.error("[reschedule_appointment] clinic error:", clinicErr.message);
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
      console.error("[reschedule_appointment] patient error:", patientErr.message);
      return { ok: false, error: "INTERNAL_ERROR", message: "Failed to look up patient" };
    }

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
      .select("id, doctor_id, status, start_at, end_at, doctors(name)")
      .eq("id", appointmentId)
      .eq("clinic_id", clinicId)
      .eq("patient_id", patient.id)
      .maybeSingle();

    if (apptErr) {
      console.error("[reschedule_appointment] appointment error:", apptErr.message);
      return { ok: false, error: "INTERNAL_ERROR", message: "Failed to look up appointment" };
    }

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
        message: "Past or non-booked appointments cannot be rescheduled",
      };
    }

    const originalStartAt = appt.start_at;
    const doctorId = appt.doctor_id;

    // 4. Validate new_start_at
    const newReqStart = DateTime.fromISO(rawNewStartAt).setZone(clinicTimezone);
    if (!newReqStart.isValid) {
      return {
        ok: false,
        error: "INVALID_SLOT",
        message: "Invalid new_start_at date provided",
      };
    }

    const newReqStartUtcIso = newReqStart.toUTC().toISO()!;

    // Must differ from current start_at (compare by millisecond timestamp to be independent of ISO formatting differences)
    if (newReqStart.toMillis() === DateTime.fromISO(originalStartAt).toMillis()) {
      return {
        ok: false,
        error: "INVALID_SLOT",
        message: "New slot must differ from the current appointment slot",
      };
    }

    const newRequestedDate = newReqStart.startOf("day");
    const todayStart = currentNow.startOf("day");
    const maxBookingDate = todayStart.plus({ days: 60 });

    if (newRequestedDate > maxBookingDate) {
      return {
        ok: false,
        error: "DATE_TOO_FAR",
        message: "Appointments can only be booked up to 60 days in advance",
      };
    }

    if (newReqStart < currentNow) {
      return {
        ok: false,
        error: "INVALID_SLOT",
        message: "Cannot reschedule to a slot in the past",
      };
    }

    // 5. Check target availability on schedule grid
    const contextResult = await getDoctorDayScheduleContext(
      clinicId,
      doctorId,
      newRequestedDate,
      now
    );

    if (!contextResult.ok) {
      return {
        ok: false,
        error: contextResult.error,
        message: contextResult.message,
      };
    }

    const context = contextResult.data;
    if (!context.schedule) {
      return {
        ok: false,
        error: "INVALID_SLOT",
        message: "Doctor has no schedule available on this day",
      };
    }

    const matchingGridSlot = context.gridSlots.find((s) => s.start_at === newReqStartUtcIso);
    if (!matchingGridSlot) {
      return {
        ok: false,
        error: "INVALID_SLOT",
        message: "The requested time does not align with the doctor's schedule slots",
      };
    }

    // Check if slot is taken (excluding this appointment itself, though new_start_at !== originalStartAt)
    const isFree = context.availableSlots.some((s) => s.start_at === newReqStartUtcIso);
    if (!isFree) {
      const nextSlots = await getNextFreeSlots(clinicId, doctorId, newRequestedDate, newReqStart, now);
      return {
        ok: false,
        error: "SLOT_TAKEN",
        message: "This slot is already booked. Here are the next available slots.",
        data: { next_slots: nextSlots },
      };
    }

    // 6. Move atomically with ONE UPDATE on the existing appointment row
    const { data: updated, error: updateErr } = await supabase
      .from("appointments")
      .update({
        start_at: matchingGridSlot.start_at,
        end_at: matchingGridSlot.end_at,
      })
      .eq("id", appointmentId)
      .eq("clinic_id", clinicId)
      .eq("status", "booked")
      .eq("start_at", originalStartAt)
      .gt("start_at", currentNowUtc)
      .select("id, start_at, end_at")
      .maybeSingle();

    if (updateErr) {
      const isDoubleBooking =
        updateErr.code === "23505" &&
        (updateErr.message?.includes("appointments_no_double_booking") ||
          (updateErr.details && updateErr.details.includes("appointments_no_double_booking")));

      if (isDoubleBooking) {
        const nextSlots = await getNextFreeSlots(clinicId, doctorId, newRequestedDate, newReqStart, now);
        return {
          ok: false,
          error: "SLOT_TAKEN",
          message: "This slot is already booked. Here are the next available slots.",
          data: { next_slots: nextSlots },
        };
      }

      console.error("[reschedule_appointment] update error:", updateErr.message);
      return { ok: false, error: "INTERNAL_ERROR", message: "Failed to reschedule appointment" };
    }

    // If zero rows affected (concurrent modification)
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
    const oldDateTime = DateTime.fromISO(originalStartAt).setZone(clinicTimezone);
    const newDateTime = matchingGridSlot.start.setZone(clinicTimezone);

    return {
      ok: true,
      data: {
        id: appointmentId,
        doctor_name: docName,
        old_label: oldDateTime.toFormat("ccc d LLL, h:mm a"),
        new_label: newDateTime.toFormat("ccc d LLL, h:mm a"),
        start_at: matchingGridSlot.start_at,
        end_at: matchingGridSlot.end_at,
      },
    };
  } catch (err) {
    console.error("[reschedule_appointment] unexpected error:", err);
    return {
      ok: false,
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred while rescheduling appointment",
    };
  }
}

