import { DateTime } from "luxon";
import { z } from "zod";
import { getAdminClient } from "../supabase/admin";
import { ToolResult } from "./types";

export const checkAvailabilityInputSchema = z.object({
  doctor_id: z.string().uuid({ message: "Invalid doctor_id format; expected UUID" }),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "Invalid date format; expected YYYY-MM-DD" }),
});

export type CheckAvailabilityInput = z.infer<typeof checkAvailabilityInputSchema>;

export interface AvailabilitySlot {
  start_at: string; // UTC ISO string
  end_at: string;   // UTC ISO string
  label: string;    // Local clinic time formatted, e.g. "9:00 AM", "10:15 AM"
}

/**
 * Checks doctor availability for a given date in the clinic's local timezone.
 *
 * @param clinicId Tenant clinic UUID (supplied by server)
 * @param input Raw input object containing doctor_id and date (YYYY-MM-DD)
 * @param now Optional override for current time (used in tests to assert past slot removal)
 */
export async function checkAvailability(
  clinicId: string,
  input: unknown,
  now?: DateTime
): Promise<ToolResult<AvailabilitySlot[]>> {
  if (!clinicId || typeof clinicId !== "string") {
    return {
      ok: false,
      error: "INVALID_INPUT",
      message: "A valid clinicId string is required",
    };
  }

  const parsedInput = checkAvailabilityInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return {
      ok: false,
      error: "INVALID_INPUT",
      message: parsedInput.error.issues.map((i) => i.message).join(", "),
    };
  }

  const { doctor_id: doctorId, date: dateStr } = parsedInput.data;

  try {
    const supabase = getAdminClient();

    // 1. Fetch clinic timezone
    const { data: clinic, error: clinicError } = await supabase
      .from("clinics")
      .select("id, timezone")
      .eq("id", clinicId)
      .maybeSingle();

    if (clinicError) {
      console.error("[check_availability] error loading clinic:", clinicError.message);
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

    // 2. Validate calendar date with Luxon in the clinic timezone
    const requestedDate = DateTime.fromISO(dateStr, { zone: clinicTimezone }).startOf("day");
    if (!requestedDate.isValid) {
      return {
        ok: false,
        error: "INVALID_INPUT",
        message: requestedDate.invalidReason || "Invalid date provided",
      };
    }

    // 3. Evaluate date window relative to "now"
    const currentNow = (now ?? DateTime.now()).setZone(clinicTimezone);
    const todayStart = currentNow.startOf("day");
    const maxBookingDate = todayStart.plus({ days: 60 });

    if (requestedDate > maxBookingDate) {
      return {
        ok: false,
        error: "DATE_TOO_FAR",
        message: "Appointments can only be booked up to 60 days in advance",
      };
    }

    if (requestedDate < todayStart) {
      // Past dates return an empty list without error
      return {
        ok: true,
        data: [],
      };
    }

    // 4. Verify doctor belongs to clinicId and is active
    const { data: doctor, error: doctorError } = await supabase
      .from("doctors")
      .select("id, active")
      .eq("id", doctorId)
      .eq("clinic_id", clinicId)
      .maybeSingle();

    if (doctorError) {
      console.error("[check_availability] error loading doctor:", doctorError.message);
      return {
        ok: false,
        error: "INTERNAL_ERROR",
        message: "Failed to verify doctor",
      };
    }

    if (!doctor || !doctor.active) {
      return {
        ok: false,
        error: "DOCTOR_NOT_FOUND",
        message: "Doctor not found or inactive",
      };
    }

    // 5. Look up doctor's schedule for that weekday
    // Luxon weekday: 1 (Mon) ... 7 (Sun)
    // DB convention: 0 (Sun) ... 6 (Sat)
    const dbWeekday = requestedDate.weekday === 7 ? 0 : requestedDate.weekday;

    const { data: schedule, error: scheduleError } = await supabase
      .from("doctor_schedules")
      .select("start_time, end_time, slot_minutes")
      .eq("doctor_id", doctorId)
      .eq("clinic_id", clinicId)
      .eq("weekday", dbWeekday)
      .maybeSingle();

    if (scheduleError) {
      console.error("[check_availability] error loading schedule:", scheduleError.message);
      return {
        ok: false,
        error: "INTERNAL_ERROR",
        message: "Failed to load doctor schedule",
      };
    }

    // If no schedule exists for this weekday, return empty list
    if (!schedule) {
      return {
        ok: true,
        data: [],
      };
    }

    // 6. Generate slots within [start_time, end_time]
    const [startH, startM] = schedule.start_time.split(":").map(Number);
    const [endH, endM] = schedule.end_time.split(":").map(Number);

    let slotStart = requestedDate.set({ hour: startH, minute: startM, second: 0, millisecond: 0 });
    const scheduleEnd = requestedDate.set({ hour: endH, minute: endM, second: 0, millisecond: 0 });
    const slotMinutes = schedule.slot_minutes;

    const generatedSlots: { start: DateTime; end: DateTime }[] = [];
    while (slotStart.plus({ minutes: slotMinutes }) <= scheduleEnd) {
      const slotEnd = slotStart.plus({ minutes: slotMinutes });
      generatedSlots.push({ start: slotStart, end: slotEnd });
      slotStart = slotEnd;
    }

    // 7. Query booked appointments using the UTC range from local start-of-day to next local start-of-day
    const dayStartUtc = requestedDate.toUTC().toISO();
    const nextDayStartUtc = requestedDate.plus({ days: 1 }).toUTC().toISO();

    const { data: bookedAppointments, error: apptError } = await supabase
      .from("appointments")
      .select("start_at, end_at")
      .eq("doctor_id", doctorId)
      .eq("clinic_id", clinicId)
      .eq("status", "booked")
      .gte("start_at", dayStartUtc)
      .lt("start_at", nextDayStartUtc);

    if (apptError) {
      console.error("[check_availability] error querying appointments:", apptError.message);
      return {
        ok: false,
        error: "INTERNAL_ERROR",
        message: "Failed to check booked appointments",
      };
    }

    const bookedIntervals = (bookedAppointments || []).map((appt) => ({
      start: DateTime.fromISO(appt.start_at),
      end: DateTime.fromISO(appt.end_at),
    }));

    // 8. Filter candidate slots:
    //    a) Remove slots overlapping any booked appointment
    //    b) Remove slots earlier than "now"
    const availableSlots: AvailabilitySlot[] = [];

    for (const slot of generatedSlots) {
      // Overlap condition: slot.start < appt.end && slot.end > appt.start
      const overlapsBooked = bookedIntervals.some(
        (appt) => slot.start < appt.end && slot.end > appt.start
      );
      if (overlapsBooked) {
        continue;
      }

      // Past slot condition: slots starting earlier than current time
      if (slot.start < currentNow) {
        continue;
      }

      availableSlots.push({
        start_at: slot.start.toUTC().toISO()!,
        end_at: slot.end.toUTC().toISO()!,
        label: slot.start.toFormat("h:mm a"),
      });
    }

    return {
      ok: true,
      data: availableSlots,
    };
  } catch (err) {
    console.error("[check_availability] unexpected error:", err);
    return {
      ok: false,
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred while checking availability",
    };
  }
}

