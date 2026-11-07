import { MEDICAL_EMERGENCY_PHRASES, SELF_HARM_PHRASES } from "./emergency-phrases";

export type EmergencyKind = "medical" | "self_harm" | null;

/**
 * Normalises a message string before emergency phrase matching.
 * - Unicode NFKC normalisation (collapses compatibility variants)
 * - Lowercase
 * - Remove zero-width characters (U+200B, U+200C, U+200D, U+FEFF, U+00AD)
 * - Strip punctuation (preserve Devanagari and Latin letters/digits/spaces)
 * - Collapse multiple whitespace into single space and trim
 */
export function normaliseMessage(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    // Remove zero-width and soft-hyphen characters
    .replace(/[\u200B\u200C\u200D\uFEFF\u00AD]/g, "")
    // Strip punctuation – keep Devanagari (U+0900-U+097F), Latin letters, digits, spaces
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Checks whether a user message contains an emergency phrase.
 * Returns the kind of emergency detected, or null if none.
 *
 * Both the message and each phrase are normalised before comparison so that
 * punctuation variants and Unicode composition differences don't block a match.
 *
 * Policy: false positives are acceptable; false negatives are not.
 */
export function detectEmergency(message: string): EmergencyKind {
  const normalised = normaliseMessage(message);

  for (const phrase of SELF_HARM_PHRASES) {
    if (normalised.includes(normaliseMessage(phrase))) {
      return "self_harm";
    }
  }

  for (const phrase of MEDICAL_EMERGENCY_PHRASES) {
    if (normalised.includes(normaliseMessage(phrase))) {
      return "medical";
    }
  }

  return null;
}

/**
 * Builds the fixed emergency reply for a medical emergency.
 * Does NOT call the LLM.
 */
export function buildMedicalEmergencyReply(handoffPhone?: string | null): string {
  const parts = [
    "This sounds like a medical emergency.",
    "Please call 112 immediately or go to your nearest hospital right away.",
  ];
  if (handoffPhone) {
    parts.push(`You can also reach our clinic at ${handoffPhone}.`);
  }
  return parts.join(" ");
}

/**
 * Builds the fixed reply for self-harm or suicidal messages.
 * References Tele-MANAS (official Government of India mental health helpline,
 * Ministry of Health & Family Welfare / NIMHANS): 14416 / 1800-891-4416
 * Source: https://mohfw.gov.in and https://pib.gov.in
 * Does NOT call the LLM.
 */
export function buildSelfHarmReply(handoffPhone?: string | null): string {
  const parts = [
    "I hear you, and I want you to know that help is available right now.",
    "Please call 112 or the free national mental health helpline Tele-MANAS on 14416 (also 1800-891-4416, available 24/7).",
  ];
  if (handoffPhone) {
    parts.push(`You can also reach our clinic team at ${handoffPhone}.`);
  }
  return parts.join(" ");
}

