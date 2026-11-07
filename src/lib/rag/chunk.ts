/**
 * src/lib/rag/chunk.ts
 *
 * Pure function chunker for Markdown documents:
 * - Splits markdown by headings (H1, H2, H3), paragraphs, and sentences.
 * - Targets ~CHUNK_WORD_TARGET (~200 words) with ~CHUNK_OVERLAP_WORDS (~40 words) overlap.
 * - Named constants exported so evaluations can compare chunk sizes.
 * - Atomic units: table rows (with header row repeated) and markdown list items.
 * - Sentence boundary preservation: avoids splitting after abbreviations:
 *   "Dr.", "Rs.", "Mr.", "Mrs.", "a.m.", "p.m.".
 * - Preserves Hindi (Devanagari) characters and punctuation (purna viram "।", deergh viram "॥").
 * - Prefixes each chunk with document title and heading hierarchy path so it stands alone semantically.
 */

export const CHUNK_WORD_TARGET = 200;
export const CHUNK_OVERLAP_WORDS = 40;

export interface ChunkResult {
  content: string;
  heading: string | null;
  page: number | null;
}

/**
 * Counts words by splitting on Unicode whitespace.
 */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Splits a paragraph into sentences without breaking on common abbreviations:
 * Dr., Rs., Mr., Mrs., a.m., p.m.
 * Also preserves Hindi purna viram (।) and deergh viram (॥).
 */
export function splitIntoSentences(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Placeholder token replacement for protected abbreviations
  const PROTECTIONS: Array<{ regex: RegExp; placeholder: string; restore: string }> = [
    { regex: /\bDr\./gi, placeholder: "___DR_ABBR___", restore: "Dr." },
    { regex: /\bRs\./gi, placeholder: "___RS_ABBR___", restore: "Rs." },
    { regex: /\bMr\./gi, placeholder: "___MR_ABBR___", restore: "Mr." },
    { regex: /\bMrs\./gi, placeholder: "___MRS_ABBR___", restore: "Mrs." },
    { regex: /\ba\.m\./gi, placeholder: "___AM_ABBR___", restore: "a.m." },
    { regex: /\bp\.m\./gi, placeholder: "___PM_ABBR___", restore: "p.m." },
  ];

  let protectedText = trimmed;
  for (const { regex, placeholder } of PROTECTIONS) {
    protectedText = protectedText.replace(regex, placeholder);
  }

  // Split on sentence terminals: . ! ? । ॥ followed by space or newline
  const rawSegments = protectedText.split(/(?<=[.!?।॥])\s+/);

  const sentences: string[] = [];
  for (const raw of rawSegments) {
    let restored = raw;
    for (const { placeholder, restore } of PROTECTIONS) {
      restored = restored.replaceAll(placeholder, restore);
    }
    const sTrimmed = restored.trim();
    if (sTrimmed) {
      sentences.push(sTrimmed);
    }
  }

  return sentences.length > 0 ? sentences : [trimmed];
}

interface Section {
  headingPath: string | null;
  lines: string[];
}

/**
 * Parses markdown lines into sections delimited by H1/H2/H3 headers.
 */
function parseSections(markdown: string): Section[] {
  const lines = markdown.split(/\r?\n/);
  const sections: Section[] = [];

  let currentHeadingLevels: string[] = [];
  let currentLines: string[] = [];

  const flush = () => {
    if (currentLines.some((l) => l.trim().length > 0)) {
      sections.push({
        headingPath: currentHeadingLevels.length > 0 ? currentHeadingLevels.join(" > ") : null,
        lines: [...currentLines],
      });
    }
    currentLines = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flush();
      const level = headingMatch[1].length;
      const headingText = headingMatch[2].trim();

      // Adjust heading hierarchy
      currentHeadingLevels = currentHeadingLevels.slice(0, level - 1);
      currentHeadingLevels[level - 1] = headingText;
    } else {
      currentLines.push(line);
    }
  }
  flush();

  return sections;
}

/**
 * Extracts atomic units from section lines:
 * - Markdown tables (header + separator row kept with each row, or whole table as unit)
 * - List items (lines starting with - or * or digit.)
 * - Standard paragraphs broken into sentences
 */
