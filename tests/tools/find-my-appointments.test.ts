import * as dotenv from "dotenv";
import { DateTime } from "luxon";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAdminClient } from "../../src/lib/supabase/admin";
import { bookAppointment } from "../../src/lib/tools/book-appointment";
import { cancelAppointment } from "../../src/lib/tools/cancel-appointment";
import { findMyAppointments } from "../../src/lib/tools/find-my-appointments";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

describe("Tool: find_my_appointments", () => {
  let clinicAId: string;
  let clinicBId: string;
  let doctorA1Id: string;

  const createdAppointmentIds = new Set<string>();
  const createdPatientIds = new Set<string>();

  const testPhone = "9820100001";
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

    // Relative future Monday
    let candidate = DateTime.now().setZone("Asia/Kolkata").plus({ days: 14 }).startOf("day");
    while (candidate.weekday !== 1) {
      candidate = candidate.plus({ days: 1 });
    }
    mondayDate = candidate;

    // Seed 2 future booked appointments for testPhone
    const slot1 = mondayDate.set({ hour: 9, minute: 30 }).toUTC().toISO()!;
    const slot2 = mondayDate.set({ hour: 9, minute: 45 }).toUTC().toISO()!;
    const slotCancelled = mondayDate.set({ hour: 10, minute: 0 }).toUTC().toISO()!;

    const b1 = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "Find Test Patient",
      patient_phone: testPhone,
      start_at: slot1,
    });
    if (b1.ok) createdAppointmentIds.add(b1.data.id);

    const b2 = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "Find Test Patient",
      patient_phone: testPhone,
      start_at: slot2,
    });
    if (b2.ok) createdAppointmentIds.add(b2.data.id);

    const b3 = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "Find Test Patient",
      patient_phone: testPhone,
      start_at: slotCancelled,
    });
    if (b3.ok) {
      createdAppointmentIds.add(b3.data.id);
      // Cancel the third appointment to verify exclusion
      await cancelAppointment(clinicAId, {
        appointment_id: b3.data.id,
        patient_phone: testPhone,
      });
    }

    const { data: patient } = await supabase
      .from("patients")
      .select("id")
      .eq("clinic_id", clinicAId)
      .eq("phone", `+91${testPhone}`)
      .single();
    if (patient) createdPatientIds.add(patient.id);
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

  it("returns only future booked appointments, sorted soonest first, excluding cancelled ones", async () => {
    const result = await findMyAppointments(clinicAId, {
      patient_phone: testPhone,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data).toHaveLength(2);

    // Verify chronological order (soonest first)
    const start0 = DateTime.fromISO(result.data[0].start_at);
    const start1 = DateTime.fromISO(result.data[1].start_at);
    expect(start0 <= start1).toBe(true);

    for (const appt of result.data) {
      expect(appt).toHaveProperty("id");
      expect(appt).toHaveProperty("doctor_name", "Dr. Priya Sharma");
      expect(appt).toHaveProperty("start_at");
      expect(appt).toHaveProperty("end_at");
      expect(appt).toHaveProperty("label");
      // Must NOT contain patient name or any patient PII
      expect(appt).not.toHaveProperty("patient_name");
      expect(appt).not.toHaveProperty("patient_phone");
    }
  });

  it("returns empty list for an unknown phone number", async () => {
    const result = await findMyAppointments(clinicAId, {
      patient_phone: "9820199999",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([]);
  });

  it("returns empty list when queried in Clinic B for a phone that only has appointments in Clinic A", async () => {
    const result = await findMyAppointments(clinicBId, {
      patient_phone: testPhone,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([]);
  });

  it("returns INVALID_PHONE on malformed phone number", async () => {
    const result = await findMyAppointments(clinicAId, {
      patient_phone: "invalid123",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("INVALID_PHONE");
  });
});

