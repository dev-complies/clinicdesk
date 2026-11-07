/**
 * Shared types and result contract for ClinicDesk agent tools.
 * Tools never throw for expected failures and never expose raw database errors.
 */

export type ToolErrorCode =
  | "INVALID_INPUT"
  | "CLINIC_NOT_FOUND"
  | "DOCTOR_NOT_FOUND"
  | "DATE_TOO_FAR"
  | "INTERNAL_ERROR";

export type ToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ToolErrorCode; message: string };

