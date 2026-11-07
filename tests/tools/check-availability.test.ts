import * as dotenv from "dotenv";
import { DateTime } from "luxon";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAdminClient } from "../../src/lib/supabase/admin";
import { checkAvailability } from "../../src/lib/tools/check-availability";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

describe("Tool: check_availability", () => {
  let clinicAId: string;
  let clinicBId: string;
  let doctorA1Id: string; // Dr. Priya Sharma (Cardiology) - Mon-Sat 09:00 - 17:00, 15 min slots
  let doctorB1Id: string; // Dr. Anjali Singh (Clinic B)

  let testPatientId: string | null = null;
  let bookedApptId: string | null = null;
  let testMondayDateStr: string;
  let bookedSlotStartUtc: string;

  beforeAll(async () => {
    const supabase = getAdminClient();

    // 1. Fetch clinics
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

    // 2. Fetch doctors
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

    // 3. Compute dynamic Monday at least 7 days ahead (within 60-day limit)
    let candidate = DateTime.now().setZone("Asia/Kolkata").plus({ days: 7 }).startOf("day");
    while (candidate.weekday !== 1) {
      // 1 = Monday in Luxon
      candidate = candidate.plus({ days: 1 });
    }
    testMondayDateStr = candidate.toISODate()!;

    // 4. Create a temporary patient and a booked appointment for 10:00 - 10:15 AM
    const bookedLocalStart = candidate.set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
    const bookedLocalEnd = candidate.set({ hour: 10, minute: 15, second: 0, millisecond: 0 });
    bookedSlotStartUtc = bookedLocalStart.toUTC().toISO()!;

    const { data: patient, error: patientErr } = await supabase
      .from("patients")
      .insert({
        clinic_id: clinicAId,
        name: "Vitest Temp Patient",
        phone: "+919876543210",
      })
      .select("id")
      .single();
    if (patientErr) throw new Error(`Failed to create test patient: ${patientErr.message}`);
    testPatientId = patient.id;

    const { data: appt, error: apptErr } = await supabase
      .from("appointments")
      .insert({
        clinic_id: clinicAId,
        doctor_id: doctorA1Id,
        patient_id: testPatientId,
        start_at: bookedSlotStartUtc,
        end_at: bookedLocalEnd.toUTC().toISO()!,
        status: "booked",
        created_via: "staff",
      })
      .select("id")
      .single();
    if (apptErr) throw new Error(`Failed to create test booked appointment: ${apptErr.message}`);
    bookedApptId = appt.id;
  });

  afterAll(async () => {
    const supabase = getAdminClient();
    if (bookedApptId) {
      await supabase.from("appointments").delete().eq("id", bookedApptId);
    }
    if (testPatientId) {
      await supabase.from("patients").delete().eq("id", testPatientId);
    }
  });

  it("returns correct slot count and excludes the booked slot for a seeded schedule", async () => {
    // Schedule for Doctor A1 on Monday is 09:00 - 17:00, 15 min slots = 32 total slots.
    // 1 slot (10:00 AM) is booked, so 31 slots should be available.
    const result = await checkAvailability(clinicAId, {
      doctor_id: doctorA1Id,
      date: testMondayDateStr,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data).toHaveLength(31);

    // Booked slot at 10:00 AM must be excluded
    const labels = result.data.map((s) => s.label);
    expect(labels).not.toContain("10:00 AM");
    expect(labels).toContain("9:45 AM");
    expect(labels).toContain("10:15 AM");

    // The booked UTC start time must not appear
    const startAts = result.data.map((s) => s.start_at);
    expect(startAts).not.toContain(bookedSlotStartUtc);

    // Check first slot formatting
    const firstSlot = result.data[0];
    expect(firstSlot.label).toBe("9:00 AM");
    // 9:00 AM IST (+05:30) is 03:30 UTC
    expect(firstSlot.start_at).toMatch(/T03:30:00/);
    expect(firstSlot.end_at).toMatch(/T03:45:00/);
  });

  it("returns an empty list for Sunday when doctor has no schedule", async () => {
    // Find next Sunday relative to today
    let sunday = DateTime.now().setZone("Asia/Kolkata").plus({ days: 1 }).startOf("day");
    while (sunday.weekday !== 7) {
      sunday = sunday.plus({ days: 1 });
    }
    const sundayStr = sunday.toISODate()!;

    const result = await checkAvailability(clinicAId, {
      doctor_id: doctorA1Id,
      date: sundayStr,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([]);
  });

  it("returns an empty list for past dates", async () => {
    const pastDate = DateTime.now().setZone("Asia/Kolkata").minus({ days: 5 }).toISODate()!;

    const result = await checkAvailability(clinicAId, {
      doctor_id: doctorA1Id,
      date: pastDate,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([]);
  });

  it("rejects dates more than 60 days in advance with DATE_TOO_FAR", async () => {
    const farDate = DateTime.now().setZone("Asia/Kolkata").plus({ days: 65 }).toISODate()!;

    const result = await checkAvailability(clinicAId, {
      doctor_id: doctorA1Id,
      date: farDate,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("DATE_TOO_FAR");
  });

  it("returns DOCTOR_NOT_FOUND when doctor belongs to another clinic", async () => {
    const result = await checkAvailability(clinicAId, {
      doctor_id: doctorB1Id,
      date: testMondayDateStr,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("DOCTOR_NOT_FOUND");
  });

  it("returns INVALID_INPUT when date is not a real calendar date (e.g. 2026-02-31)", async () => {
    const result = await checkAvailability(clinicAId, {
      doctor_id: doctorA1Id,
      date: "2026-02-31",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("INVALID_INPUT");
  });

  it("removes slots earlier than 'now' on the same day via optional now parameter", async () => {
    // Pick the future test Monday and simulate "now" as 11:30 AM local time
    const mondayStart = DateTime.fromISO(testMondayDateStr, { zone: "Asia/Kolkata" }).startOf("day");
    const mockNow = mondayStart.set({ hour: 11, minute: 30, second: 0, millisecond: 0 });

    const result = await checkAvailability(
      clinicAId,
      {
        doctor_id: doctorA1Id,
        date: testMondayDateStr,
      },
      mockNow
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Slots strictly earlier than 11:30 AM (9:00 to 11:15) must not be present
    const labels = result.data.map((s) => s.label);
    expect(labels).not.toContain("9:00 AM");
    expect(labels).not.toContain("10:15 AM");
    expect(labels).not.toContain("11:15 AM");

    // Slot at 11:30 AM and later must be present
    expect(labels).toContain("11:30 AM");
    expect(labels[0]).toBe("11:30 AM");

    // Every remaining slot must have start_at >= mockNow in UTC
    const mockNowUtc = mockNow.toUTC().toISO()!;
    for (const slot of result.data) {
      expect(slot.start_at >= mockNowUtc).toBe(true);
    }
  });
});

