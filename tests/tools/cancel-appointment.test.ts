import * as dotenv from "dotenv";
import { DateTime } from "luxon";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAdminClient } from "../../src/lib/supabase/admin";
import { bookAppointment } from "../../src/lib/tools/book-appointment";
import { cancelAppointment } from "../../src/lib/tools/cancel-appointment";
import { checkAvailability } from "../../src/lib/tools/check-availability";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

describe("Tool: cancel_appointment", () => {
  let clinicAId: string;
  let clinicBId: string;
  let doctorA1Id: string;

  const createdAppointmentIds = new Set<string>();
  const createdPatientIds = new Set<string>();

  let mondayDate: DateTime;

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

    const { data: docA1 } = await supabase
      .from("doctors")
      .select("id")
      .eq("clinic_id", clinicAId)
      .eq("name", "Dr. Priya Sharma")
      .single();
    doctorA1Id = docA1!.id;

    // Use Monday 28 days ahead to completely separate from other suites
    let candidate = DateTime.now().setZone("Asia/Kolkata").plus({ days: 28 }).startOf("day");
    while (candidate.weekday !== 1) {
      candidate = candidate.plus({ days: 1 });
    }
    mondayDate = candidate;
  });

  afterAll(async () => {
    const supabase = getAdminClient();
    if (createdAppointmentIds.size > 0) {
      await supabase
        .from("appointments")
        .delete()
        .in("id", Array.from(createdAppointmentIds));
    }
    if (createdPatientIds.size > 0) {
      await supabase
        .from("patients")
        .delete()
        .in("id", Array.from(createdPatientIds));
    }
  });

  it("cancels appointment successfully; slot reappears in check_availability and can be booked again", async () => {
    const phone = "9820200001";
    const slot = mondayDate.set({ hour: 10, minute: 30 }).toUTC().toISO()!;

    // 1. Book slot
    const bookRes = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "Cancel Target",
      patient_phone: phone,
      start_at: slot,
    });
    expect(bookRes.ok).toBe(true);
    if (!bookRes.ok) return;

    const appointmentId = bookRes.data.id;
    createdAppointmentIds.add(appointmentId);

    // Verify slot is taken in check_availability
    const availBefore = await checkAvailability(clinicAId, {
      doctor_id: doctorA1Id,
      date: mondayDate.toISODate()!,
    });
    expect(availBefore.ok && availBefore.data.some((s) => s.start_at === slot)).toBe(false);

    // 2. Cancel appointment
    const cancelRes = await cancelAppointment(clinicAId, {
      appointment_id: appointmentId,
      patient_phone: phone,
    });

    expect(cancelRes.ok).toBe(true);
    if (!cancelRes.ok) return;
    expect(cancelRes.data.doctor_name).toBe("Dr. Priya Sharma");
    expect(cancelRes.data.label).toBe(mondayDate.set({ hour: 10, minute: 30 }).toFormat("ccc d LLL, h:mm a"));

    // Verify row status is 'cancelled' (not deleted)
    const supabase = getAdminClient();
    const { data: dbRow } = await supabase
      .from("appointments")
      .select("status")
      .eq("id", appointmentId)
      .single();
    expect(dbRow?.status).toBe("cancelled");

    // 3. Verify slot reappears in check_availability
    const availAfter = await checkAvailability(clinicAId, {
      doctor_id: doctorA1Id,
      date: mondayDate.toISODate()!,
    });
    expect(availAfter.ok).toBe(true);
    if (availAfter.ok) {
      expect(availAfter.data.some((s) => s.start_at === slot)).toBe(true);
    }

    // 4. Verify slot can be booked again by someone else
    const rebookPhone = "9820200002";
    const rebookRes = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "New Booker",
      patient_phone: rebookPhone,
      start_at: slot,
    });
    expect(rebookRes.ok).toBe(true);
    if (rebookRes.ok) {
      createdAppointmentIds.add(rebookRes.data.id);
    }
  });

  it("returns identical APPOINTMENT_NOT_FOUND for wrong phone, unknown id, and another clinic's appointment", async () => {
    const phone = "9820200003";
    const slot = mondayDate.set({ hour: 11, minute: 30 }).toUTC().toISO()!;
    const bookRes = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "Probe Target",
      patient_phone: phone,
      start_at: slot,
    });
    expect(bookRes.ok).toBe(true);
    if (!bookRes.ok) return;

    const appointmentId = bookRes.data.id;
    createdAppointmentIds.add(appointmentId);

    // Case 1: Wrong phone number
    const resWrongPhone = await cancelAppointment(clinicAId, {
      appointment_id: appointmentId,
      patient_phone: "9820299999",
    });
    expect(resWrongPhone.ok).toBe(false);
    if (!resWrongPhone.ok) {
      expect(resWrongPhone.error).toBe("APPOINTMENT_NOT_FOUND");
    }

    // Case 2: Unknown appointment ID
    const resUnknownId = await cancelAppointment(clinicAId, {
      appointment_id: "00000000-0000-0000-0000-000000000000",
      patient_phone: phone,
    });
    expect(resUnknownId.ok).toBe(false);
    if (!resUnknownId.ok) {
      expect(resUnknownId.error).toBe("APPOINTMENT_NOT_FOUND");
    }

    // Case 3: Calling from another clinic
    const resOtherClinic = await cancelAppointment(clinicBId, {
      appointment_id: appointmentId,
      patient_phone: phone,
    });
    expect(resOtherClinic.ok).toBe(false);
    if (!resOtherClinic.ok) {
      expect(resOtherClinic.error).toBe("APPOINTMENT_NOT_FOUND");
    }

    // Verify row status is completely unchanged in database
    const supabase = getAdminClient();
    const { data: dbRow } = await supabase
      .from("appointments")
      .select("status")
      .eq("id", appointmentId)
      .single();
    expect(dbRow?.status).toBe("booked");
  });

  it("already cancelled appointment returns ALREADY_CANCELLED", async () => {
    const phone = "9820200004";
    const slot = mondayDate.set({ hour: 12, minute: 30 }).toUTC().toISO()!;
    const bookRes = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "Double Cancel Target",
      patient_phone: phone,
      start_at: slot,
    });
    expect(bookRes.ok).toBe(true);
    if (!bookRes.ok) return;

    createdAppointmentIds.add(bookRes.data.id);

    // First cancel
    const firstCancel = await cancelAppointment(clinicAId, {
      appointment_id: bookRes.data.id,
      patient_phone: phone,
    });
    expect(firstCancel.ok).toBe(true);

    // Second cancel
    const secondCancel = await cancelAppointment(clinicAId, {
      appointment_id: bookRes.data.id,
      patient_phone: phone,
    });
    expect(secondCancel.ok).toBe(false);
    if (!secondCancel.ok) {
      expect(secondCancel.error).toBe("ALREADY_CANCELLED");
    }
  });

  it("past appointment returns APPOINTMENT_NOT_CANCELLABLE", async () => {
    const phone = "9820200005";
    const slot = mondayDate.set({ hour: 13, minute: 30 }).toUTC().toISO()!;
    const bookRes = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "Past Cancel Target",
      patient_phone: phone,
      start_at: slot,
    });
    expect(bookRes.ok).toBe(true);
    if (!bookRes.ok) return;

    createdAppointmentIds.add(bookRes.data.id);

    // Simulate "now" as being after the slot
    const mockNow = mondayDate.set({ hour: 14, minute: 0 });

    const cancelRes = await cancelAppointment(
      clinicAId,
      {
        appointment_id: bookRes.data.id,
        patient_phone: phone,
      },
      mockNow
    );

    expect(cancelRes.ok).toBe(false);
    if (!cancelRes.ok) {
      expect(cancelRes.error).toBe("APPOINTMENT_NOT_CANCELLABLE");
    }
  });

  it("CONCURRENCY: two simultaneous cancels of the same appointment -> exactly one ok, the other ALREADY_CANCELLED", async () => {
    const phone = "9820200006";
    const slot = mondayDate.set({ hour: 14, minute: 30 }).toUTC().toISO()!;
    const bookRes = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "Race Cancel Target",
      patient_phone: phone,
      start_at: slot,
    });
    expect(bookRes.ok).toBe(true);
    if (!bookRes.ok) return;

    createdAppointmentIds.add(bookRes.data.id);

    const [c1, c2] = await Promise.all([
      cancelAppointment(clinicAId, {
        appointment_id: bookRes.data.id,
        patient_phone: phone,
      }),
      cancelAppointment(clinicAId, {
        appointment_id: bookRes.data.id,
        patient_phone: phone,
      }),
    ]);

    const successes = [c1, c2].filter((r) => r.ok);
    const alreadyCancelledFailures = [c1, c2].filter((r) => !r.ok && r.error === "ALREADY_CANCELLED");

    expect(successes).toHaveLength(1);
    expect(alreadyCancelledFailures).toHaveLength(1);
  });
});
