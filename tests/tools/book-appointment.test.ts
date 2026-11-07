import * as dotenv from "dotenv";
import { DateTime } from "luxon";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAdminClient } from "../../src/lib/supabase/admin";
import { bookAppointment } from "../../src/lib/tools/book-appointment";
import { checkAvailability } from "../../src/lib/tools/check-availability";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

describe("Tool: book_appointment", () => {
  let clinicAId: string;
  let clinicBId: string;
  let doctorA1Id: string; // Dr. Priya Sharma
  let doctorB1Id: string; // Clinic B Doctor

  let targetMonday: DateTime;
  let targetMondayDateStr: string;

  const createdAppointmentIds = new Set<string>();
  const createdPatientIds = new Set<string>();

  beforeAll(async () => {
    const supabase = getAdminClient();

    // Fetch clinics
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

    // Fetch doctors
    const { data: docA1 } = await supabase
      .from("doctors")
      .select("id")
      .eq("clinic_id", clinicAId)
      .eq("name", "Dr. Priya Sharma")
      .single();
    doctorA1Id = docA1!.id;

    const { data: docB1 } = await supabase
      .from("doctors")
      .select("id")
      .eq("clinic_id", clinicBId)
      .single();
    doctorB1Id = docB1!.id;

    // Compute next Monday at least 14 days ahead so we have plenty of future runway
    let candidate = DateTime.now().setZone("Asia/Kolkata").plus({ days: 14 }).startOf("day");
    while (candidate.weekday !== 1) {
      candidate = candidate.plus({ days: 1 });
    }
    targetMonday = candidate;
    targetMondayDateStr = candidate.toISODate()!;
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

  it("books a free slot successfully and verifies row attributes", async () => {
    const supabase = getAdminClient();
    const slotStart = targetMonday.set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
    const slotStartIso = slotStart.toUTC().toISO()!;

    const result = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "Amit Patel",
      patient_phone: "9820011111",
      start_at: slotStartIso,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    createdAppointmentIds.add(result.data.id);

    expect(result.data.doctor_name).toBe("Dr. Priya Sharma");
    expect(result.data.patient_name).toBe("Amit Patel");
    expect(result.data.start_at).toBe(slotStartIso);
    // Doctor A1 has 15 min slots: 09:00 -> 09:15
    const expectedEndIso = slotStart.plus({ minutes: 15 }).toUTC().toISO()!;
    expect(result.data.end_at).toBe(expectedEndIso);
    expect(result.data.label).toBe(slotStart.toFormat("ccc d LLL, h:mm a"));

    // Verify row directly in DB
    const { data: apptRow } = await supabase
      .from("appointments")
      .select("id, clinic_id, doctor_id, patient_id, start_at, end_at, status, created_via")
      .eq("id", result.data.id)
      .single();

    expect(apptRow).not.toBeNull();
    expect(apptRow!.clinic_id).toBe(clinicAId);
    expect(apptRow!.doctor_id).toBe(doctorA1Id);
    expect(apptRow!.status).toBe("booked");
    expect(apptRow!.created_via).toBe("ai");
    createdPatientIds.add(apptRow!.patient_id);
  });

  it("ensures the booked slot is absent from check_availability", async () => {
    const slotStart = targetMonday.set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
    const slotStartIso = slotStart.toUTC().toISO()!;

    const availability = await checkAvailability(clinicAId, {
      doctor_id: doctorA1Id,
      date: targetMondayDateStr,
    });

    expect(availability.ok).toBe(true);
    if (!availability.ok) return;

    const startTimes = availability.data.map((s) => s.start_at);
    expect(startTimes).not.toContain(slotStartIso);
  });

  it("CONCURRENCY: 5 simultaneous bookings for the same slot -> 1 succeeds, 4 return SLOT_TAKEN, exactly 1 row in DB and no extra patients", async () => {
    const supabase = getAdminClient();
    const concurrentSlot = targetMonday.set({ hour: 11, minute: 0, second: 0, millisecond: 0 });
    const slotStartIso = concurrentSlot.toUTC().toISO()!;

    const phones = [
      "9820020001",
      "9820020002",
      "9820020003",
      "9820020004",
      "9820020005",
    ];

    const promises = phones.map((phone, idx) =>
      bookAppointment(clinicAId, {
        doctor_id: doctorA1Id,
        patient_name: `Concurrent Patient ${idx + 1}`,
        patient_phone: phone,
        start_at: slotStartIso,
      })
    );

    const results = await Promise.all(promises);

    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(4);

    if (successes[0].ok) {
      createdAppointmentIds.add(successes[0].data.id);
    }

    // Every loser must specifically return error: "SLOT_TAKEN"
    for (const failure of failures) {
      if (!failure.ok) {
        expect(failure.error).toBe("SLOT_TAKEN");
        expect(failure.data).toHaveProperty("next_slots");
        expect(Array.isArray(failure.data?.next_slots)).toBe(true);
      }
    }

    // Assert exactly 1 appointment row exists in DB for this slot
    const { data: dbRows } = await supabase
      .from("appointments")
      .select("id, patient_id")
      .eq("doctor_id", doctorA1Id)
      .eq("start_at", slotStartIso)
      .eq("status", "booked");

    expect(dbRows).toHaveLength(1);
    createdPatientIds.add(dbRows![0].patient_id);

    // Assert that the 4 losers cleaned up their patient rows, so only 1 patient exists for these 5 phones
    const normalizedPhones = phones.map((p) => `+91${p}`);
    const { data: patientRows } = await supabase
      .from("patients")
      .select("id, phone")
      .in("phone", normalizedPhones)
      .eq("clinic_id", clinicAId);

    expect(patientRows).toHaveLength(1);
    expect(patientRows![0].id).toBe(dbRows![0].patient_id);
  });

  it("same patient phone booked twice for different slots creates only 1 patient row", async () => {
    const supabase = getAdminClient();
    const phone = "9820033333";
    const slot1 = targetMonday.set({ hour: 12, minute: 0, second: 0, millisecond: 0 }).toUTC().toISO()!;
    const slot2 = targetMonday.set({ hour: 12, minute: 15, second: 0, millisecond: 0 }).toUTC().toISO()!;

    const res1 = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "Repeat Patient",
      patient_phone: phone,
      start_at: slot1,
    });
    expect(res1.ok).toBe(true);
    if (res1.ok) createdAppointmentIds.add(res1.data.id);

    const res2 = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "Repeat Patient",
      patient_phone: phone,
      start_at: slot2,
    });
    expect(res2.ok).toBe(true);
    if (res2.ok) createdAppointmentIds.add(res2.data.id);

    const { data: patientRows } = await supabase
      .from("patients")
      .select("id")
      .eq("clinic_id", clinicAId)
      .eq("phone", `+91${phone}`);

    expect(patientRows).toHaveLength(1);
    createdPatientIds.add(patientRows![0].id);
  });

  it("preserves existing patient name in database, while confirmation echoes request name", async () => {
    const supabase = getAdminClient();
    const phone = "9820044444";
    const slot = targetMonday.set({ hour: 13, minute: 0, second: 0, millisecond: 0 }).toUTC().toISO()!;

    // 1. First booking
    const res1 = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "Original Stored Name",
      patient_phone: phone,
      start_at: slot,
    });
    expect(res1.ok).toBe(true);
    if (res1.ok) createdAppointmentIds.add(res1.data.id);

    // 2. Second booking with different name for the same phone
    const slot2 = targetMonday.set({ hour: 13, minute: 15, second: 0, millisecond: 0 }).toUTC().toISO()!;
    const res2 = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "New Transient Name",
      patient_phone: phone,
      start_at: slot2,
    });
    expect(res2.ok).toBe(true);
    if (res2.ok) {
      createdAppointmentIds.add(res2.data.id);
      // Confirmation echoes the requested name
      expect(res2.data.patient_name).toBe("New Transient Name");
    }

    // Verify DB still holds the original name
    const { data: patientRow } = await supabase
      .from("patients")
      .select("id, name")
      .eq("clinic_id", clinicAId)
      .eq("phone", `+91${phone}`)
      .single();

    expect(patientRow!.name).toBe("Original Stored Name");
    createdPatientIds.add(patientRow!.id);
  });

  it("phone variants '9876543210', '+91 98765 43210', and '919876543210' resolve to the same patient", async () => {
    const supabase = getAdminClient();
    const slot = targetMonday.set({ hour: 14, minute: 0, second: 0, millisecond: 0 }).toUTC().toISO()!;

    // Initial booking
    const res = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "Variant Test",
      patient_phone: "9876500001",
      start_at: slot,
    });
    expect(res.ok).toBe(true);
    if (res.ok) createdAppointmentIds.add(res.data.id);

    const slot2 = targetMonday.set({ hour: 14, minute: 15, second: 0, millisecond: 0 }).toUTC().toISO()!;
    const res2 = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "Variant Test 2",
      patient_phone: "+91 98765 00001",
      start_at: slot2,
    });
    expect(res2.ok).toBe(true);
    if (res2.ok) createdAppointmentIds.add(res2.data.id);

    const slot3 = targetMonday.set({ hour: 14, minute: 30, second: 0, millisecond: 0 }).toUTC().toISO()!;
    const res3 = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "Variant Test 3",
      patient_phone: "919876500001",
      start_at: slot3,
    });
    expect(res3.ok).toBe(true);
    if (res3.ok) createdAppointmentIds.add(res3.data.id);

    const { data: patients } = await supabase
      .from("patients")
      .select("id, phone")
      .eq("clinic_id", clinicAId)
      .eq("phone", "+919876500001");

    expect(patients).toHaveLength(1);
    createdPatientIds.add(patients![0].id);
  });

  it("TOO_MANY_BOOKINGS: enforces maximum 3 active future bookings per patient", async () => {
    const phone = "9820055555";
    const slot1 = targetMonday.set({ hour: 15, minute: 0, second: 0, millisecond: 0 }).toUTC().toISO()!;
    const slot2 = targetMonday.set({ hour: 15, minute: 15, second: 0, millisecond: 0 }).toUTC().toISO()!;
    const slot3 = targetMonday.set({ hour: 15, minute: 30, second: 0, millisecond: 0 }).toUTC().toISO()!;
    const slot4 = targetMonday.set({ hour: 15, minute: 45, second: 0, millisecond: 0 }).toUTC().toISO()!;

    const b1 = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "Multi Booker",
      patient_phone: phone,
      start_at: slot1,
    });
    expect(b1.ok).toBe(true);
    if (b1.ok) createdAppointmentIds.add(b1.data.id);

    const b2 = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "Multi Booker",
      patient_phone: phone,
      start_at: slot2,
    });
    expect(b2.ok).toBe(true);
    if (b2.ok) createdAppointmentIds.add(b2.data.id);

    const b3 = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "Multi Booker",
      patient_phone: phone,
      start_at: slot3,
    });
    expect(b3.ok).toBe(true);
    if (b3.ok) createdAppointmentIds.add(b3.data.id);

    // 4th attempt must be rejected with TOO_MANY_BOOKINGS
    const b4 = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "Multi Booker",
      patient_phone: phone,
      start_at: slot4,
    });

    expect(b4.ok).toBe(false);
    if (b4.ok) return;
    expect(b4.error).toBe("TOO_MANY_BOOKINGS");

    const supabase = getAdminClient();
    const { data: patient } = await supabase
      .from("patients")
      .select("id")
      .eq("clinic_id", clinicAId)
      .eq("phone", `+91${phone}`)
      .single();
    if (patient) createdPatientIds.add(patient.id);
  });

  it("slot not on grid (e.g. 10:07) returns INVALID_SLOT", async () => {
    const offGridSlot = targetMonday.set({ hour: 10, minute: 7, second: 0, millisecond: 0 }).toUTC().toISO()!;

    const result = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "Off Grid Patient",
      patient_phone: "9820066666",
      start_at: offGridSlot,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("INVALID_SLOT");
  });

  it("past slot returns INVALID_SLOT", async () => {
    const pastSlot = DateTime.now().setZone("Asia/Kolkata").minus({ days: 2 }).set({ hour: 10, minute: 0 }).toUTC().toISO()!;

    const result = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "Past Patient",
      patient_phone: "9820066666",
      start_at: pastSlot,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("INVALID_SLOT");
  });

  it("date beyond 60 days returns DATE_TOO_FAR", async () => {
    const farSlot = DateTime.now().setZone("Asia/Kolkata").plus({ days: 65 }).set({ hour: 10, minute: 0 }).toUTC().toISO()!;

    const result = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "Far Patient",
      patient_phone: "9820066666",
      start_at: farSlot,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("DATE_TOO_FAR");
  });

  it("doctor from another clinic returns DOCTOR_NOT_FOUND and creates no rows", async () => {
    const supabase = getAdminClient();
    const slot = targetMonday.set({ hour: 16, minute: 0, second: 0, millisecond: 0 }).toUTC().toISO()!;

    const result = await bookAppointment(clinicAId, {
      doctor_id: doctorB1Id,
      patient_name: "Cross Tenant",
      patient_phone: "9820077777",
      start_at: slot,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("DOCTOR_NOT_FOUND");

    // Verify 0 appointments created
    const { data: appts } = await supabase
      .from("appointments")
      .select("id")
      .eq("start_at", slot);
    expect(appts).toHaveLength(0);
  });

  it("rejects invalid phone numbers with INVALID_PHONE", async () => {
    const slot = targetMonday.set({ hour: 16, minute: 15, second: 0, millisecond: 0 }).toUTC().toISO()!;

    const badPhones = [
      "12345",              // too short
      "5876543210",         // starts with 5
      "98765abcd0",         // contains letters
      "+1 9876543210",      // US prefix
      "91987654321099",     // too long
      "",                   // empty
    ];

    for (const badPhone of badPhones) {
      const res = await bookAppointment(clinicAId, {
        doctor_id: doctorA1Id,
        patient_name: "Bad Phone",
        patient_phone: badPhone,
        start_at: slot,
      });

      expect(res.ok).toBe(false);
      if (res.ok) continue;
      expect(["INVALID_PHONE", "INVALID_INPUT"]).toContain(res.error);
    }
  });
});

