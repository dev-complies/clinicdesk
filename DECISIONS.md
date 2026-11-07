# Architectural & Design Decisions

### 1. Weekday Convention & Luxon Mapping (Week 2, Part A)
- **Context:** The database schema for `doctor_schedules.weekday` uses `0 = Sunday ... 6 = Saturday` (matching JavaScript `Date.prototype.getDay()`). Luxon's `DateTime.weekday` uses ISO 8601 where `1 = Monday ... 7 = Sunday`.
- **Decision:** Weekday mapping is calculated as `requestedDate.weekday === 7 ? 0 : requestedDate.weekday`. This cleanly transforms Sunday from Luxon's 7 into the database's 0, while keeping Monday (1) through Saturday (6) identical.

### 2. Timezone & Calendar Boundaries
- **Context:** Appointments must be queried for an entire calendar day in the clinic's local timezone (e.g. `Asia/Kolkata`).
- **Decision:** The user-supplied `YYYY-MM-DD` date is anchored to `startOf('day')` in the clinic's timezone. The query against the database `appointments` table uses the UTC equivalent of local start-of-day up to local next-day-start (`[dayStartUtc, nextDayStartUtc)`), avoiding timezone drift and daylight saving discrepancies.

### 3. Slot Overlap & Interval Arithmetic
- **Context:** Booked appointments can have variable durations and may overlap scheduled slots.
- **Decision:** Two time intervals $[s_{start}, s_{end}]$ and $[a_{start}, a_{end}]$ overlap if and only if $s_{start} < a_{end} \land s_{end} > a_{start}$. Furthermore, slots are only emitted if their end time is $\le$ the schedule's `end_time`.

### 4. Deterministic Time Testing via Injection
- **Context:** Availability calculations must filter out slots earlier than current time ("now") and reject dates beyond 60 days. Static fixtures become stale and cause test suite flakiness.
- **Decision:** Dynamic relative dates (e.g. "next Monday at least 7 days ahead") are computed at runtime. For asserting intra-day past-slot elimination, an optional internal parameter `now?: DateTime` is supported on `checkAvailability`, strictly separating testing needs from the validated user input schema.

### 5. Vitest "server-only" Stubbing
- **Context:** `src/lib/supabase/admin.ts` imports `"server-only"` to prevent client bundling in Next.js. However, standard Node/Vitest test environments do not run under React Server Component bundler conditions, causing `server-only` to throw.
- **Decision:** An alias was configured in `vitest.config.ts` mapping `"server-only"` to an empty stub module (`tests/stubs/server-only.ts`). This enforces production compile-time isolation without sacrificing unit testing.

### 6. Concurrency & Double-Booking Protection (Week 2, Part B)
- **Context:** Concurrent requests may pass application-level availability checks simultaneously.
- **Decision:** Application code verifies slot availability against the schedule grid and existing appointments, but relies on Postgres' partial unique index `appointments_no_double_booking (doctor_id, start_at) WHERE status = 'booked'` as the ultimate synchronization authority. Code `23505` specifically matching this index is mapped to `SLOT_TAKEN` with next free slots returned, while any other violation returns `INTERNAL_ERROR`.

### 7. Patient Race Conditions & Rollback Hygiene
- **Context:** Multiple concurrent requests with the same phone number or new patients booking appointments.
- **Decision:** `patients` are queried via select-then-insert. Concurrent inserts catching `23505` re-select the existing row. The stored name in the database is never overwritten, but the returned booking confirmation always reflects the name provided in the current request. If a new patient record was created during a failed booking attempt, it is immediately deleted if no other appointments exist for it.

### 8. Fair Booking Limit (`TOO_MANY_BOOKINGS`)
- **Context:** Preventing automated booking exhaustion by a single patient.
- **Decision:** A strict cap of at most 3 active future bookings per patient is enforced before booking an appointment.

### 9. Handoff Reason Message Recording (Week 2, Part C)
- **Context:** Week 2 Part C specified recording the handoff reason as a 'system' message on the conversation if the existing messages table schema allowed it without a migration.
- **Decision:** In `supabase/migrations/20261107000000_initial_schema.sql`, `messages.role` is constrained by `CHECK (role IN ('user', 'assistant', 'tool'))`. Inserting `'system'` violates this database check constraint. Per instructions to not touch migrations, message insertion was omitted and conversation status update is handled directly.

### 10. Atomic Cancel & Reschedule with Optimistic Concurrency Guards
- **Context:** Concurrent calls to cancel or reschedule the same appointment must not corrupt data or produce duplicate slots.
- **Decision:** Both operations execute as a single SQL `UPDATE ... WHERE id = :id AND clinic_id = :clinicId AND status = 'booked' AND start_at = :originalStartAt AND start_at > :now`. If zero rows are affected, a re-read determines the precise error (`ALREADY_CANCELLED`, `APPOINTMENT_NOT_CANCELLABLE`, or `APPOINTMENT_NOT_FOUND`). For reschedule, double-booking collisions during the UPDATE trigger `23505` on `appointments_no_double_booking`, returning `SLOT_TAKEN` while preserving the original appointment untouched.

