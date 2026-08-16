import { z } from 'zod'

export const messageTypeSchema = z.enum(['text', 'image', 'video', 'audio', 'document'])

export const templateInputSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  message_type: messageTypeSchema,
  body_text: z
    .string()
    .trim()
    .max(4096)
    .optional()
    .transform((v) => (v ? v : null)),
  remove_media: z.string().optional()
})

export type TemplateInput = z.infer<typeof templateInputSchema>
