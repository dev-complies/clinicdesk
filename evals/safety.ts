/**
 * evals/safety.ts
 *
 * Safety guard for the evaluation runner.
 * Ensures evaluations run strictly against seeded Demo Clinic fixtures,
 * prints the sanitized Supabase host without keys, and requires explicit confirmation.
 */

import { SupabaseClient } from "@supabase/supabase-js";

export interface SafetyCheckResult {
  clinicAId: string;
  clinicBId: string;
  projectHost: string;
}

export async function runSafetyGuard(
  supabase: SupabaseClient,
  flags: { yes?: boolean }
): Promise<SafetyCheckResult> {
  // 1. Sanitize and print project host only (no keys)
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!supabaseUrl) {
    throw new Error("Safety check failed: NEXT_PUBLIC_SUPABASE_URL is not set.");
  }

  let projectHost: string;
  try {
    projectHost = new URL(supabaseUrl).host;
  } catch (err: any) {
    throw new Error(`Safety check failed: Invalid Supabase URL: ${err?.message}`);
  }

  console.log(`[Safety Guard] Target Supabase Host: ${projectHost}`);

  // 2. Require --yes or EVAL_CONFIRM=1
  const confirmed = flags.yes === true || process.env.EVAL_CONFIRM === "1";
  if (!confirmed) {
    throw new Error(
      "Safety guard: Evaluation execution requires explicit confirmation. " +
        "Pass '--yes' on the CLI or set 'EVAL_CONFIRM=1' in your environment."
    );
  }

  // 3. Verify target clinic "Demo Clinic A" exists
  const { data: clinicA, error: errA } = await supabase
    .from("clinics")
    .select("id, name")
    .eq("name", "Demo Clinic A")
    .single();

  if (errA || !clinicA || clinicA.name !== "Demo Clinic A") {
    throw new Error(
      "Safety guard refusal: Target clinic must be named exactly 'Demo Clinic A'. " +
        `Found: ${clinicA?.name ?? "none"} (Error: ${errA?.message ?? "none"})`
    );
  }

  // 4. Verify foreign clinic fixture "Demo Clinic B" exists
  const { data: clinicB, error: errB } = await supabase
    .from("clinics")
    .select("id, name")
    .eq("name", "Demo Clinic B")
    .single();

  if (errB || !clinicB || clinicB.name !== "Demo Clinic B") {
    throw new Error(
      "Safety guard refusal: Foreign fixture clinic must be named exactly 'Demo Clinic B'. " +
        `Found: ${clinicB?.name ?? "none"} (Error: ${errB?.message ?? "none"})`
    );
  }

  console.log(
    `[Safety Guard] Verified clinics: '${clinicA.name}' (${clinicA.id}) and '${clinicB.name}' (${clinicB.id})`
  );

  return {
    clinicAId: clinicA.id,
    clinicBId: clinicB.id,
    projectHost,
  };
}

