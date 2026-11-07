/**
 * Shared types and result contract for ClinicDesk agent tools.
 * Tools never throw for expected failures and never expose raw database errors.
 */

export type ToolErrorCode =
  | "INVALID_INPUT"
  | "CLINIC_NOT_FOUND"
  | "DOCTOR_NOT_FOUND"
  | "DATE_TOO_FAR"
  | "INTERNAL_ERROR"
  | "INVALID_PHONE"
  | "INVALID_SLOT"
  | "SLOT_TAKEN"
  | "TOO_MANY_BOOKINGS"
  | "APPOINTMENT_NOT_FOUND"
  | "ALREADY_CANCELLED"
  | "APPOINTMENT_NOT_CANCELLABLE"
  | "CONVERSATION_NOT_FOUND";

export type ToolResult<T, E = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: ToolErrorCode; message: string; data?: E };
