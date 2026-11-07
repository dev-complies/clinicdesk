/**
 * tests/rag.test.ts
 *
 * Comprehensive tests for Week 4, Part A RAG pipeline:
 * - chunk.ts: heading prefixes, overlap, sentence split rules (abbreviations, Devanagari), table atomic unit.
 * - embed.ts: batching, 429/503 retry with backoff, failure after 3 attempts, dimension validation.
 * - ingest.ts: database operations with service role client; safe atomic swap; failed embed safety.
 * - match_chunks: RPC filtering, cosine distance ordering, clinic isolation (Clinic B not returned for A), anon client rejection.
 * - live smoke test: skipped unless RUN_LIVE_EMBEDDING=1.
 *
 * Uses unique titles "__test__<random>" and cleans up every row created.
 * Asserts before and after counts are equal.
 */

import * as dotenv from "dotenv";
import path from "path";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  CHUNK_OVERLAP_WORDS,
  CHUNK_WORD_TARGET,
  chunkMarkdown,
  countWords,
  splitIntoSentences,
} from "../src/lib/rag/chunk";
import {
  embedTexts,
  EXPECTED_EMBEDDING_DIMENSIONS,
  maybeNormalize,
  vectorNorm,
} from "../src/lib/rag/embed";
import { ingestDocument } from "../src/lib/rag/ingest";
import { getAdminClient } from "../src/lib/supabase/admin";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

// Deterministic mock vector generator of length 1536
function makeDeterministicVector(seed: number, length = EXPECTED_EMBEDDING_DIMENSIONS): number[] {
  const vec = new Array<number>(length);
  for (let i = 0; i < length; i++) {
    // Generate pseudo-random value based on seed and dimension index
    vec[i] = Math.sin(seed * 1000 + i);
  }
  return maybeNormalize(vec);
}

