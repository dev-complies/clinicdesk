/**
 * scripts/try-search.ts
 *
 * Usage: npx tsx scripts/try-search.ts "Demo Clinic A" "what are your Sunday timings"
 *
 * Embeds query (taskType = RETRIEVAL_QUERY), invokes match_chunks RPC on Supabase,
 * and prints the top 4 results with similarity, title, heading, and 120-char preview.
 * Never prints secrets or raw keys.
 */

import Module from "module";
// Intercept require("server-only") so standalone CLI scripts can import server modules
const originalRequire = (Module.prototype as any).require;
(Module.prototype as any).require = function (path: string) {
  if (path === "server-only") return {};
  return originalRequire.apply(this, arguments);
};

import * as dotenv from "dotenv";
import * as path from "path";
import { createClient } from "@supabase/supabase-js";
import { embedTexts } from "../src/lib/rag/embed";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: npx tsx scripts/try-search.ts "<Clinic Name>" "<Query>"');
    process.exit(1);
  }

  const [clinicName, query] = args;
  const cleanQuery = query.trim();
  if (!cleanQuery) {
    console.error("Error: Query must not be empty.");
    process.exit(1);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }
  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Resolve clinic by exact name
  const { data: clinics, error: clinicErr } = await supabase
    .from("clinics")
    .select("id, name")
    .eq("name", clinicName);

  if (clinicErr || !clinics || clinics.length === 0) {
    console.error(`Error: Clinic "${clinicName}" not found: ${clinicErr?.message || "No rows"}`);
    process.exit(1);
  }
  if (clinics.length > 1) {
    console.error(`Error: Ambiguous clinic name "${clinicName}".`);
    process.exit(1);
  }

  const clinicId = clinics[0].id;

  // 2. Embed the query with kind="query"
  console.log(`Embedding query: "${cleanQuery}"...`);
  const [queryEmbedding] = await embedTexts([cleanQuery], "query");

  if (!queryEmbedding) {
    console.error("Error: Failed to generate query embedding.");
    process.exit(1);
  }

  // 3. Call match_chunks RPC
  const { data: results, error: rpcErr } = await supabase.rpc("match_chunks", {
    p_clinic_id: clinicId,
    p_query_embedding: queryEmbedding,
    p_match_count: 4,
  });

  if (rpcErr) {
    console.error(`Vector search RPC error: ${rpcErr.message}`);
    process.exit(1);
  }

  if (!results || results.length === 0) {
    console.log(`No matching chunks found for "${clinicName}".`);
    return;
  }

  console.log(`\nTop ${results.length} matches for "${clinicName}":\n`);
  for (let i = 0; i < results.length; i++) {
    const row = results[i];
    const similarity = typeof row.similarity === "number" ? row.similarity.toFixed(3) : "N/A";
    const preview = String(row.content || "")
      .replace(/\s+/g, " ")
      .slice(0, 120);

    console.log(
      `[${i + 1}] Similarity: ${similarity} | Document: ${row.document_title || "Unknown"}`
    );
    console.log(`    Section: ${row.heading || "General"}`);
    console.log(`    Preview: ${preview}...`);
    console.log("");
  }
}

main().catch((err) => {
  console.error("Fatal search error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
