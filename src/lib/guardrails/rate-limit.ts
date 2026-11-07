/**
 * Rate limiting configuration and counters for POST /api/chat.
 *
 * All database-backed limits use COUNT queries on the existing messages table —
 * no new tables or migrations are required.
 *
 * The in-memory per-IP limit is best-effort: on serverless deployments (Vercel)
 * each function instance has its own memory, so the limit is per-instance, not
 * global. See DECISIONS.md §14 for the full reasoning.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface RateLimitConfig {
  /** Max user messages in any 60-second window per conversation */
  convBurstLimit: number;
  /** Max user messages total (all time) per conversation */
  convTotalLimit: number;
  /** Max user messages per clinic per hour */
  clinicHourlyLimit: number;
  /** Max requests per IP per IP_WINDOW_MS */
  ipLimit: number;
  /** Window size in milliseconds for per-IP counting */
  ipWindowMs: number;
}

/** Default production limits */
const DEFAULT_CONFIG: RateLimitConfig = {
  convBurstLimit: 10,
  convTotalLimit: 60,
  clinicHourlyLimit: 300,
  ipLimit: 30,
  ipWindowMs: 10 * 60 * 1000, // 10 minutes
};

/** Override for local development via RATE_LIMIT_RELAXED=true */
const RELAXED_CONFIG: RateLimitConfig = {
  convBurstLimit: 1000,
  convTotalLimit: 10000,
  clinicHourlyLimit: 100000,
  ipLimit: 1000,
  ipWindowMs: 10 * 60 * 1000,
};

let _override: Partial<RateLimitConfig> | null = null;

/** Override limits (used by tests to inject tiny limits). */
export function setRateLimitOverride(cfg: Partial<RateLimitConfig> | null): void {
  _override = cfg;
}

export function getRateLimitConfig(): RateLimitConfig {
  if (process.env.RATE_LIMIT_RELAXED === "true") {
    return { ...RELAXED_CONFIG, ..._override };
  }
  return { ...DEFAULT_CONFIG, ..._override };
}

// ---------------------------------------------------------------------------
// In-memory per-IP limiter
// ---------------------------------------------------------------------------

interface IpEntry {
  count: number;
  windowStart: number;
}

/** Max number of distinct IPs tracked simultaneously (prunes oldest when exceeded). */
const IP_MAP_MAX_SIZE = 10_000;

const ipMap = new Map<string, IpEntry>();

/** Resets the entire IP map. Used by tests. */
export function resetIpLimiter(): void {
  ipMap.clear();
}

/** Prune entries outside their window to bound memory growth. */
function pruneIpMap(now: number, windowMs: number): void {
  if (ipMap.size < IP_MAP_MAX_SIZE) return;
  for (const [key, entry] of ipMap) {
    if (now - entry.windowStart >= windowMs) {
      ipMap.delete(key);
    }
  }
  // If still over limit, delete oldest entries
  if (ipMap.size >= IP_MAP_MAX_SIZE) {
    const toDelete = ipMap.size - IP_MAP_MAX_SIZE + 1;
    let deleted = 0;
    for (const key of ipMap.keys()) {
      if (deleted >= toDelete) break;
      ipMap.delete(key);
      deleted++;
    }
  }
}

/**
 * Records one request for the given IP and returns true if the limit is exceeded.
 *
 * When no IP is provided (e.g. the platform header is absent), the request is
 * allowed through — this prevents blocking users on platforms that don't forward
 * client IPs. See DECISIONS.md §14.
 */
export function checkAndIncrementIp(ip: string | null, config: RateLimitConfig): boolean {
  if (!ip) return false; // no IP → allow (see DECISIONS.md)

  const now = Date.now();
  pruneIpMap(now, config.ipWindowMs);

  const entry = ipMap.get(ip);
  if (!entry || now - entry.windowStart >= config.ipWindowMs) {
    ipMap.set(ip, { count: 1, windowStart: now });
    return false;
  }

  entry.count += 1;
  return entry.count > config.ipLimit;
}

/**
 * Extracts the client IP from common platform forwarding headers.
 * Uses the first address in X-Forwarded-For (leftmost = client on a trusted proxy).
 * Falls back to X-Real-IP, then null.
 *
 * NOTE: X-Forwarded-For can be spoofed if the request is not coming through a
 * trusted proxy. See DECISIONS.md §14.
 */
export function extractIp(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0].trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip");
}

// ---------------------------------------------------------------------------
// Database-backed conversation and clinic limits
// ---------------------------------------------------------------------------

export interface ConvRateLimitResult {
  exceeded: boolean;
  reason: "burst" | "total" | null;
}

/**
 * Returns whether the conversation rate limit is exceeded.
 * Runs two COUNT queries: burst (last 60s) and total.
 *
 * Call this BEFORE inserting the new user message so rejected requests
 * write nothing to the database.
 */
export async function checkConversationRateLimit(
  supabase: ReturnType<typeof import("../supabase/admin").getAdminClient>,
  conversationId: string,
  config: RateLimitConfig
): Promise<ConvRateLimitResult> {
  // Total cap
  const { count: total, error: totalErr } = await supabase
    .from("messages")
    .select("*", { count: "exact", head: true })
    .eq("conversation_id", conversationId)
    .eq("role", "user");

  if (totalErr) {
    console.error("[RateLimit] Failed to count total messages:", totalErr);
    return { exceeded: false, reason: null }; // fail open
  }

  if ((total ?? 0) >= config.convTotalLimit) {
    return { exceeded: true, reason: "total" };
  }

  // Burst cap (last 60 seconds)
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count: burst, error: burstErr } = await supabase
    .from("messages")
    .select("*", { count: "exact", head: true })
    .eq("conversation_id", conversationId)
    .eq("role", "user")
    .gte("created_at", since);

  if (burstErr) {
    console.error("[RateLimit] Failed to count burst messages:", burstErr);
    return { exceeded: false, reason: null }; // fail open
  }

  if ((burst ?? 0) >= config.convBurstLimit) {
    return { exceeded: true, reason: "burst" };
  }

  return { exceeded: false, reason: null };
}

/**
 * Returns whether the per-clinic hourly limit is exceeded.
 * Joins messages → conversations to scope by clinic_id.
 *
 * Call this BEFORE inserting the new user message.
 */
export async function checkClinicRateLimit(
  supabase: ReturnType<typeof import("../supabase/admin").getAdminClient>,
  clinicId: string,
  config: RateLimitConfig
): Promise<boolean> {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  // Supabase JS doesn't support arbitrary JOINs in count queries, so we use
  // the foreign key relationship: messages → conversations (via conversation_id).
  const { count, error } = await supabase
    .from("messages")
    .select("conversations!inner(clinic_id)", { count: "exact", head: true })
    .eq("conversations.clinic_id", clinicId)
    .eq("role", "user")
    .gte("created_at", since);

  if (error) {
    console.error("[RateLimit] Failed to count clinic hourly messages:", error);
    return false; // fail open
  }

  return (count ?? 0) >= config.clinicHourlyLimit;
}

/** Friendly 429 message shown to patients. */
export function build429Message(): string {
  return "You have sent too many messages. Please wait a moment before trying again. If this is an emergency, call 112 immediately.";
}

