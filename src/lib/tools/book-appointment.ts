import { DateTime } from "luxon";
import { z } from "zod";
import { SupabaseClient } from "@supabase/supabase-js";
import { getAdminClient } from "../supabase/admin";
import {
  AvailabilitySlot,
  getDoctorDayScheduleContext,
} from "./availability-helper";
import { ToolResult } from "./types";

export const bookAppointmentInputSchema = z.object({
  doctor_id: z.string().uuid({ message: "Invalid doctor_id format; expected UUID" }),
  patient_name: z
    .string()
    .trim()
    .min(1, { message: "Patient name must be at least 1 character" })
    .max(100, { message: "Patient name must not exceed 100 characters" }),
  patient_phone: z.string().trim().min(1, { message: "Patient phone is required" }),
  start_at: z.string().datetime({ message: "Invalid start_at format; expected ISO datetime string" }),
});

export type BookAppointmentInput = z.infer<typeof bookAppointmentInputSchema>;

export interface BookedAppointmentConfirmation {
  id: string;
  doctor_name: string;
  patient_name: string;
  start_at: string;
  end_at: string;
  label: string; // e.g. "Mon 16 Nov, 10:15 AM"
}

export interface SlotTakenErrorData {
  next_slots: AvailabilitySlot[];
}

/**
 * Normalises an Indian phone number to canonical E.164 (+91XXXXXXXXXX).
 * Accepts:
 *  - 10 digits
 *  - "91" + 10 digits
 *  - "+91" + 10 digits
 * Spaces, dashes, and parentheses are stripped.
 * The first of the 10 national digits must be between 6 and 9.
 * Returns null if the phone is invalid.
 */
export function normalizeIndianPhone(rawPhone: string): string | null {
  if (!rawPhone || typeof rawPhone !== "string") return null;
  const cleaned = rawPhone.replace(/[\s\-\(\)]/g, "");
  let digits: string;

  if (cleaned.startsWith("+91")) {
    digits = cleaned.slice(3);
  } else if (cleaned.startsWith("91") && cleaned.length === 12) {
    digits = cleaned.slice(2);
  } else if (cleaned.length === 10) {
    digits = cleaned;
  } else {
    return null;
  }

  if (/^[6-9]\d{9}$/.test(digits)) {
    return `+91${digits}`;
  }
  return null;
}

/**
 * Cleans up a newly created patient row if the appointment could not be booked
 * and the patient has no other existing appointments.
 */
