/**
 * tests/rls-isolation.test.ts
 *
 * Vitest suite: proves that Supabase RLS keeps Clinic A and Clinic B
 * completely isolated from each other.
 *
 * Key design decisions:
 *  - Each clinic's assertions use that clinic's own authenticated anon-key
 *    client. The service-role client is used ONLY as a post-condition oracle
 *    to verify that a Clinic B row was not silently mutated.
 *  - IDs are obtained by signing in and reading the user's own rows —
 *    no hardcoded UUIDs, no service-role reads for assertion setup.
 *  - UPDATE / DELETE cross-tenant tests use .select() on the result and
 *    assert an empty array, then re-fetch the row with the service-role
 *    client to confirm it is unchanged.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import path from "path";
import { beforeAll, describe, expect, it } from "vitest";

// Load .env.local so the test runner has the same vars as the app
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

// ── env helpers ───────────────────────────────────────────────────────────────

function env(name: string): string {
  const val = process.env[name]?.trim();
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const SUPABASE_URL       = env("NEXT_PUBLIC_SUPABASE_URL");
const ANON_KEY           = env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE_ROLE_KEY   = env("SUPABASE_SERVICE_ROLE_KEY");
const CLINIC_A_EMAIL     = env("SEED_CLINIC_A_EMAIL");
const CLINIC_B_EMAIL     = env("SEED_CLINIC_B_EMAIL");
const SEED_PASSWORD      = env("SEED_PASSWORD");

// ── clients ───────────────────────────────────────────────────────────────────

/** Create a fresh anon-key client. Each user signs into their own instance. */
function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Service-role client — used ONLY as a post-condition oracle, never for
 *  the assertions themselves. */
const oracle: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── shared test state (populated in beforeAll) ────────────────────────────────

let clientA: SupabaseClient;
let clientB: SupabaseClient;

// IDs discovered via each user's own authenticated session
let clinicAId: string;
let clinicBId: string;
let doctorA1Id: string; // first doctor visible to Clinic A user
let doctorB1Id: string; // first doctor visible to Clinic B user
let patientBId: string;
let appointmentBId: string;
let conversationBId: string;

// ── setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // --- Sign in Clinic A user ---
  clientA = anonClient();
  const { error: errA } = await clientA.auth.signInWithPassword({
    email: CLINIC_A_EMAIL,
    password: SEED_PASSWORD,
  });
  if (errA) throw new Error(`Sign-in A failed: ${errA.message}`);

  // Discover Clinic A's id from the staff_users row (own data, within RLS)
  const { data: staffA, error: staffAErr } = await clientA
    .from("staff_users")
    .select("clinic_id")
    .single();
  if (staffAErr) throw new Error(`staff_users A: ${staffAErr.message}`);
  clinicAId = staffA.clinic_id;

  // Discover Clinic A's first doctor id
  const { data: docsA, error: docsAErr } = await clientA
    .from("doctors")
    .select("id")
    .limit(1)
    .single();
  if (docsAErr) throw new Error(`doctors A: ${docsAErr.message}`);
  doctorA1Id = docsA.id;

  // --- Sign in Clinic B user ---
  clientB = anonClient();
  const { error: errB } = await clientB.auth.signInWithPassword({
    email: CLINIC_B_EMAIL,
    password: SEED_PASSWORD,
  });
  if (errB) throw new Error(`Sign-in B failed: ${errB.message}`);

  // Discover Clinic B's id from the staff_users row
  const { data: staffB, error: staffBErr } = await clientB
    .from("staff_users")
    .select("clinic_id")
    .single();
  if (staffBErr) throw new Error(`staff_users B: ${staffBErr.message}`);
  clinicBId = staffB.clinic_id;

  // Discover Clinic B's first doctor id
  const { data: docsB, error: docsBErr } = await clientB
    .from("doctors")
    .select("id")
    .limit(1)
    .single();
  if (docsBErr) throw new Error(`doctors B: ${docsBErr.message}`);
  doctorB1Id = docsB.id;

  // Discover Clinic B's patient id
  const { data: patientB, error: patientBErr } = await clientB
    .from("patients")
    .select("id")
    .limit(1)
    .single();
  if (patientBErr) throw new Error(`patients B: ${patientBErr.message}`);
  patientBId = patientB.id;

  // Discover Clinic B's appointment id
  const { data: apptB, error: apptBErr } = await clientB
    .from("appointments")
    .select("id")
    .limit(1)
    .single();
  if (apptBErr) throw new Error(`appointments B: ${apptBErr.message}`);
  appointmentBId = apptB.id;

  // Discover Clinic B's conversation id
  const { data: convB, error: convBErr } = await clientB
    .from("conversations")
    .select("id")
    .limit(1)
    .single();
  if (convBErr) throw new Error(`conversations B: ${convBErr.message}`);
  conversationBId = convB.id;
}, 30_000);

// ── Suite 1: Clinic A user ────────────────────────────────────────────────────

