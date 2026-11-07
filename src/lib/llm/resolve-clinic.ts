/**
 * Resolves the tenant clinic ID from trusted server configuration.
 * Must never read clinic_id from request bodies, headers, or model outputs.
 * Isolated in this single function so it can later be upgraded to decode
 * and verify signed widget tokens (e.g. JWT) without touching endpoint logic.
 */
export async function resolveClinicId(): Promise<string> {
  const clinicId = process.env.DEMO_CLINIC_ID?.trim();
  if (!clinicId) {
    throw new Error("Server misconfiguration: DEMO_CLINIC_ID is not set");
  }
  return clinicId;
}

