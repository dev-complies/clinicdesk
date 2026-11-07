/**
 * scripts/seed.ts
 *
 * Idempotent seed script for ClinicDesk Week 1, Part C.
 * Run with:  npx tsx scripts/seed.ts
 *
 * Uses the service-role key exclusively — never the anon key — so that
 * RLS is bypassed for setup work. The anon key is never read here.
 *
 * Re-run safety:
 *  - Tables with a unique constraint use ON CONFLICT DO NOTHING via upsert.
 *  - Tables without a unique constraint use select-then-insert.
 *  - Auth users are created with admin.createUser; a 422 / "already exists"
 *    response is caught and the existing user id is fetched instead.
 *
 * Passwords and keys are NEVER printed.
 */

import * as dotenv from "dotenv";
import path from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Load .env.local relative to repo root (the cwd when running via npm/npx)
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

// ── env validation ────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name]?.trim();
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const SUPABASE_URL = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const CLINIC_A_EMAIL = requireEnv("SEED_CLINIC_A_EMAIL");
const CLINIC_B_EMAIL = requireEnv("SEED_CLINIC_B_EMAIL");
const SEED_PASSWORD = requireEnv("SEED_PASSWORD");

// ── service-role client (bypasses RLS — server-side only) ─────────────────────

const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── helpers ───────────────────────────────────────────────────────────────────

function abort(msg: string, err: unknown): never {
  console.error(`[seed] ERROR — ${msg}`, err);
  process.exit(1);
}

/** Select-then-insert for tables with no unique constraint on a natural key.
 *  Returns the existing or newly created row. */
async function selectOrInsert<T extends Record<string, unknown>>(
  table: string,
  matchCols: Partial<T>,
  insertData: T,
): Promise<T> {
  const query = admin.from(table).select("*");
  for (const [col, val] of Object.entries(matchCols)) {
    (query as any).eq(col, val);
  }
  const { data: existing, error: selErr } = await query.limit(1).single<T>();

  if (selErr && selErr.code !== "PGRST116") {
    // PGRST116 = "no rows found"; anything else is a real error
    abort(`SELECT from ${table}`, selErr);
  }

  if (existing) {
    console.log(`[seed] ${table}: found existing row`);
    return existing;
  }

  const { data: created, error: insErr } = await admin
    .from(table)
    .insert(insertData)
    .select()
    .single<T>();

  if (insErr) abort(`INSERT into ${table}`, insErr);
  console.log(`[seed] ${table}: inserted new row`);
  return created!;
}

/** Create an auth user and return their id.
 *  If the user already exists (422 or duplicate error) fetch and return the
 *  existing id via admin.auth.admin.listUsers.
 *  The password is NEVER logged. */
async function ensureAuthUser(email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: SEED_PASSWORD,
    email_confirm: true,
  });

  if (!error) {
    console.log(`[seed] auth.users: created user ${email}`);
    return data.user.id;
  }

  // 422 / "User already registered" — fetch the existing user instead
  if (
    error.status === 422 ||
    error.message?.toLowerCase().includes("already") ||
    error.message?.toLowerCase().includes("duplicate")
  ) {
    console.log(`[seed] auth.users: user ${email} already exists, reusing`);
    // List users and find by email (admin API, server-side only)
    const { data: list, error: listErr } =
      await admin.auth.admin.listUsers({ perPage: 1000 });
    if (listErr) abort("listUsers", listErr);
    const found = list.users.find((u) => u.email === email);
    if (!found)
      abort(
        `Could not find existing user after duplicate error for ${email}`,
        error,
      );
    return found.id;
  }

  abort(`createUser(${email})`, error);
}

/** Upsert a staff_users row keyed on (clinic_id, email).
 *  staff_users has unique(clinic_id, email) so we can use ON CONFLICT DO NOTHING.
 *  staff_users.id must equal the auth user's UUID for current_clinic_id() to work. */
async function ensureStaffUser(
  authUserId: string,
  clinicId: string,
  email: string,
  role: "owner" | "staff",
): Promise<void> {
  const { error } = await admin.from("staff_users").upsert(
    { id: authUserId, clinic_id: clinicId, email, role },
    { onConflict: "clinic_id,email", ignoreDuplicates: true },
  );
  if (error) abort("upsert staff_users", error);
  console.log(`[seed] staff_users: upserted ${email}`);
}

// ── weekday schedule helper ───────────────────────────────────────────────────

/**
 * Seeds Mon–Sat (weekdays 1–6, matching JS Date.getDay()) schedules for a doctor.
 * doctor_schedules has no unique constraint, so we use select-then-insert per weekday.
 */
