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

