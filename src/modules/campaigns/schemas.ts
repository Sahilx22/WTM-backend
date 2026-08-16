import { z } from 'zod'
import { messageTypeSchema } from '../messages/schemas.js'

export const campaignInputSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(150),
  batch_id: z.string().min(1, 'Choose a batch').transform((v) => Number(v)),
  template_id: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : null)),
  message_type: messageTypeSchema,
  message_text: z
    .string()
    .trim()
    .max(4096)
    .optional()
    .transform((v) => (v ? v : null)),
  scheduled_date: z
    .string()
    .optional()
    .transform((v) => (v ? v : null)),
  scheduled_time: z
    .string()
    .optional()
    .transform((v) => (v ? v : null)),
  min_delay_ms: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : null)),
  max_delay_ms: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : null))
})

export type CampaignInput = z.infer<typeof campaignInputSchema>
