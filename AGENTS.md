# ClinicDesk project rules

- Follow ClinicDesk_SPEC.md as the source of truth.
- Stack: Next.js App Router, TypeScript, Zod, Supabase (Postgres + pgvector).
- Every tenant table has clinic_id and RLS enabled.
- Never take clinic_id from the client or the LLM. Always from the server session.
- Never put secrets in code or commit .env.local.
- Work ONLY on the task I give you. Do not touch unrelated files.
- Show a plan first and wait for my approval before writing code.
- Write tests for every tool and every security rule.
- Explain any non-obvious decision in a short comment or in DECISIONS.md.