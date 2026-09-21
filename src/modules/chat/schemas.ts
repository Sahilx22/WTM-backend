import { z } from 'zod'
import { messageTypeSchema } from '../messages/schemas.js'

export const chatSendMessageSchema = z.object({
  message_type: messageTypeSchema,
  message_text: z
    .string()
    .trim()
    .max(4096)
    .optional()
    .transform((v) => (v ? v : null))
})

export type ChatSendMessageInput = z.infer<typeof chatSendMessageSchema>