async function cleanupNewPatientIfEmpty(supabase: SupabaseClient, patientId: string | null) {
  if (!patientId) return;
  try {
    const { count } = await supabase
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("patient_id", patientId);

    if (!count || count === 0) {
      await supabase.from("patients").delete().eq("id", patientId);
    }
  } catch (err) {
    console.error("[book_appointment] error cleaning up newly created patient:", err);
  }
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
 * Books an appointment for a patient at the given clinic.
 *
 * @param clinicId Tenant clinic UUID (supplied by server)
 * @param input Raw input object containing doctor_id, patient_name, patient_phone, start_at
 * @param now Optional override for current time (used in tests to assert past slot rejection)
 */
export async function bookAppointment(
  clinicId: string,
  input: unknown,
  now?: DateTime
): Promise<ToolResult<BookedAppointmentConfirmation, SlotTakenErrorData>> {
  if (!clinicId || typeof clinicId !== "string") {
    return {
      ok: false,
      error: "INVALID_INPUT",
      message: "A valid clinicId string is required",
    };
  }

  const parsed = bookAppointmentInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "INVALID_INPUT",
      message: parsed.error.issues.map((i) => i.message).join(", "),
    };
  }

  const {
    doctor_id: doctorId,
    patient_name: rawPatientName,
    patient_phone: rawPhone,
    start_at: rawStartAt,
  } = parsed.data;

  // 1. Phone number normalization
  const normalizedPhone = normalizeIndianPhone(rawPhone);
  if (!normalizedPhone) {
    return {
      ok: false,
      error: "INVALID_PHONE",
      message:
        "Invalid phone number. Expected a 10-digit Indian mobile number starting with 6-9 (optionally with +91 or 91).",
    };
  }

  try {
    const supabase = getAdminClient();

    // 2. Fetch clinic timezone
    const { data: clinic, error: clinicError } = await supabase
      .from("clinics")
      .select("id, timezone")
      .eq("id", clinicId)
      .maybeSingle();

    if (clinicError) {
      console.error("[book_appointment] error loading clinic:", clinicError.message);
      return {
        ok: false,
        error: "INTERNAL_ERROR",
        message: "Failed to load clinic information",
      };
    }

    if (!clinic) {
      return {
        ok: false,
        error: "CLINIC_NOT_FOUND",
        message: "Clinic not found",
      };
    }

    const clinicTimezone = clinic.timezone || "UTC";

    // 3. Parse and validate start_at in clinic timezone
    const reqStart = DateTime.fromISO(rawStartAt).setZone(clinicTimezone);
    if (!reqStart.isValid) {
      return {
        ok: false,
        error: "INVALID_SLOT",
        message: "Invalid start_at date provided",
      };
    }

    const requestedDate = reqStart.startOf("day");
    const currentNow = (now ?? DateTime.now()).setZone(clinicTimezone);
    const todayStart = currentNow.startOf("day");
    const maxBookingDate = todayStart.plus({ days: 60 });

    // Beyond 60 days must return DATE_TOO_FAR
    if (requestedDate > maxBookingDate) {
      return {
        ok: false,
        error: "DATE_TOO_FAR",
        message: "Appointments can only be booked up to 60 days in advance",
      };
    }

    // Past slot check
    if (reqStart < currentNow) {
      return {
        ok: false,
        error: "INVALID_SLOT",
        message: "Cannot book an appointment slot in the past",
      };
    }

    // 4. Load doctor day schedule context
    const contextResult = await getDoctorDayScheduleContext(
      clinicId,
      doctorId,
      requestedDate,
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

    // Doctor has no schedule for this weekday
    if (!context.schedule) {
      return {
        ok: false,
        error: "INVALID_SLOT",
        message: "Doctor has no schedule available on this day",
      };
    }

    // Check if start_at aligns with the doctor's recurring schedule grid
    const reqStartUtcIso = reqStart.toUTC().toISO();
    const matchingGridSlot = context.gridSlots.find((slot) => slot.start_at === reqStartUtcIso);

    if (!matchingGridSlot) {
      return {
        ok: false,
        error: "INVALID_SLOT",
        message: "The requested time does not align with the doctor's schedule slots",
      };
    }

    // Check if the slot is currently free or already taken
    const isFree = context.availableSlots.some((slot) => slot.start_at === reqStartUtcIso);
    if (!isFree) {
      const nextSlots = await getNextFreeSlots(clinicId, doctorId, requestedDate, reqStart, now);
      return {
        ok: false,
        error: "SLOT_TAKEN",
        message: "This slot is already booked. Here are the next available slots.",
        data: { next_slots: nextSlots },
      };
    }

    // 5. Patient resolution with select-then-insert and 23505 race handling
    let patientId: string;
    let createdPatientId: string | null = null;

    const { data: existingPatient, error: selectPatientError } = await supabase
      .from("patients")
      .select("id, name")
      .eq("clinic_id", clinicId)
      .eq("phone", normalizedPhone)
      .maybeSingle();

    if (selectPatientError) {
      console.error("[book_appointment] error querying patient:", selectPatientError.message);
      return {
        ok: false,
        error: "INTERNAL_ERROR",
        message: "Failed to look up patient",
      };
    }

    if (existingPatient) {
      patientId = existingPatient.id;
      // Do NOT overwrite existingPatient.name in database
    } else {
      const { data: newPatient, error: insertPatientError } = await supabase
        .from("patients")
        .insert({
          clinic_id: clinicId,
          name: rawPatientName.trim(),
          phone: normalizedPhone,
        })
        .select("id")
        .single();

      if (insertPatientError) {
        if (insertPatientError.code === "23505") {
          // Race condition: another request inserted this patient concurrently.
          // Re-select without overwriting name.
          const { data: racedPatient, error: reSelectError } = await supabase
            .from("patients")
            .select("id")
            .eq("clinic_id", clinicId)
            .eq("phone", normalizedPhone)
            .single();

          if (reSelectError || !racedPatient) {
            console.error("[book_appointment] error re-selecting raced patient:", reSelectError?.message);
            return {
              ok: false,
              error: "INTERNAL_ERROR",
              message: "Failed to resolve patient record",
            };
          }
          patientId = racedPatient.id;
        } else {
          console.error("[book_appointment] error creating patient:", insertPatientError.message);
          return {
            ok: false,
            error: "INTERNAL_ERROR",
            message: "Failed to create patient record",
          };
        }
      } else {
        patientId = newPatient.id;
        createdPatientId = newPatient.id;
      }
    }

    // 6. Check TOO_MANY_BOOKINGS limit (at most 3 active future bookings)
    const { count: futureBookingsCount, error: countErr } = await supabase
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicId)
      .eq("patient_id", patientId)
      .eq("status", "booked")
      .gt("start_at", currentNow.toUTC().toISO()!);

    if (countErr) {
      console.error("[book_appointment] error counting future appointments:", countErr.message);
      await cleanupNewPatientIfEmpty(supabase, createdPatientId);
      return {
        ok: false,
        error: "INTERNAL_ERROR",
        message: "Failed to verify existing bookings",
      };
    }

    if ((futureBookingsCount ?? 0) >= 3) {
      await cleanupNewPatientIfEmpty(supabase, createdPatientId);
      return {
        ok: false,
        error: "TOO_MANY_BOOKINGS",
        message: "Patient already has the maximum of 3 active future bookings",
      };
    }

    // 7. Insert the appointment
    const appointmentEndAt = matchingGridSlot.end_at;
    const { data: appointment, error: insertApptError } = await supabase
      .from("appointments")
      .insert({
        clinic_id: clinicId,
        doctor_id: doctorId,
        patient_id: patientId,
        start_at: matchingGridSlot.start_at,
        end_at: appointmentEndAt,
        status: "booked",
        created_via: "ai",
      })
      .select("id")
      .single();

    if (insertApptError) {
      // Clean up newly created patient row if appointment failed
      await cleanupNewPatientIfEmpty(supabase, createdPatientId);

      // Check if partial unique index appointments_no_double_booking rejected it
      const isDoubleBooking =
        insertApptError.code === "23505" &&
        (insertApptError.message?.includes("appointments_no_double_booking") ||
          (insertApptError.details && insertApptError.details.includes("appointments_no_double_booking")));

      if (isDoubleBooking) {
        const nextSlots = await getNextFreeSlots(clinicId, doctorId, requestedDate, reqStart, now);
        return {
          ok: false,
          error: "SLOT_TAKEN",
          message: "This slot is already booked. Here are the next available slots.",
          data: { next_slots: nextSlots },
        };
      }

      console.error("[book_appointment] error inserting appointment:", insertApptError.message);
      return {
        ok: false,
        error: "INTERNAL_ERROR",
        message: "Failed to book appointment",
      };
    }

    // 8. Format confirmation response echoing the request patient_name
    const localDateLabel = matchingGridSlot.start
      .setZone(clinicTimezone)
      .toFormat("ccc d LLL, h:mm a");

    return {
      ok: true,
      data: {
        id: appointment.id,
        doctor_name: context.doctor.name,
        patient_name: rawPatientName.trim(),
        start_at: matchingGridSlot.start_at,
        end_at: appointmentEndAt,
        label: localDateLabel,
      },
    };
  } catch (err) {
    console.error("[book_appointment] unexpected error:", err);
    return {
      ok: false,
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred while booking appointment",
    };
  }
}

