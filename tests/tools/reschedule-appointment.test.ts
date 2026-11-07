import * as dotenv from "dotenv";
import { DateTime } from "luxon";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAdminClient } from "../../src/lib/supabase/admin";
import { bookAppointment } from "../../src/lib/tools/book-appointment";
import { checkAvailability } from "../../src/lib/tools/check-availability";
import { rescheduleAppointment } from "../../src/lib/tools/reschedule-appointment";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

describe("Tool: reschedule_appointment", () => {
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

    // Use Monday 21 days ahead so slots do not collide with other test suites
    let candidate = DateTime.now().setZone("Asia/Kolkata").plus({ days: 21 }).startOf("day");
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

  it("success moves the appointment atomically and the old slot becomes free again", async () => {
    const phone = "9820300001";
    const oldSlot = mondayDate.set({ hour: 9, minute: 0 }).toUTC().toISO()!;
    const newSlot = mondayDate.set({ hour: 9, minute: 15 }).toUTC().toISO()!;

    // 1. Book initial slot
    const bookRes = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "Reschedule User",
      patient_phone: phone,
      start_at: oldSlot,
    });
    expect(bookRes.ok).toBe(true);
    if (!bookRes.ok) return;

    const appointmentId = bookRes.data.id;
    createdAppointmentIds.add(appointmentId);

    // 2. Reschedule to newSlot
    const res = await rescheduleAppointment(clinicAId, {
      appointment_id: appointmentId,
      patient_phone: phone,
      new_start_at: newSlot,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.data.doctor_name).toBe("Dr. Priya Sharma");
    expect(res.data.start_at).toBe(newSlot);
    expect(res.data.old_label).toBe(mondayDate.set({ hour: 9, minute: 0 }).toFormat("ccc d LLL, h:mm a"));
    expect(res.data.new_label).toBe(mondayDate.set({ hour: 9, minute: 15 }).toFormat("ccc d LLL, h:mm a"));

    // 3. Verify in check_availability that oldSlot is free and newSlot is taken
    const avail = await checkAvailability(clinicAId, {
      doctor_id: doctorA1Id,
      date: mondayDate.toISODate()!,
    });
    expect(avail.ok).toBe(true);
    if (avail.ok) {
      const freeSlots = avail.data.map((s) => s.start_at);
      expect(freeSlots).toContain(oldSlot);
      expect(freeSlots).not.toContain(newSlot);
    }
  });

  it("target slot taken returns SLOT_TAKEN with next_slots and original appointment is unchanged", async () => {
    const phoneA = "9820300002";
    const phoneB = "9820300003";
    const slotA = mondayDate.set({ hour: 10, minute: 0 }).toUTC().toISO()!;
    const slotB = mondayDate.set({ hour: 10, minute: 15 }).toUTC().toISO()!;

    // Book slot A
    const apptA = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "User A",
      patient_phone: phoneA,
      start_at: slotA,
    });
    expect(apptA.ok).toBe(true);
    if (!apptA.ok) return;
    createdAppointmentIds.add(apptA.data.id);

    // Book slot B for another user
    const apptB = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "User B",
      patient_phone: phoneB,
      start_at: slotB,
    });
    expect(apptB.ok).toBe(true);
    if (!apptB.ok) return;
    createdAppointmentIds.add(apptB.data.id);

    // Attempt to reschedule apptA to slotB (which is taken)
    const res = await rescheduleAppointment(clinicAId, {
      appointment_id: apptA.data.id,
      patient_phone: phoneA,
      new_start_at: slotB,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("SLOT_TAKEN");
    expect(res.data).toHaveProperty("next_slots");
    expect(Array.isArray(res.data?.next_slots)).toBe(true);

    // Verify original appointment remains unchanged at slotA
    const supabase = getAdminClient();
    const { data: dbRow } = await supabase
      .from("appointments")
      .select("start_at")
      .eq("id", apptA.data.id)
      .single();
    expect(new Date(dbRow!.start_at).getTime()).toBe(new Date(slotA).getTime());
  });

  it("rejects rescheduling to the exact same slot with INVALID_SLOT", async () => {
    const phone = "9820300004";
    const slot = mondayDate.set({ hour: 11, minute: 0 }).toUTC().toISO()!;
    const appt = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "Same Slot Target",
      patient_phone: phone,
      start_at: slot,
    });
    expect(appt.ok).toBe(true);
    if (!appt.ok) return;
    createdAppointmentIds.add(appt.data.id);

    const res = await rescheduleAppointment(clinicAId, {
      appointment_id: appt.data.id,
      patient_phone: phone,
      new_start_at: slot,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("INVALID_SLOT");
  });

  it("off-grid slot returns INVALID_SLOT", async () => {
    const phone = "9820300005";
    const slot = mondayDate.set({ hour: 11, minute: 15 }).toUTC().toISO()!;
    const appt = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "Off Grid Target",
      patient_phone: phone,
      start_at: slot,
    });
    expect(appt.ok).toBe(true);
    if (!appt.ok) return;
    createdAppointmentIds.add(appt.data.id);

    const offGridSlot = mondayDate.set({ hour: 11, minute: 23 }).toUTC().toISO()!;
    const res = await rescheduleAppointment(clinicAId, {
      appointment_id: appt.data.id,
      patient_phone: phone,
      new_start_at: offGridSlot,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("INVALID_SLOT");
  });

  it("wrong phone number returns APPOINTMENT_NOT_FOUND", async () => {
    const phone = "9820300006";
    const slot = mondayDate.set({ hour: 11, minute: 30 }).toUTC().toISO()!;
    const appt = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "Phone Target",
      patient_phone: phone,
      start_at: slot,
    });
    expect(appt.ok).toBe(true);
    if (!appt.ok) return;
    createdAppointmentIds.add(appt.data.id);

    const targetSlot = mondayDate.set({ hour: 11, minute: 45 }).toUTC().toISO()!;
    const res = await rescheduleAppointment(clinicAId, {
      appointment_id: appt.data.id,
      patient_phone: "9820399999",
      new_start_at: targetSlot,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("APPOINTMENT_NOT_FOUND");
  });

  it("CONCURRENCY: two different appointments rescheduled to the same free slot -> exactly one succeeds, the other returns SLOT_TAKEN", async () => {
    const slot1 = mondayDate.set({ hour: 13, minute: 0 }).toUTC().toISO()!;
    const slot2 = mondayDate.set({ hour: 13, minute: 15 }).toUTC().toISO()!;
    const targetSlot = mondayDate.set({ hour: 14, minute: 0 }).toUTC().toISO()!;

    // Book appointment 1
    const appt1 = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "Racer 1",
      patient_phone: "9820300011",
      start_at: slot1,
    });
    expect(appt1.ok).toBe(true);
    if (!appt1.ok) return;
    createdAppointmentIds.add(appt1.data.id);

    // Book appointment 2
    const appt2 = await bookAppointment(clinicAId, {
      doctor_id: doctorA1Id,
      patient_name: "Racer 2",
      patient_phone: "9820300022",
      start_at: slot2,
    });
    expect(appt2.ok).toBe(true);
    if (!appt2.ok) return;
    createdAppointmentIds.add(appt2.data.id);

    // Concurrently reschedule both to targetSlot
    const [r1, r2] = await Promise.all([
      rescheduleAppointment(clinicAId, {
        appointment_id: appt1.data.id,
        patient_phone: "9820300011",
        new_start_at: targetSlot,
      }),
      rescheduleAppointment(clinicAId, {
        appointment_id: appt2.data.id,
        patient_phone: "9820300022",
        new_start_at: targetSlot,
      }),
    ]);

    const successes = [r1, r2].filter((r) => r.ok);
    const failures = [r1, r2].filter((r) => !r.ok && r.error === "SLOT_TAKEN");

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    // Assert that exactly one booked appointment exists at targetSlot in database
    const supabase = getAdminClient();
    const { data: dbRows } = await supabase
      .from("appointments")
      .select("id")
      .eq("doctor_id", doctorA1Id)
      .eq("start_at", targetSlot)
      .eq("status", "booked");

    expect(dbRows).toHaveLength(1);
  });
});
