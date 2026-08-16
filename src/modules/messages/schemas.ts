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

export const scheduleMessageSchema = sendMessageSchema.extend({
  scheduled_date: z.string().min(1, 'Pick a date'),
  scheduled_time: z.string().min(1, 'Pick a time')
})

export type ScheduleMessageInput = z.infer<typeof scheduleMessageSchema>