async function ensureSchedules(
  doctorId: string,
  clinicId: string,
  weekdays: number[],
  startTime: string,
  endTime: string,
  slotMinutes: number,
): Promise<void> {
  for (const weekday of weekdays) {
    const { data: existing, error: selErr } = await admin
      .from("doctor_schedules")
      .select("id")
      .eq("doctor_id", doctorId)
      .eq("weekday", weekday)
      .limit(1)
      .maybeSingle();

    if (selErr) abort(`SELECT doctor_schedules weekday=${weekday}`, selErr);
    if (existing) continue; // already seeded

    const { error: insErr } = await admin.from("doctor_schedules").insert({
      clinic_id: clinicId,
      doctor_id: doctorId,
      weekday,
      start_time: startTime,
      end_time: endTime,
      slot_minutes: slotMinutes,
    });
    if (insErr) abort(`INSERT doctor_schedules weekday=${weekday}`, insErr);
  }
  console.log(`[seed] doctor_schedules: ensured for doctor ${doctorId}`);
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("[seed] Starting ClinicDesk seed...");

  // ── Clinic A ───────────────────────────────────────────────────────────────

  // 1. Clinic A — no unique constraint on name, use select-then-insert
  const clinicA = await selectOrInsert<{
    id: string;
    name: string;
    timezone: string;
    languages: string[];
    handoff_phone: string;
    created_at: string;
  }>(
    "clinics",
    { name: "Demo Clinic A" },
    {
      id: undefined as unknown as string,
      name: "Demo Clinic A",
      timezone: "Asia/Kolkata",
      languages: ["en", "hi"],
      handoff_phone: "+919000000001",
      created_at: new Date().toISOString(),
    },
  );
  const clinicAId = clinicA.id;
  console.log(`[seed] Clinic A id: ${clinicAId}`);

  // 2. Auth user A + staff_users row
  const authAId = await ensureAuthUser(CLINIC_A_EMAIL);
  await ensureStaffUser(authAId, clinicAId, CLINIC_A_EMAIL, "owner");

  // 3. Doctor A1 — Cardiology
  const doctorA1 = await selectOrInsert<{
    id: string;
    clinic_id: string;
    name: string;
    speciality: string;
    fee: number;
    active: boolean;
    created_at: string;
  }>(
    "doctors",
    { clinic_id: clinicAId, name: "Dr. Priya Sharma" },
    {
      id: undefined as unknown as string,
      clinic_id: clinicAId,
      name: "Dr. Priya Sharma",
      speciality: "Cardiology",
      fee: 800,
      active: true,
      created_at: new Date().toISOString(),
    },
  );

  // 4. Doctor A2 — Orthopedics
  const doctorA2 = await selectOrInsert<{
    id: string;
    clinic_id: string;
    name: string;
    speciality: string;
    fee: number;
    active: boolean;
    created_at: string;
  }>(
    "doctors",
    { clinic_id: clinicAId, name: "Dr. Rahul Mehta" },
    {
      id: undefined as unknown as string,
      clinic_id: clinicAId,
      name: "Dr. Rahul Mehta",
      speciality: "Orthopedics",
      fee: 600,
      active: true,
      created_at: new Date().toISOString(),
    },
  );

  // Mon–Sat = weekdays 1–6 (JS Date.getDay() convention documented in schema)
  const MON_TO_SAT = [1, 2, 3, 4, 5, 6];
  await ensureSchedules(doctorA1.id, clinicAId, MON_TO_SAT, "09:00", "17:00", 15);
  await ensureSchedules(doctorA2.id, clinicAId, MON_TO_SAT, "10:00", "18:00", 15);

  // ── Clinic B ───────────────────────────────────────────────────────────────

  // 5. Clinic B — no unique constraint on name, use select-then-insert
  const clinicB = await selectOrInsert<{
    id: string;
    name: string;
    timezone: string;
    languages: string[];
    handoff_phone: string;
    created_at: string;
  }>(
    "clinics",
    { name: "Demo Clinic B" },
    {
      id: undefined as unknown as string,
      name: "Demo Clinic B",
      timezone: "Asia/Kolkata",
      languages: ["en"],
      handoff_phone: "+919000000002",
      created_at: new Date().toISOString(),
    },
  );
  const clinicBId = clinicB.id;
  console.log(`[seed] Clinic B id: ${clinicBId}`);

  // 6. Auth user B + staff_users row
  const authBId = await ensureAuthUser(CLINIC_B_EMAIL);
  await ensureStaffUser(authBId, clinicBId, CLINIC_B_EMAIL, "owner");

  // 7. Doctor B1 — General Physician
  const doctorB1 = await selectOrInsert<{
    id: string;
    clinic_id: string;
    name: string;
    speciality: string;
    fee: number;
    active: boolean;
    created_at: string;
  }>(
    "doctors",
    { clinic_id: clinicBId, name: "Dr. Anjali Singh" },
    {
      id: undefined as unknown as string,
      clinic_id: clinicBId,
      name: "Dr. Anjali Singh",
      speciality: "General Physician",
      fee: 400,
      active: true,
      created_at: new Date().toISOString(),
    },
  );
  await ensureSchedules(doctorB1.id, clinicBId, MON_TO_SAT, "09:00", "13:00", 15);

  // 8. Patient B — unique(clinic_id, phone) exists, safe to upsert
  const { data: patientB, error: patientErr } = await admin
    .from("patients")
    .upsert(
      {
        clinic_id: clinicBId,
        name: "Ramesh Kumar",
        phone: "+919111111111",
      },
      { onConflict: "clinic_id,phone", ignoreDuplicates: false },
    )
    .select()
    .single();
  if (patientErr) abort("upsert patients (Clinic B)", patientErr);
  console.log(`[seed] patients: upserted patient ${patientB!.id}`);

  // 9. Appointment B — partial unique on (doctor_id, start_at) WHERE status='booked'.
  //    Use select-then-insert to stay idempotent without touching the index constraint.
  const apptStartAt = "2027-01-15T09:00:00+05:30";
  const apptEndAt   = "2027-01-15T09:15:00+05:30";

  const { data: existingAppt, error: apptSelErr } = await admin
    .from("appointments")
    .select("id")
    .eq("patient_id", patientB!.id)
    .limit(1)
    .maybeSingle();
  if (apptSelErr) abort("SELECT appointments (Clinic B)", apptSelErr);

  let appointmentBId: string;
  if (existingAppt) {
    console.log(`[seed] appointments: found existing appointment ${existingAppt.id}`);
    appointmentBId = existingAppt.id;
  } else {
    const { data: newAppt, error: apptInsErr } = await admin
      .from("appointments")
      .insert({
        clinic_id: clinicBId,
        doctor_id: doctorB1.id,
        patient_id: patientB!.id,
        start_at: apptStartAt,
        end_at:   apptEndAt,
        status: "booked",
        created_via: "staff",
      })
      .select()
      .single();
    if (apptInsErr) abort("INSERT appointments (Clinic B)", apptInsErr);
    console.log(`[seed] appointments: inserted ${newAppt!.id}`);
    appointmentBId = newAppt!.id;
  }

  // 10. Conversation B — no unique constraint; select-then-insert
  const { data: existingConv, error: convSelErr } = await admin
    .from("conversations")
    .select("id")
    .eq("clinic_id", clinicBId)
    .limit(1)
    .maybeSingle();
  if (convSelErr) abort("SELECT conversations (Clinic B)", convSelErr);

  let conversationBId: string;
  if (existingConv) {
    console.log(`[seed] conversations: found existing ${existingConv.id}`);
    conversationBId = existingConv.id;
  } else {
    const { data: newConv, error: convInsErr } = await admin
      .from("conversations")
      .insert({
        clinic_id: clinicBId,
        language: "en",
        status: "active",
      })
      .select()
      .single();
    if (convInsErr) abort("INSERT conversations (Clinic B)", convInsErr);
    console.log(`[seed] conversations: inserted ${newConv!.id}`);
    conversationBId = newConv!.id;
  }

  // 11. Message B — no unique constraint; select-then-insert once per conversation
  const { data: existingMsg, error: msgSelErr } = await admin
    .from("messages")
    .select("id")
    .eq("conversation_id", conversationBId)
    .limit(1)
    .maybeSingle();
  if (msgSelErr) abort("SELECT messages (Clinic B)", msgSelErr);

  if (!existingMsg) {
    const { error: msgInsErr } = await admin.from("messages").insert({
      conversation_id: conversationBId,
      role: "user",
      content: "Hello, I'd like to book an appointment.",
    });
    if (msgInsErr) abort("INSERT messages (Clinic B)", msgInsErr);
    console.log(`[seed] messages: inserted message for conversation ${conversationBId}`);
  } else {
    console.log(`[seed] messages: found existing message, skipping`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("\n[seed] ✅ Done. Summary:");
  console.log(`  Clinic A id  : ${clinicAId}`);
  console.log(`  Clinic A user: ${CLINIC_A_EMAIL}`);
  console.log(`  Doctor A1    : ${doctorA1.id} (Cardiology)`);
  console.log(`  Doctor A2    : ${doctorA2.id} (Orthopedics)`);
  console.log(`  Clinic B id  : ${clinicBId}`);
  console.log(`  Clinic B user: ${CLINIC_B_EMAIL}`);
  console.log(`  Doctor B1    : ${doctorB1.id} (General Physician)`);
  console.log(`  Patient B    : ${patientB!.id}`);
  console.log(`  Appointment B: ${appointmentBId}`);
  console.log(`  Conversation B: ${conversationBId}`);
}

main().catch((err) => {
  console.error("[seed] Unhandled error:", err);
  process.exit(1);
});