function extractAtomicUnits(lines: string[]): string[] {
  const units: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // 1. Markdown Table detection
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|") && lines[i].trim().endsWith("|")) {
        tableLines.push(lines[i].trim());
        i++;
      }

      if (tableLines.length >= 2) {
        const header = tableLines[0];
        const separator = tableLines[1];
        // Rows after separator
        const dataRows = tableLines.slice(2);
        if (dataRows.length === 0) {
          units.push(tableLines.join("\n"));
        } else {
          // Each data row is an atomic unit carrying its table header
          for (const row of dataRows) {
            units.push(`${header}\n${separator}\n${row}`);
          }
        }
      } else {
        units.push(tableLines.join("\n"));
      }
      continue;
    }

    // 2. Markdown List item detection
    if (/^([-*+]|\d+\.)\s+/.test(trimmed)) {
      const listLines: string[] = [line];
      i++;
      // Consume continuation lines of the same list item (indented lines)
      while (i < lines.length && /^\s{2,}/.test(lines[i]) && lines[i].trim().length > 0) {
        listLines.push(lines[i]);
        i++;
      }
      units.push(listLines.join("\n").trim());
      continue;
    }

    // 3. Normal paragraph
    const paragraphLines: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim().length > 0 &&
      !lines[i].trim().startsWith("|") &&
      !/^([-*+]|\d+\.)\s+/.test(lines[i].trim())
    ) {
      paragraphLines.push(lines[i]);
      i++;
    }

    const paragraphText = paragraphLines.join(" ").trim();
    const sentences = splitIntoSentences(paragraphText);
    for (const s of sentences) {
      units.push(s);
    }
  }

  return units;
}

/**
 * Chunks a markdown document into units of ~CHUNK_WORD_TARGET words with
 * ~CHUNK_OVERLAP_WORDS overlap, prefixed with document title and heading path.
 */
export function chunkMarkdown(title: string, markdown: string): ChunkResult[] {
  const trimmed = markdown.trim();
  if (!trimmed) return [];

  const cleanTitle = title.trim();
  const sections = parseSections(trimmed);
  const chunks: ChunkResult[] = [];

  for (const sec of sections) {
    const units = extractAtomicUnits(sec.lines);
    if (units.length === 0) continue;

    let currentUnits: string[] = [];
    let currentWordCount = 0;

    const commitChunk = (unitsToCommit: string[]): ChunkResult | null => {
      const body = unitsToCommit.join("\n\n").trim();
      if (!body) return null;

      const prefixParts = [`[Document: ${cleanTitle}]`];
      if (sec.headingPath) {
        prefixParts.push(`[Section: ${sec.headingPath}]`);
      }
      const fullContent = `${prefixParts.join("\n")}\n\n${body}`;

      return {
        content: fullContent,
        heading: sec.headingPath,
        page: null,
      };
    };

    let idx = 0;
    while (idx < units.length) {
      const unit = units[idx];
      const unitWords = countWords(unit);

      // If adding this unit exceeds target and we already have units, commit current chunk
      if (currentWordCount + unitWords > CHUNK_WORD_TARGET && currentUnits.length > 0) {
        const chunk = commitChunk(currentUnits);
        if (chunk) chunks.push(chunk);

        // Calculate overlap units from the tail of currentUnits (~CHUNK_OVERLAP_WORDS)
        const overlapUnits: string[] = [];
        let overlapWords = 0;
        for (let j = currentUnits.length - 1; j >= 0; j--) {
          const w = countWords(currentUnits[j]);
          if (overlapWords + w <= CHUNK_OVERLAP_WORDS || overlapUnits.length === 0) {
            overlapUnits.unshift(currentUnits[j]);
            overlapWords += w;
          } else {
            break;
          }
        }

        currentUnits = [...overlapUnits];
        currentWordCount = overlapWords;
      }

      currentUnits.push(unit);
      currentWordCount += unitWords;
      idx++;
    }

    if (currentUnits.length > 0) {
      const chunk = commitChunk(currentUnits);
      if (chunk) chunks.push(chunk);
    }
  }

  return chunks;
}

