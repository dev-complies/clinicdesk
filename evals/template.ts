/**
 * evals/template.ts
 *
 * Pure template expansion engine for scenario prompts and assertions.
 * Resolves dynamic dates ({{next_monday}}, {{next_tuesday}}), patient phone,
 * doctor IDs, and foreign appointment IDs.
 */

import { DateTime } from "luxon";

export interface TemplateContext {
  patientPhone: string;
  doctorAId?: string;
  clinicBAppointmentId?: string;
  now?: DateTime;
  timezone?: string;
}

/**
 * Calculates next occurrence of a target weekday (1 = Monday, 2 = Tuesday, etc.).
 * Guarantees a strictly future date (at least tomorrow).
 */
export function getNextWeekdayDate(
  targetWeekday: number,
  now?: DateTime,
  timezone = "Asia/Kolkata"
): string {
  const dt = (now ?? DateTime.now()).setZone(timezone);
  let daysUntil = (targetWeekday - dt.weekday + 7) % 7;
  if (daysUntil === 0) {
    daysUntil = 7; // Always strictly NEXT occurrence
  }
  return dt.plus({ days: daysUntil }).toFormat("yyyy-MM-dd");
}

/**
 * Expands all known template placeholders in a string.
 */
export function expandTemplate(text: string, context: TemplateContext): string {
  if (!text) return "";

  const tz = context.timezone || "Asia/Kolkata";
  const nextMonday = getNextWeekdayDate(1, context.now, tz);
  const nextTuesday = getNextWeekdayDate(2, context.now, tz);

  let result = text;
  result = result.replace(/\{\{next_monday\}\}/g, nextMonday);
  result = result.replace(/\{\{next_tuesday\}\}/g, nextTuesday);
  result = result.replace(/\{\{patient_phone\}\}/g, context.patientPhone);

  if (context.doctorAId) {
    result = result.replace(/\{\{doctor_a_id\}\}/g, context.doctorAId);
  }

  if (context.clinicBAppointmentId) {
    result = result.replace(
      /\{\{clinic_b_appointment_id\}\}/g,
      context.clinicBAppointmentId
    );
  }

  return result;
}

/**
 * Masks phone numbers to reveal only the last 2 digits (e.g. +919999900001 -> ...01).
 * Never logs or prints full phone numbers in reports or terminal output.
 */
export function maskPhone(phone: string): string {
  if (!phone || typeof phone !== "string") return "...";
  const trimmed = phone.trim();
  if (trimmed.length < 2) return "...";
  return `...${trimmed.slice(-2)}`;
}
