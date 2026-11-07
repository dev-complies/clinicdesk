import "server-only";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

let adminClientInstance: SupabaseClient | null = null;

/**
 * Returns a singleton service-role Supabase client.
 * Uses NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 * Never exposes the client to the browser because of the "server-only" import.
 */
export function getAdminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !key) {
    throw new Error(
      "Missing Supabase admin environment variables: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set."
    );
  }

  if (!adminClientInstance) {
    adminClientInstance = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  return adminClientInstance;
}

