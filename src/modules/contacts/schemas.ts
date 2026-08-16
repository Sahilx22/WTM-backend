import { z } from 'zod'

export const contactInputSchema = z.object({
  phone_number: z.string().min(1, 'Phone number is required'),
  display_name: z
    .string()
    .trim()
    .max(120)
    .optional()
    .transform((v) => (v ? v : null)),
  notes: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((v) => (v ? v : null))
})

export type ContactInput = z.infer<typeof contactInputSchema>
