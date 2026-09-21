import { z } from 'zod'

export const createEmployeeSchema = z.object({
  username: z.string().trim().min(3).max(64),
  password: z.string().min(6).max(200),
  display_name: z.string().trim().min(1).max(120)
})

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>

export const createGrantSchema = z
  .object({
    user_id: z.coerce.number().int().positive(),
    contact_id: z.coerce.number().int().positive().optional(),
    phone_number: z.string().trim().min(1).max(32).optional()
  })
  .refine((v) => Boolean(v.contact_id) !== Boolean(v.phone_number), {
    message: 'Choose an existing contact or enter a phone number, not both.'
  })

export type CreateGrantInput = z.infer<typeof createGrantSchema>
