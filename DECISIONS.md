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