describe("RAG Pipeline – Chunking, Embedding, Ingestion, and Search", () => {
  let clinicAId: string;
  let clinicBId: string;
  const createdDocumentIds = new Set<string>();

  let initialDocCount = 0;
  let initialChunkCount = 0;
  let initialMsgCount = 0;
  let initialConvCount = 0;

  beforeAll(async () => {
    const supabase = getAdminClient();

    const { data: clinicA } = await supabase
      .from("clinics")
      .select("id")
      .eq("name", "Demo Clinic A")
      .single();
    if (!clinicA) throw new Error("Demo Clinic A not found");
    clinicAId = clinicA.id;

    const { data: clinicB } = await supabase
      .from("clinics")
      .select("id")
      .eq("name", "Demo Clinic B")
      .single();
    if (!clinicB) throw new Error("Demo Clinic B not found");
    clinicBId = clinicB.id;

    // Record initial baseline counts
    const { count: docs } = await supabase.from("documents").select("*", { count: "exact", head: true });
    const { count: chunks } = await supabase.from("chunks").select("*", { count: "exact", head: true });
    const { count: msgs } = await supabase.from("messages").select("*", { count: "exact", head: true });
    const { count: convs } = await supabase.from("conversations").select("*", { count: "exact", head: true });

    initialDocCount = docs ?? 0;
    initialChunkCount = chunks ?? 0;
    initialMsgCount = msgs ?? 0;
    initialConvCount = convs ?? 0;
  });

  afterAll(async () => {
    const supabase = getAdminClient();
    if (createdDocumentIds.size > 0) {
      await supabase.from("documents").delete().in("id", Array.from(createdDocumentIds));
    }

    // Safety sweep for any __test__ document created
    await supabase.from("documents").delete().like("title", "__test__%");

    // Assert that database row counts are equal to initial state
    const { count: finalDocs } = await supabase.from("documents").select("*", { count: "exact", head: true });
    const { count: finalChunks } = await supabase.from("chunks").select("*", { count: "exact", head: true });
    const { count: finalMsgs } = await supabase.from("messages").select("*", { count: "exact", head: true });
    const { count: finalConvs } = await supabase.from("conversations").select("*", { count: "exact", head: true });

    expect(finalDocs).toBe(initialDocCount);
    expect(finalChunks).toBe(initialChunkCount);
    expect(finalMsgs).toBe(initialMsgCount);
    expect(finalConvs).toBe(initialConvCount);
  });

  // =========================================================================
  // 1. Chunking Tests
  // =========================================================================
  describe("chunk.ts (pure function)", () => {
    it("exports named constants for chunk size and overlap", () => {
      expect(CHUNK_WORD_TARGET).toBe(200);
      expect(CHUNK_OVERLAP_WORDS).toBe(40);
    });

    it("returns empty array for empty or whitespace markdown", () => {
      expect(chunkMarkdown("Title", "")).toEqual([]);
      expect(chunkMarkdown("Title", "   \n\n   ")).toEqual([]);
    });

    it("does not split sentences after Dr., Rs., Mr., Mrs., a.m., p.m.", () => {
      const text =
        "Consultation with Dr. Priya Sharma costs Rs. 800 at 9:00 a.m. sharp. Mr. and Mrs. Verma arrived early.";
      const sentences = splitIntoSentences(text);
      expect(sentences).toHaveLength(2);
      expect(sentences[0]).toBe("Consultation with Dr. Priya Sharma costs Rs. 800 at 9:00 a.m. sharp.");
      expect(sentences[1]).toBe("Mr. and Mrs. Verma arrived early.");
    });

    it("splits sentences properly on Devanagari purna viram (।)", () => {
      const hindi = "यह क्लिनिक सोमवार से शनिवार खुला रहता है। रविवार को छुट्टी होती है।";
      const sentences = splitIntoSentences(hindi);
      expect(sentences).toHaveLength(2);
      expect(sentences[0]).toBe("यह क्लिनिक सोमवार से शनिवार खुला रहता है।");
      expect(sentences[1]).toBe("रविवार को छुट्टी होती है।");
    });

    it("prefixes each chunk with document title and heading path", () => {
      const md = `
# Main Header
Introductory remarks.

## Sub Section
Detailed paragraph about clinic guidelines and timings.
`;
      const chunks = chunkMarkdown("Clinic Guide", md);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].content).toContain("[Document: Clinic Guide]");
      expect(chunks[0].content).toContain("[Section: Main Header]");

      const subChunk = chunks.find((c) => c.heading === "Main Header > Sub Section");
      expect(subChunk).toBeDefined();
      expect(subChunk?.content).toContain("[Section: Main Header > Sub Section]");
    });

    it("keeps table rows atomic with table header repeated", () => {
      const md = `
| Doctor | Fee |
| :--- | :--- |
| Dr. Sharma | Rs. 800 |
| Dr. Mehta | Rs. 600 |
`;
      const chunks = chunkMarkdown("Pricing", md);
      expect(chunks.length).toBeGreaterThan(0);
      const text = chunks[0].content;
      expect(text).toContain("| Doctor | Fee |");
      expect(text).toContain("Dr. Sharma");
    });

    it("includes overlap when content spans multiple chunks", () => {
      // Create a markdown section with many sentences to exceed CHUNK_WORD_TARGET
      const sentences: string[] = [];
      for (let i = 1; i <= 30; i++) {
        sentences.push(`Sentence number ${i} provides valuable instructions on medical appointments and follow-up care.`);
      }
      const md = `## Big Section\n\n${sentences.join(" ")}`;
      const chunks = chunkMarkdown("Long Doc", md);

      expect(chunks.length).toBeGreaterThan(1);
      // The second chunk must contain overlap words from the end of the first chunk
      const firstChunkText = chunks[0].content;
      const secondChunkText = chunks[1].content;
      // Find a sentence that appears in both
      const sharedSentence = sentences.find((s) => firstChunkText.includes(s) && secondChunkText.includes(s));
      expect(sharedSentence).toBeDefined();
    });
  });

  // =========================================================================
  // 2. Embedding Tests
  // =========================================================================
  describe("embed.ts (batching, retry, dimension validation)", () => {
    it("returns empty array for empty text list without calling embedder", async () => {
      const customEmbedder = vi.fn();
      const res = await embedTexts([], "document", { customEmbedder });
      expect(res).toEqual([]);
      expect(customEmbedder).not.toHaveBeenCalled();
    });

    it("slices input into batches of batchSize with sequential execution", async () => {
      const customEmbedder = vi.fn().mockImplementation(async (batch: string[]) => {
        return batch.map((_, i) => makeDeterministicVector(i));
      });

      const texts = Array.from({ length: 35 }, (_, i) => `Text chunk ${i}`);
      const res = await embedTexts(texts, "document", {
        batchSize: 16,
        batchDelayMs: 0,
        customEmbedder,
      });

      expect(res).toHaveLength(35);
      expect(customEmbedder).toHaveBeenCalledTimes(3); // 16 + 16 + 3 = 35
      expect(customEmbedder.mock.calls[0][0]).toHaveLength(16);
      expect(customEmbedder.mock.calls[1][0]).toHaveLength(16);
      expect(customEmbedder.mock.calls[2][0]).toHaveLength(3);
    });

    it("retries on 429/503 and succeeds on 2nd attempt", async () => {
      let callCount = 0;
      const customEmbedder = vi.fn().mockImplementation(async (batch: string[]) => {
        callCount++;
        if (callCount === 1) {
          const err: any = new Error("Resource exhausted: quota exceeded");
          err.status = 429;
          throw err;
        }
        return batch.map(() => makeDeterministicVector(1));
      });

      const res = await embedTexts(["sample text"], "query", {
        maxAttempts: 3,
        batchDelayMs: 0,
        customEmbedder,
      });

      expect(res).toHaveLength(1);
      expect(callCount).toBe(2);
    });

    it("gives up after 3 attempts on persistent error and throws", async () => {
      const customEmbedder = vi.fn().mockImplementation(async () => {
        const err: any = new Error("Service Unavailable");
        err.status = 503;
        throw err;
      });

      await expect(
        embedTexts(["sample"], "document", {
          maxAttempts: 3,
          batchDelayMs: 0,
          customEmbedder,
        })
      ).rejects.toThrow(/Failed to embed batch 1\/1 after attempts/);

      expect(customEmbedder).toHaveBeenCalledTimes(3);
    });

    it("fails fast if returned vector length is not 1536", async () => {
      const customEmbedder = vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]); // only 3 dimensions

      await expect(
        embedTexts(["sample"], "document", {
          batchDelayMs: 0,
          customEmbedder,
        })
      ).rejects.toThrow(/Invalid embedding dimension: expected 1536, got 3/);
    });

    it("normalizes vector if its norm differs from 1.0 by more than tolerance", () => {
      const nonUnit = [3, 4]; // norm is 5
      const normalized = maybeNormalize(nonUnit);
      expect(vectorNorm(normalized)).toBeCloseTo(1.0, 5);
      expect(normalized[0]).toBeCloseTo(0.6, 5);
      expect(normalized[1]).toBeCloseTo(0.8, 5);
    });
  });

  // =========================================================================
  // 3. Document Ingestion Tests (against remote Supabase)
  // =========================================================================
  describe("ingest.ts (safe re-ingest, rollback on failure)", () => {
    const fakeEmbedFn = async (texts: string[]) => {
      return texts.map((_, i) => makeDeterministicVector(i + 1));
    };

    it("ingests a document and creates chunks with the correct clinic_id", async () => {
      const uniqueTitle = `__test__ingest_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const md = `
# Service Guide
We provide high quality outpatient cardiology services.

## Consultation Hours
Monday to Friday from 9 AM to 1 PM.
`;
      const res = await ingestDocument({
        clinicId: clinicAId,
        title: uniqueTitle,
        markdown: md,
        embedFn: fakeEmbedFn,
      });

      createdDocumentIds.add(res.documentId);
      expect(res.documentId).toBeTruthy();
      expect(res.chunkCount).toBeGreaterThan(0);

      const supabase = getAdminClient();
      const { data: doc } = await supabase.from("documents").select("*").eq("id", res.documentId).single();
      expect(doc?.clinic_id).toBe(clinicAId);
      expect(doc?.title).toBe(uniqueTitle);

      const { data: chunkRows } = await supabase.from("chunks").select("*").eq("document_id", res.documentId);
      expect(chunkRows?.length).toBe(res.chunkCount);
      for (const c of chunkRows!) {
        expect(c.clinic_id).toBe(clinicAId);
        expect(c.embedding).toBeDefined();
      }
    });

    it("safe re-ingest: replaces old document and cascades old chunks", async () => {
      const uniqueTitle = `__test__reingest_${Date.now()}`;
      const mdV1 = "# Policies\n\nOld policy text version 1.";
      const mdV2 = "# Policies\n\nUpdated policy text version 2 with more information.";

      // Ingest V1
      const res1 = await ingestDocument({
        clinicId: clinicAId,
        title: uniqueTitle,
        markdown: mdV1,
        embedFn: fakeEmbedFn,
      });
      createdDocumentIds.add(res1.documentId);

      // Ingest V2 (same title, same clinic)
      const res2 = await ingestDocument({
        clinicId: clinicAId,
        title: uniqueTitle,
        markdown: mdV2,
        embedFn: fakeEmbedFn,
      });
      createdDocumentIds.add(res2.documentId);

      expect(res2.documentId).not.toBe(res1.documentId);

      const supabase = getAdminClient();
      // Old document must be deleted
      const { data: oldDoc } = await supabase.from("documents").select("id").eq("id", res1.documentId);
      expect(oldDoc).toHaveLength(0);

      // Old chunks must be cascaded
      const { data: oldChunks } = await supabase.from("chunks").select("id").eq("document_id", res1.documentId);
      expect(oldChunks).toHaveLength(0);

      // New document must exist
      const { data: newDoc } = await supabase.from("documents").select("id").eq("id", res2.documentId);
      expect(newDoc).toHaveLength(1);
    });

    it("aborts when embedding fails, leaving existing document completely untouched", async () => {
      const uniqueTitle = `__test__fail_embed_${Date.now()}`;
      const mdV1 = "# Stable Doc\n\nOriginal intact content.";

      // First successful ingest
      const res1 = await ingestDocument({
        clinicId: clinicAId,
        title: uniqueTitle,
        markdown: mdV1,
        embedFn: fakeEmbedFn,
      });
      createdDocumentIds.add(res1.documentId);

      // Second ingest with failing embed function
      const failingEmbedFn = async () => {
        throw new Error("Simulated embedding service outage");
      };

      await expect(
        ingestDocument({
          clinicId: clinicAId,
          title: uniqueTitle,
          markdown: "# Broken\n\nNew content.",
          embedFn: failingEmbedFn,
        })
      ).rejects.toThrow("Simulated embedding service outage");

      const supabase = getAdminClient();
      // Original document must still be intact
      const { data: intactDoc } = await supabase.from("documents").select("*").eq("id", res1.documentId).single();
      expect(intactDoc).toBeDefined();
      expect(intactDoc?.title).toBe(uniqueTitle);

      const { data: intactChunks } = await supabase.from("chunks").select("id").eq("document_id", res1.documentId);
      expect(intactChunks?.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 4. match_chunks Vector Search Function Tests
  // =========================================================================
  describe("match_chunks SQL function", () => {
    it("never returns a Clinic B chunk for Clinic A even when it has higher similarity", async () => {
      const supabase = getAdminClient();
      const uniqueTitleA = `__test__search_a_${Date.now()}`;
      const uniqueTitleB = `__test__search_b_${Date.now()}`;

      // Fixed query vector
      const queryVec = makeDeterministicVector(42);

      // Ingest for Clinic A with vector having moderate similarity
      const docA = await ingestDocument({
        clinicId: clinicAId,
        title: uniqueTitleA,
        markdown: "# Clinic A Info\n\nContent for clinic A.",
        embedFn: async () => [makeDeterministicVector(45)], // slightly different seed
      });
      createdDocumentIds.add(docA.documentId);

      // Ingest for Clinic B with IDENTICAL vector to query (similarity 1.0)
      const docB = await ingestDocument({
        clinicId: clinicBId,
        title: uniqueTitleB,
        markdown: "# Clinic B Info\n\nContent for clinic B.",
        embedFn: async () => [queryVec], // exact match
      });
      createdDocumentIds.add(docB.documentId);

      // Search for Clinic A
      const { data: resultsA, error: errA } = await supabase.rpc("match_chunks", {
        p_clinic_id: clinicAId,
        p_query_embedding: queryVec,
        p_match_count: 4,
      });

      expect(errA).toBeNull();
      expect(resultsA).toBeDefined();
      // Must NOT include Clinic B document
      const foundClinicB = resultsA?.some((r: any) => r.document_title === uniqueTitleB);
      expect(foundClinicB).toBe(false);

      // Search for Clinic B
      const { data: resultsB } = await supabase.rpc("match_chunks", {
        p_clinic_id: clinicBId,
        p_query_embedding: queryVec,
        p_match_count: 4,
      });
      const foundInB = resultsB?.some((r: any) => r.document_title === uniqueTitleB);
      expect(foundInB).toBe(true);
    });

    it("Clinic A receives full requested result count even when Clinic B has many nearer chunks", async () => {
      const supabase = getAdminClient();
      const queryVec = makeDeterministicVector(100);

      // Ingest 6 chunks for Clinic B that are identical to query (nearest possible)
      const docB = await ingestDocument({
        clinicId: clinicBId,
        title: `__test__flood_b_${Date.now()}`,
        markdown: `
# B 1
Text 1.
# B 2
Text 2.
# B 3
Text 3.
# B 4
Text 4.
# B 5
Text 5.
# B 6
Text 6.
`,
        embedFn: async (texts) => texts.map(() => queryVec),
      });
      createdDocumentIds.add(docB.documentId);

      // Ingest 3 chunks for Clinic A with vectors close to query
      const docA = await ingestDocument({
        clinicId: clinicAId,
        title: `__test__target_a_${Date.now()}`,
        markdown: `
# A 1
Clinic A slot 1.
# A 2
Clinic A slot 2.
# A 3
Clinic A slot 3.
`,
        embedFn: async (texts) => texts.map(() => queryVec), // exact same query vector so similarity is 1.0
      });
      createdDocumentIds.add(docA.documentId);

      // Query Clinic A asking for 3 matches
      const { data: resultsA, error } = await supabase.rpc("match_chunks", {
        p_clinic_id: clinicAId,
        p_query_embedding: queryVec,
        p_match_count: 3,
      });

      expect(error).toBeNull();
      // Must return all 3 chunks for Clinic A despite Clinic B having 6 closer chunks
      expect(resultsA).toHaveLength(3);
      for (const row of resultsA!) {
        expect(row.document_title).toContain("__test__target_a_");
      }
    });

    it("orders results by similarity descending and respects limit", async () => {
      const supabase = getAdminClient();
      const queryVec = makeDeterministicVector(500);

      // Ingest 3 chunks for Clinic A with known ascending distances
      const doc = await ingestDocument({
        clinicId: clinicAId,
        title: `__test__ordering_${Date.now()}`,
        markdown: `
# Doc 1
High similarity.
# Doc 2
Medium similarity.
# Doc 3
Low similarity.
`,
        embedFn: async () => [
          queryVec, // sim ~ 1.0
          makeDeterministicVector(501),
          makeDeterministicVector(600),
        ],
      });
      createdDocumentIds.add(doc.documentId);

      const { data: results } = await supabase.rpc("match_chunks", {
        p_clinic_id: clinicAId,
        p_query_embedding: queryVec,
        p_match_count: 2,
      });

      expect(results).toHaveLength(2);
      expect(results![0].similarity).toBeGreaterThanOrEqual(results![1].similarity);
    });

    it("rejects execution when called with the anon client", async () => {
      const anonClient = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
      );

      const queryVec = makeDeterministicVector(1);
      const { data, error } = await anonClient.rpc("match_chunks", {
        p_clinic_id: clinicAId,
        p_query_embedding: queryVec,
        p_match_count: 4,
      });

      expect(error).toBeDefined();
      // Permission denied error code 42501
      expect(error?.code).toBe("42501");
      expect(data).toBeNull();
    });
  });

  // =========================================================================
  // 5. Optional Live Smoke Test
  // =========================================================================
  describe("Live Google Embedding Model Smoke Test", () => {
    it.skipIf(!process.env.RUN_LIVE_EMBEDDING)(
      "generates live 1536-dim embedding with gemini-embedding-2",
      async () => {
        const [vec] = await embedTexts(["Demo Clinic A timings"], "query");
        expect(vec).toHaveLength(1536);
        expect(vectorNorm(vec)).toBeCloseTo(1.0, 3);
      },
      45_000
    );
  });
});
