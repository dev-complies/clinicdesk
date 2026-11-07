import { DateTime } from "luxon";
import { z } from "zod";
import { getAdminClient } from "../supabase/admin";
import {
  AvailabilitySlot,
  getDoctorDayScheduleContext,
} from "./availability-helper";
import { ToolResult } from "./types";

export type { AvailabilitySlot };

export const checkAvailabilityInputSchema = z.object({
  doctor_id: z.string().uuid({ message: "Invalid doctor_id format; expected UUID" }),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "Invalid date format; expected YYYY-MM-DD" }),
});

export type CheckAvailabilityInput = z.infer<typeof checkAvailabilityInputSchema>;

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

    // 4. Load schedule context and available slots
    const contextResult = await getDoctorDayScheduleContext(
      clinicId,
      doctorId,
      requestedDate,
      now
    );

    if (!contextResult.ok) {
      return contextResult;
    }

    return {
      ok: true,
      data: contextResult.data.availableSlots,
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
