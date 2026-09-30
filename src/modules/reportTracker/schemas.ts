import { z } from 'zod'

export const reportDefinitionSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(200),
    description: z.string().trim().max(2000).optional().default(''),
    contact_id: z
      .string()
      .optional()
      .transform((v) => (v ? Number(v) : null)),
    phone_number: z.string().optional().default(''),
    schedule_type: z.enum(['weekly', 'interval']),
    day_of_week: z
      .string()
      .optional()
      .transform((v) => (v ? Number(v) : null)),
    interval_days: z
      .string()
      .optional()
      .transform((v) => (v ? Number(v) : null)),
    due_time: z.string().min(1, 'Pick a due time'),
    whatsapp_session_id: z
      .string()
      .optional()
      .transform((v) => (v ? Number(v) : null))
  })
  .refine((data) => data.contact_id !== null || data.phone_number.trim().length > 0, {
    message: 'Choose a contact or enter a phone number.',
    path: ['contact_id']
  })
  .refine((data) => data.schedule_type !== 'weekly' || (data.day_of_week !== null && data.day_of_week >= 0 && data.day_of_week <= 6), {
    message: 'Choose a day of the week.',
    path: ['day_of_week']
  })
  .refine((data) => data.schedule_type !== 'interval' || (data.interval_days !== null && data.interval_days >= 1), {
    message: 'Enter how many days between reports (1 or more).',
    path: ['interval_days']
  })

export type ReportDefinitionInput = z.infer<typeof reportDefinitionSchema>
