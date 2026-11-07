/**
 * scripts/ingest.ts
 *
 * Usage: npx tsx scripts/ingest.ts "Demo Clinic A" data/demo-clinic-a
 *
 * Resolves clinic by exact name, reads all .md files in the directory,
 * ensures unique document titles in the run, calls ingestDocument,
 * and prints summary without leaking keys or text contents.
 */

import Module from "module";
// Intercept require("server-only") so standalone CLI scripts can import server modules
const originalRequire = (Module.prototype as any).require;
(Module.prototype as any).require = function (path: string) {
  if (path === "server-only") return {};
  return originalRequire.apply(this, arguments);
};

import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { createClient } from "@supabase/supabase-js";
import { ingestDocument } from "../src/lib/rag/ingest";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

function extractTitle(content: string, filename: string): string {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^#\s+(.+)$/);
    if (match) {
      return match[1].trim();
    }
  }
  return path.basename(filename, path.extname(filename));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: npx tsx scripts/ingest.ts "<Clinic Name>" <data-folder>');
    process.exit(1);
  }

  const [clinicName, folderPath] = args;
  const resolvedFolder = path.resolve(process.cwd(), folderPath);

  if (!fs.existsSync(resolvedFolder)) {
    console.error(`Error: Folder not found: ${resolvedFolder}`);
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

  if (clinicErr) {
    console.error(`Error querying clinic: ${clinicErr.message}`);
    process.exit(1);
  }

  if (!clinics || clinics.length === 0) {
    console.error(`Error: No clinic found with name "${clinicName}".`);
    process.exit(1);
  }
  if (clinics.length > 1) {
    console.error(`Error: Multiple clinics matched name "${clinicName}". Ambiguous match.`);
    process.exit(1);
  }

  const clinicId = clinics[0].id;

  // 2. Read all .md files in directory
  const files = fs
    .readdirSync(resolvedFolder)
    .filter((f) => f.endsWith(".md"))
    .sort();

  if (files.length === 0) {
    console.log(`No .md files found in ${resolvedFolder}.`);
    return;
  }

  // 3. Verify unique titles in this run
  const titleToFileMap = new Map<string, string>();
  const docsToIngest: Array<{ file: string; title: string; content: string }> = [];

  for (const file of files) {
    const fullPath = path.join(resolvedFolder, file);
    const content = fs.readFileSync(fullPath, "utf-8");
    const title = extractTitle(content, file);

    if (titleToFileMap.has(title)) {
      const prevFile = titleToFileMap.get(title);
      console.error(
        `Error: Duplicate document title "${title}" resolved from files "${prevFile}" and "${file}". Aborting ingestion.`
      );
      process.exit(1);
    }

    titleToFileMap.set(title, file);
    docsToIngest.push({ file, title, content });
  }

  console.log(`Found ${docsToIngest.length} documents for "${clinicName}" (${clinicId}). Ingesting...\n`);

  for (const doc of docsToIngest) {
    const start = Date.now();
    try {
      const result = await ingestDocument({
        clinicId,
        title: doc.title,
        markdown: doc.content,
        supabaseClient: supabase,
      });
      const elapsed = ((Date.now() - start) / 1000).toFixed(2);
      console.log(`✓ Ingested "${doc.title}": ${result.chunkCount} chunks (${elapsed}s)`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`✗ Failed to ingest "${doc.title}" (${doc.file}): ${msg}`);
      process.exit(1);
    }
  }

  console.log(`\nIngestion complete for "${clinicName}".`);
}

main().catch((err) => {
  console.error("Fatal ingestion error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
