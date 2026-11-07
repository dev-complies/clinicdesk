import { DateTime } from "luxon";
import { getAdminClient } from "../supabase/admin";
import { ToolResult } from "./types";

export interface AvailabilitySlot {
  start_at: string; // UTC ISO string
  end_at: string;   // UTC ISO string
  label: string;    // Local clinic time formatted, e.g. "9:00 AM", "10:15 AM"
}

export interface SlotInterval {
  start: DateTime;
  end: DateTime;
  start_at: string;
  end_at: string;
  label: string;
}

export interface DayScheduleContext {
  clinicTimezone: string;
  doctor: {
    id: string;
    name: string;
    speciality: string | null;
    fee: number;
  };
  schedule: {
    startTime: string;
    endTime: string;
    slotMinutes: number;
  } | null;
  gridSlots: SlotInterval[];
  bookedAppointments: { start: DateTime; end: DateTime }[];
  availableSlots: AvailabilitySlot[];
}

/**
 * Loads clinic timezone, doctor, doctor's schedule for the day, and computes
 * all grid slots, booked intervals, and currently available slots.
 */
export async function getDoctorDayScheduleContext(
  clinicId: string,
  doctorId: string,
  requestedDate: DateTime,
  now?: DateTime
): Promise<ToolResult<DayScheduleContext>> {
  const supabase = getAdminClient();

  // 1. Fetch clinic timezone
  const { data: clinic, error: clinicError } = await supabase
    .from("clinics")
    .select("id, timezone")
    .eq("id", clinicId)
    .maybeSingle();

  if (clinicError) {
    console.error("[getDoctorDayScheduleContext] error loading clinic:", clinicError.message);
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

  // 2. Verify doctor belongs to clinicId and is active
  const { data: doctor, error: doctorError } = await supabase
    .from("doctors")
    .select("id, name, speciality, fee, active")
    .eq("id", doctorId)
    .eq("clinic_id", clinicId)
    .maybeSingle();

  if (doctorError) {
    console.error("[getDoctorDayScheduleContext] error loading doctor:", doctorError.message);
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

  // 3. Look up doctor's schedule for that weekday
  // Luxon weekday: 1 (Mon) ... 7 (Sun)
  // DB convention: 0 (Sun) ... 6 (Sat)
  const dbWeekday = requestedDate.weekday === 7 ? 0 : requestedDate.weekday;

  const { data: scheduleRow, error: scheduleError } = await supabase
    .from("doctor_schedules")
    .select("start_time, end_time, slot_minutes")
    .eq("doctor_id", doctorId)
    .eq("clinic_id", clinicId)
    .eq("weekday", dbWeekday)
    .maybeSingle();

  if (scheduleError) {
    console.error("[getDoctorDayScheduleContext] error loading schedule:", scheduleError.message);
    return {
      ok: false,
      error: "INTERNAL_ERROR",
      message: "Failed to load doctor schedule",
    };
  }

  const schedule = scheduleRow
    ? {
        startTime: scheduleRow.start_time,
        endTime: scheduleRow.end_time,
        slotMinutes: scheduleRow.slot_minutes,
      }
    : null;

  if (!schedule) {
    return {
      ok: true,
      data: {
        clinicTimezone,
        doctor: {
          id: doctor.id,
          name: doctor.name,
          speciality: doctor.speciality,
          fee: Number(doctor.fee),
        },
        schedule: null,
        gridSlots: [],
        bookedAppointments: [],
        availableSlots: [],
      },
    };
  }

  // 4. Generate candidate grid slots
  const [startH, startM] = schedule.startTime.split(":").map(Number);
  const [endH, endM] = schedule.endTime.split(":").map(Number);

  let slotStart = requestedDate.set({ hour: startH, minute: startM, second: 0, millisecond: 0 });
  const scheduleEnd = requestedDate.set({ hour: endH, minute: endM, second: 0, millisecond: 0 });
  const slotMinutes = schedule.slotMinutes;

  const gridSlots: SlotInterval[] = [];
  while (slotStart.plus({ minutes: slotMinutes }) <= scheduleEnd) {
    const slotEnd = slotStart.plus({ minutes: slotMinutes });
    gridSlots.push({
      start: slotStart,
      end: slotEnd,
      start_at: slotStart.toUTC().toISO()!,
      end_at: slotEnd.toUTC().toISO()!,
      label: slotStart.toFormat("h:mm a"),
    });
    slotStart = slotEnd;
  }

  // 5. Query booked appointments using local start-of-day to next local start-of-day in UTC
  const dayStartUtc = requestedDate.toUTC().toISO();
  const nextDayStartUtc = requestedDate.plus({ days: 1 }).toUTC().toISO();

  const { data: bookedRows, error: apptError } = await supabase
    .from("appointments")
    .select("start_at, end_at")
    .eq("doctor_id", doctorId)
    .eq("clinic_id", clinicId)
    .eq("status", "booked")
    .gte("start_at", dayStartUtc)
    .lt("start_at", nextDayStartUtc);

  if (apptError) {
    console.error("[getDoctorDayScheduleContext] error querying appointments:", apptError.message);
    return {
      ok: false,
      error: "INTERNAL_ERROR",
      message: "Failed to check booked appointments",
    };
  }

  const bookedAppointments = (bookedRows || []).map((row) => ({
    start: DateTime.fromISO(row.start_at),
    end: DateTime.fromISO(row.end_at),
  }));

  // 6. Compute available slots (free of booked collision and not earlier than now)
  const currentNow = (now ?? DateTime.now()).setZone(clinicTimezone);
  const availableSlots: AvailabilitySlot[] = [];

  for (const slot of gridSlots) {
    const overlaps = bookedAppointments.some(
      (appt) => slot.start < appt.end && slot.end > appt.start
    );
    if (overlaps) {
      continue;
    }

    if (slot.start < currentNow) {
      continue;
    }

    availableSlots.push({
      start_at: slot.start_at,
      end_at: slot.end_at,
      label: slot.label,
    });
  }

  return {
    ok: true,
    data: {
      clinicTimezone,
      doctor: {
        id: doctor.id,
        name: doctor.name,
        speciality: doctor.speciality,
        fee: Number(doctor.fee),
      },
      schedule,
      gridSlots,
      bookedAppointments,
      availableSlots,
    },
  };
}

