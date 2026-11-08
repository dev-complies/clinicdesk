import { tool } from "ai";
import { bookAppointment, bookAppointmentInputSchema } from "../tools/book-appointment";
import { cancelAppointment, cancelAppointmentInputSchema } from "../tools/cancel-appointment";
import { checkAvailability, checkAvailabilityInputSchema } from "../tools/check-availability";
import { findMyAppointments, findMyAppointmentsInputSchema } from "../tools/find-my-appointments";
import { handoffToHuman, handoffToHumanInputSchema } from "../tools/handoff-to-human";
import { listDoctors, listDoctorsInputSchema } from "../tools/list-doctors";
import { rescheduleAppointment, rescheduleAppointmentInputSchema } from "../tools/reschedule-appointment";
import {
  searchClinicInfo,
  searchClinicInfoInputSchema,
  SearchClinicInfoRetrievalMeta,
} from "../tools/search-clinic-info";
import { ToolResult } from "../tools/types";

export interface ChatToolsOptions {
  onRetrieval?: (meta: SearchClinicInfoRetrievalMeta) => void;
}

/**
 * Creates the model-facing tool registry for a chat turn.
 * Server clinicId and conversationId are closed over in execute functions
 * and never exposed in the schemas to the model or client.
 *
 * Every tool execute function catches unexpected errors and returns
 * structured ToolResult error objects without throwing.
 */
export function createChatTools(
  clinicId: string,
  conversationId: string,
  options?: ChatToolsOptions
) {
  return {
    search_clinic_info: tool({
      description:
        "Search clinic documents for information on timings, fees for services/tests, policies, location, parking, facilities, and general clinic rules. " +
        "The query must never contain names, phone numbers, or other personal details. " +
        "Write the query as a short plain-English search phrase (keep the meaning, drop filler words) even if the patient wrote in Hindi or Hinglish; the final answer is still written in the patient's language.",
      inputSchema: searchClinicInfoInputSchema,
      execute: async (input): Promise<ToolResult<any>> => {
        try {
          const res = await searchClinicInfo(clinicId, input);
          if (res.retrievalMeta && options?.onRetrieval) {
            options.onRetrieval(res.retrievalMeta);
          }
          if (res.ok) {
            return {
              ok: true,
              data: res.data,
            };
          }
          return {
            ok: false,
            error: res.error,
            message: res.message,
          };
        } catch (err: any) {
          return {
            ok: false,
            error: "INTERNAL_ERROR",
            message: "Failed to search clinic information. Please try again or ask clinic staff.",
          };
        }
      },
    }),
    list_doctors: tool({
      description:
        "List active doctors at the clinic, optionally filtered by medical speciality. " +
        "Returns doctor IDs, names, specialities, and consultation fees. " +
        "Always use the exact doctor ID returned by this tool when checking availability or booking.",
      inputSchema: listDoctorsInputSchema,
      execute: async (input): Promise<ToolResult<any>> => {
        try {
          return await listDoctors(clinicId, input);
        } catch (err: any) {
          return {
            ok: false,
            error: "INTERNAL_ERROR",
            message: err?.message || "Failed to list doctors",
          };
        }
      },
    }),

    check_availability: tool({
      description:
        "Check available appointment slots for a doctor on a specific date (YYYY-MM-DD). " +
        "Requires the exact doctor_id from list_doctors. " +
        "Returns available slot start_at timestamps. Always use the exact ISO start_at string from these results when booking.",
      inputSchema: checkAvailabilityInputSchema,
      execute: async (input): Promise<ToolResult<any>> => {
        try {
          return await checkAvailability(clinicId, input);
        } catch (err: any) {
          return {
            ok: false,
            error: "INTERNAL_ERROR",
            message: err?.message || "Failed to check availability",
          };
        }
      },
    }),

    book_appointment: tool({
      description:
        "Book an appointment for a patient with a doctor at a given slot start time. " +
        "Requires exact doctor_id from list_doctors, exact start_at from check_availability, patient_name, and patient_phone. " +
        "Always ask the patient for any missing name or phone number instead of guessing.",
      inputSchema: bookAppointmentInputSchema,
      execute: async (input): Promise<ToolResult<any>> => {
        try {
          return await bookAppointment(clinicId, input);
        } catch (err: any) {
          return {
            ok: false,
            error: "INTERNAL_ERROR",
            message: err?.message || "Failed to book appointment",
          };
        }
      },
    }),

    find_my_appointments: tool({
      description:
        "Find active upcoming appointments for a patient using their phone number. " +
        "Always ask the patient for their phone number instead of guessing.",
      inputSchema: findMyAppointmentsInputSchema,
      execute: async (input): Promise<ToolResult<any>> => {
        try {
          return await findMyAppointments(clinicId, input);
        } catch (err: any) {
          return {
            ok: false,
            error: "INTERNAL_ERROR",
            message: err?.message || "Failed to retrieve appointments",
          };
        }
      },
    }),

    cancel_appointment: tool({
      description:
        "Cancel an upcoming appointment using the appointment ID and patient phone number. " +
        "Always ask the patient for the phone number used at booking instead of guessing.",
      inputSchema: cancelAppointmentInputSchema,
      execute: async (input): Promise<ToolResult<any>> => {
        try {
          return await cancelAppointment(clinicId, input);
        } catch (err: any) {
          return {
            ok: false,
            error: "INTERNAL_ERROR",
            message: err?.message || "Failed to cancel appointment",
          };
        }
      },
    }),

    reschedule_appointment: tool({
      description:
        "Reschedule an existing appointment to a new slot using the appointment ID, patient phone number, and new_start_at from check_availability. " +
        "Always ask the patient for the phone number used at booking instead of guessing.",
      inputSchema: rescheduleAppointmentInputSchema,
      execute: async (input): Promise<ToolResult<any>> => {
        try {
          return await rescheduleAppointment(clinicId, input);
        } catch (err: any) {
          return {
            ok: false,
            error: "INTERNAL_ERROR",
            message: err?.message || "Failed to reschedule appointment",
          };
        }
      },
    }),

    handoff_to_human: tool({
      description:
        "Hand off the conversation to human clinic staff when the patient requests human assistance or the issue cannot be resolved by the assistant.",
      inputSchema: handoffToHumanInputSchema,
      execute: async (input): Promise<ToolResult<any>> => {
        try {
          return await handoffToHuman(clinicId, conversationId, input);
        } catch (err: any) {
          return {
            ok: false,
            error: "INTERNAL_ERROR",
            message: err?.message || "Failed to hand off conversation",
          };
        }
      },
    }),
  };
}

