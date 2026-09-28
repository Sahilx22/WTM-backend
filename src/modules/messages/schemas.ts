import { z } from 'zod'

export const messageTypeSchema = z.enum(['text', 'image', 'video', 'audio', 'document'])

const idArray = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .transform((v) => {
    const arr = Array.isArray(v) ? v : v ? [v] : []
    return arr.map((s) => Number(s)).filter((n) => Number.isInteger(n) && n > 0)
  })

export const sendMessageSchema = z.object({
  recipient_type: z.enum(['user', 'group']),
  contact_ids: idArray,
  raw_numbers: z
    .string()
    .optional()
    .transform((v) => v ?? ''),
  group_ids: idArray,
  message_type: messageTypeSchema,
  message_text: z
    .string()
    .trim()
    .max(4096)
    .optional()
    .transform((v) => (v ? v : null)),
  template_id: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : null))
})

export type SendMessageInput = z.infer<typeof sendMessageSchema>

export const scheduleMessageSchema = sendMessageSchema
  .extend({
    // Required for a one-off schedule; a recurring one only needs
    // scheduled_time (see the .refine below) — the date field is disabled
    // in that case, so it may arrive blank.
    scheduled_date: z.string().optional().default(''),
    scheduled_time: z.string().min(1, 'Pick a time'),
    // Which linked WhatsApp sends this — omitted/blank means "use the
    // primary" (or the only one connected).
    whatsapp_session_id: z
      .string()
      .optional()
      .transform((v) => (v ? Number(v) : null)),
    // Recurring: send daily at scheduled_time's time-of-day instead of
    // once. recurring_end_date is optional — blank means "repeat until
    // turned off".
    is_recurring: z
      .string()
      .optional()
      .transform((v) => v === 'true' || v === '1'),
    recurring_end_date: z
      .string()
      .optional()
      .transform((v) => (v ? v : null))
  })
  .refine((data) => data.is_recurring || data.scheduled_date.length > 0, { message: 'Pick a date', path: ['scheduled_date'] })

export type ScheduleMessageInput = z.infer<typeof scheduleMessageSchema>