describe("Clinic A user — isolation assertions", () => {
  // A1: SELECT doctors returns only own clinic's rows
  it("A1: SELECT doctors returns only Clinic A rows", async () => {
    const { data, error } = await clientA.from("doctors").select("id,clinic_id");
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.length).toBeGreaterThanOrEqual(1);
    for (const row of data!) {
      expect(row.clinic_id).toBe(clinicAId);
    }
  });

  // A2: SELECT Clinic B's doctor by id returns zero rows (RLS hides it)
  it("A2: SELECT Clinic B doctor by id returns zero rows", async () => {
    const { data, error } = await clientA
      .from("doctors")
      .select("id")
      .eq("id", doctorB1Id);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  // A3: SELECT Clinic B's patient by id returns zero rows
  it("A3: SELECT Clinic B patient by id returns zero rows", async () => {
    const { data, error } = await clientA
      .from("patients")
      .select("id")
      .eq("id", patientBId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  // A4: SELECT Clinic B's appointment by id returns zero rows
  it("A4: SELECT Clinic B appointment by id returns zero rows", async () => {
    const { data, error } = await clientA
      .from("appointments")
      .select("id")
      .eq("id", appointmentBId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  // A5: INSERT doctor with Clinic B's clinic_id must fail (RLS check violation)
  it("A5: INSERT doctor with Clinic B clinic_id fails", async () => {
    const { data, error } = await clientA
      .from("doctors")
      .insert({
        clinic_id: clinicBId,
        name: "Injected Doctor",
        speciality: "Hacking",
        fee: 0,
      })
      .select();
    // PostgREST maps RLS check failures to an error or an empty result.
    // Either outcome proves the row was rejected.
    const isBlocked =
      error !== null || (Array.isArray(data) && data.length === 0);
    expect(isBlocked).toBe(true);
  });

  // A6: UPDATE Clinic B doctor returns zero affected rows, row is unchanged
  it("A6: UPDATE Clinic B doctor affects zero rows and row is unchanged", async () => {
    // Capture original name via oracle before the attempt
    const { data: before } = await oracle
      .from("doctors")
      .select("name")
      .eq("id", doctorB1Id)
      .single();
    const originalName = before!.name as string;

    // Attempt cross-tenant update as Clinic A user
    const { data: updated, error } = await clientA
      .from("doctors")
      .update({ name: "Tampered by A" })
      .eq("id", doctorB1Id)
      .select("id");

    // Must return empty (RLS filters the row out of the WHERE scope)
    expect(error).toBeNull();
    expect(updated).toHaveLength(0);

    // Oracle confirms the row is truly unchanged
    const { data: after } = await oracle
      .from("doctors")
      .select("name")
      .eq("id", doctorB1Id)
      .single();
    expect(after!.name).toBe(originalName);
  });

  // A7: DELETE Clinic B doctor returns zero affected rows, row still exists
  it("A7: DELETE Clinic B doctor affects zero rows and row still exists", async () => {
    const { data: deleted, error } = await clientA
      .from("doctors")
      .delete()
      .eq("id", doctorB1Id)
      .select("id");

    expect(error).toBeNull();
    expect(deleted).toHaveLength(0);

    // Oracle confirms the row still exists
    const { data: stillThere } = await oracle
      .from("doctors")
      .select("id")
      .eq("id", doctorB1Id)
      .single();
    expect(stillThere).not.toBeNull();
  });

  // A8: SELECT eval_runs returns empty (no policy grants authenticated users access)
  it("A8: SELECT eval_runs returns empty or errors (no RLS policy)", async () => {
    const { data, error } = await clientA.from("eval_runs").select("id");
    // RLS with no policy = zero rows (not an error in PostgREST by default)
    const isBlocked =
      error !== null || (Array.isArray(data) && data.length === 0);
    expect(isBlocked).toBe(true);
  });

  // A9: SELECT Clinic B conversation by id returns zero rows
  it("A9: SELECT Clinic B conversation by id returns zero rows", async () => {
    const { data, error } = await clientA
      .from("conversations")
      .select("id")
      .eq("id", conversationBId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  // A10: SELECT messages via Clinic B's conversation_id returns zero rows
  it("A10: SELECT Clinic B messages returns zero rows", async () => {
    const { data, error } = await clientA
      .from("messages")
      .select("id")
      .eq("conversation_id", conversationBId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });
});

// ── Suite 2: Clinic B user ────────────────────────────────────────────────────

describe("Clinic B user — isolation assertions", () => {
  // B1: SELECT doctors returns only own clinic's rows
  it("B1: SELECT doctors returns only Clinic B rows", async () => {
    const { data, error } = await clientB.from("doctors").select("id,clinic_id");
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.length).toBeGreaterThanOrEqual(1);
    for (const row of data!) {
      expect(row.clinic_id).toBe(clinicBId);
    }
  });

  // B2: SELECT Clinic A's doctor by id returns zero rows
  it("B2: SELECT Clinic A doctor by id returns zero rows", async () => {
    const { data, error } = await clientB
      .from("doctors")
      .select("id")
      .eq("id", doctorA1Id);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  // B3: Clinic B user CAN read their own patient
  it("B3: Clinic B user can read their own patient", async () => {
    const { data, error } = await clientB
      .from("patients")
      .select("id")
      .eq("id", patientBId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].id).toBe(patientBId);
  });

  // B4: Clinic B user CAN read their own appointment
  it("B4: Clinic B user can read their own appointment", async () => {
    const { data, error } = await clientB
      .from("appointments")
      .select("id")
      .eq("id", appointmentBId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].id).toBe(appointmentBId);
  });

  // B5: INSERT doctor with Clinic A's clinic_id must fail
  it("B5: INSERT doctor with Clinic A clinic_id fails", async () => {
    const { data, error } = await clientB
      .from("doctors")
      .insert({
        clinic_id: clinicAId,
        name: "Injected Doctor by B",
        speciality: "Hacking",
        fee: 0,
      })
      .select();
    const isBlocked =
      error !== null || (Array.isArray(data) && data.length === 0);
    expect(isBlocked).toBe(true);
  });
});