### 11. History Replay Message Text Only (Week 3, Part A)
- **Context:** When loading the last 20 messages of conversation history to feed into `streamText`, historical assistant turns contain both conversational text and detailed `tool_calls` JSON structures.
- **Decision:** History replays message text only (`role: 'user'` and `role: 'assistant'`), omitting historical raw tool results. Full tool traces are preserved in `messages.tool_calls` for auditing, debugging, and evaluation metrics, but replaying textual turns provides complete conversational context without inflating prompt token counts or risking cross-turn schema drift.

### 12. Guaranteed Background Stream Persistence
- **Context:** Streaming LLM tokens to the client can be abruptly aborted if the user navigates away or disconnects their client connection mid-response.
- **Decision:** In `POST /api/chat`, `result.toTextStreamResponse()` is returned to the client while `result.consumeStream()` runs in the server background. This guarantees that model tool calling, token accounting, and database persistence in `onEnd` complete reliably regardless of client connection lifecycle.

### 13. Model Resiliency, Fallback Sequencing & Bounded Failover
- **Context:** Primary LLM calls can fail due to provider rate limits (429), temporary service unavailability (503), or network/first-token timeouts.
- **Decision:** Models are sequenced from `LLM_MODEL` followed by `LLM_FALLBACK_MODELS`. Each attempt is bounded with `maxRetries: 0`, and the overall request has a 25-second ceiling. Failover to the next model occurs only if the failed attempt produced zero output (no text and no tool execution initiated). Once any tool has executed (such as booking or cancelling an appointment) or text has streamed, model switching is strictly forbidden to prevent duplicate side effects and mid-stream context fragmentation; in such cases, a friendly 503 fallback message is returned and persisted.


### 14. In-Memory Per-IP Rate Limit & Header Trust (Week 3, Part B)
- **Context:** A per-IP rate limit is needed to defend against abuse. No new database table is permitted, and serverless deployments don't share memory across instances.
- **Decision:** A module-level `Map<string, { count, windowStart }>` is used for a 30-request / 10-minute per-IP window. The map is pruned when it exceeds 10,000 entries, and expired entries are removed on each request.
- **IP extraction:** The client IP is taken from the `X-Forwarded-For` header (first address, leftmost = client on a trusted proxy), falling back to `X-Real-IP`. If neither header is present (e.g. direct local requests in development), the request is **allowed through** rather than blocked, to avoid locking out all local dev traffic.
- **Spoofing caveat:** `X-Forwarded-For` can be spoofed by clients not behind a trusted reverse proxy. This limit is best-effort abuse deterrence, not a security boundary. Supabase-backed per-clinic and per-conversation limits provide the authoritative protection.
- **Serverless caveat:** On Vercel serverless, each function instance has its own process memory. The in-memory limit is per-instance and is noted as best-effort in code comments and this file.
- **Relaxed mode:** Setting `RATE_LIMIT_RELAXED=true` in the environment (or in `.env.local`) raises all limits to very high values for local development. Tests inject their own tiny limits via `setRateLimitOverride`.

### 15. Emergency False-Positive Policy (Week 3, Part B)
- **Context:** Emergency phrase matching may trigger on historical or hypothetical statements (e.g. "I had chest pain last year").
- **Decision:** False positives are explicitly acceptable. Emergency safety takes absolute precedence over minor UX friction. A patient who reads the emergency reply for a non-emergency can simply continue the conversation (the conversation is marked `handed_off`, so they would start a new chat). The phrase list is maintained in `src/lib/guardrails/emergency-phrases.ts` and is normalised before matching (NFKC, lowercase, punctuation stripped, whitespace collapsed) to maximise recall across spelling variants.

### 16. Rate Limits Without a Migration (Week 3, Part B)
- **Context:** Per-conversation and per-clinic rate limits are needed without adding new database tables.
- **Decision:** All database-backed limits use `COUNT` queries on the existing `messages` table with `role = 'user'` and timestamp filters. The per-clinic hourly limit uses a Supabase join through the `conversations` foreign key (`messages → conversations.clinic_id`). Counts are checked **before** any `INSERT` so rejected requests write nothing to the database (clean audit trail).

### 17. Prompt Injection Resistance Strategy (Week 3, Part B)
- **Context:** Tool results containing phrases like "ignore previous instructions" must not change the model's behaviour.
- **Decision:** The system prompt includes an explicit injection resistance section instructing the model to treat all user and tool content as data. Real injection resistance is measured in the eval suite (Week 5) with dedicated adversarial scenarios. Unit tests verify that tool call results are delivered to the model as `tool` role messages (the AI SDK's structured message format), not as `user` or `system` text — this means injection attempts arrive in a structurally distinct channel that well-aligned models are trained to treat as data.
