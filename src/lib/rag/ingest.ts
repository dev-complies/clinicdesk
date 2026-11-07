/**
 * src/lib/rag/ingest.ts
 *
 * Safe document ingestion into Postgres + pgvector:
 * 1. Chunks markdown document.
 * 2. Pre-embeds ALL chunks first. If embedding fails, nothing is written and
 *    any existing document with the same (clinic_id, title) remains untouched.
 * 3. Inserts new documents row.
 * 4. Inserts chunks in batches of ~50.
 * 5. If chunk insertion fails, cleans up the new document (cascade removes chunks) and rethrows.
 * 6. Swaps old document out: deletes any prior document matching (clinic_id, title).
 * 7. Enforces clinic_id on every row.
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { getAdminClient } from "../supabase/admin";
import { chunkMarkdown, ChunkResult } from "./chunk";
import { embedTexts, EmbeddingKind } from "./embed";

export const CHUNK_INSERT_BATCH_SIZE = 50;

export interface IngestDocumentOptions {
  clinicId: string;
  title: string;
  markdown: string;
  embedFn?: (texts: string[], kind: EmbeddingKind) => Promise<number[][]>;
  supabaseClient?: SupabaseClient;
}

export interface IngestDocumentResult {
  documentId: string;
  chunkCount: number;
}

export async function ingestDocument({
  clinicId,
  title,
  markdown,
  embedFn = embedTexts,
  supabaseClient,
}: IngestDocumentOptions): Promise<IngestDocumentResult> {
  const cleanTitle = title.trim();
  if (!cleanTitle) {
    throw new Error("Document title must not be empty.");
  }
  if (!clinicId) {
    throw new Error("Clinic ID must not be empty.");
  }

  // 1. Chunk document
  const chunks: ChunkResult[] = chunkMarkdown(cleanTitle, markdown);
  if (chunks.length === 0) {
    throw new Error("Document produced zero chunks (empty or invalid content).");
  }

  // 2. Pre-embed ALL chunks first before touching the database
  const chunkTexts = chunks.map((c) => c.content);
  const embeddings = await embedFn(chunkTexts, "document");

  if (embeddings.length !== chunks.length) {
    throw new Error(
      `Embedding count mismatch: expected ${chunks.length}, got ${embeddings.length}`
    );
  }

  const supabase = supabaseClient ?? getAdminClient();

  // 3. Insert new documents row
  const { data: newDoc, error: docErr } = await supabase
    .from("documents")
    .insert({
      clinic_id: clinicId,
      title: cleanTitle,
      source_type: "markdown",
    })
    .select("id")
    .single();

  if (docErr || !newDoc) {
    throw new Error(`Failed to insert document row: ${docErr?.message || "Unknown error"}`);
  }

  const newDocId = newDoc.id;

  // 4. Batch-insert chunks in batches of 50
  try {
    const chunkRows = chunks.map((c, i) => ({
      clinic_id: clinicId,
      document_id: newDocId,
      content: c.content,
      embedding: embeddings[i],
      page: c.page,
    }));

    for (let i = 0; i < chunkRows.length; i += CHUNK_INSERT_BATCH_SIZE) {
      const batch = chunkRows.slice(i, i + CHUNK_INSERT_BATCH_SIZE);
      const { error: chunkErr } = await supabase.from("chunks").insert(batch);
      if (chunkErr) {
        throw new Error(`Failed to insert chunks batch: ${chunkErr.message}`);
      }
    }
  } catch (insertChunksErr) {
    // Cleanup new document row on failure (cascade removes any partially inserted chunks)
    await supabase.from("documents").delete().eq("id", newDocId);
    throw insertChunksErr;
  }

  // 5. Delete prior document(s) matching (clinic_id, title) now that new one is ready
  const { error: cleanupErr } = await supabase
    .from("documents")
    .delete()
    .eq("clinic_id", clinicId)
    .eq("title", cleanTitle)
    .neq("id", newDocId);

  if (cleanupErr) {
    console.error(
      `[Ingest Warning] Failed to delete previous document version: ${cleanupErr.message}`
    );
  }

  return {
    documentId: newDocId,
    chunkCount: chunks.length,
  };
}
